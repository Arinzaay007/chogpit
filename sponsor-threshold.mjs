// Owner-authorized, sponsor-paid publisher/redemption runner for the NEW
// threshold vault. This is an unreviewed candidate, NOT a deployed service.
// No owner/player key is stored or used here. An owner signs the exact sealed
// root offline; the separately funded operator pays the oracle and all gas.
import { getAddress, parseAbi, recoverTypedDataAddress } from 'viem';

const VAULT = parseAbi([
  'function chog() view returns (address)',
  'function owner() view returns (address)',
  'function batchOperator() view returns (address)',
  'function newBatchesPaused() view returns (bool)',
  'function nextBatchId() view returns (uint256)',
  'function currentEpochId() view returns (uint256)',
  'function currentEntropyFee() view returns (uint256)',
  'function epochs(uint256) view returns (uint256 budget,uint256 awarded,uint256 reserved,uint256 pendingCapacity,uint32 purchasedSlots,bool closed)',
  'function capacityPermitNonce() view returns (uint256)',
  'function totalPendingCapacity() view returns (uint256)',
  'function batches(uint256) view returns (uint256 epochId, bytes32 root, bytes32 seed, uint64 sequence, uint32 entries, uint32 redeemedCount, bool seeded)',
  'function redeemed(uint256,uint256) view returns (bool)',
  'function usedGameEvent(bytes32) view returns (bool)',
  'function creditOf(address) view returns (uint256)',
  'function settlementNonces(address) view returns (uint256)',
  'function purchaseCapacity(uint256 epochId,uint32 slots,uint256 deadline,bytes ownerSignature)',
  'function commitBatch(uint256 epochId,bytes32 root,uint32 entries,bytes32 userRandomNumber,uint256 deadline,bytes ownerSignature) payable returns (uint256)',
  'function redeem(uint256 batchId,uint256 index,address recipient,bytes32 eventId,bytes32[] proof) returns (uint256)',
  'function settleFinalCredit(address recipient,uint256 deadline,bytes ownerSignature) returns (uint256)',
  'event BoxCredited(uint256 indexed epochId,uint256 indexed batchId,uint256 index,bytes32 eventId,address indexed recipient,uint256 amount,uint256 runningCredit)',
  'event AutoPaid(address indexed recipient,uint256 amount,address indexed gasSponsor)',
  'event FinalSettled(address indexed recipient,uint256 amount,address indexed gasSponsor)'
]);
const TOKEN = parseAbi(['function balanceOf(address) view returns (uint256)']);
const TYPES = { BatchPermit: [
  { name: 'epochId', type: 'uint256' }, { name: 'batchId', type: 'uint256' },
  { name: 'root', type: 'bytes32' }, { name: 'entries', type: 'uint32' },
  { name: 'userRandomNumber', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }
] };
const HEX32 = /^0x[a-fA-F0-9]{64}$/;
const SIGNATURE = /^0x[a-fA-F0-9]{130}$/;
const norm = value => getAddress(value).toLowerCase();
export const batchPermitTypedData = ({ chainId, vault, epochId, batchId,
  root, entries, userRandomNumber, deadline }) => ({
  domain: { name: 'CHOGPIT Threshold', version: '2', chainId,
    verifyingContract: getAddress(vault) },
  types: TYPES, primaryType: 'BatchPermit',
  message: { epochId: BigInt(epochId), batchId: BigInt(batchId), root,
    entries, userRandomNumber, deadline: BigInt(deadline) }
});
export const capacityPermitTypedData = ({ chainId, vault, epochId, slots,
  nonce, deadline }) => ({
  domain: { name: 'CHOGPIT Threshold', version: '2', chainId,
    verifyingContract: getAddress(vault) },
  types: { CapacityPermit: [
    { name: 'epochId', type: 'uint256' }, { name: 'slots', type: 'uint32' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] }, primaryType: 'CapacityPermit', message: {
    epochId:BigInt(epochId),slots,nonce:BigInt(nonce),deadline:BigInt(deadline) }
});
export const finalSettlementTypedData = ({ chainId, vault, recipient, amount,
  nonce, deadline }) => ({
  domain: { name: 'CHOGPIT Threshold', version: '2', chainId,
    verifyingContract: getAddress(vault) },
  types: { FinalSettlement: [
    { name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] }, primaryType: 'FinalSettlement', message: { recipient:getAddress(recipient),
    amount:BigInt(amount),nonce:BigInt(nonce),deadline:BigInt(deadline) }
});

export class ThresholdSponsorRunner {
  constructor({ intake, publicClient, sponsorClient, maxEntropyFeeWei,
    maxGasPriceWei, maxNativePerTransactionWei, confirmations = 1 } = {}) {
    if (!intake?.db || !publicClient?.readContract || !sponsorClient?.account?.address
      || !sponsorClient.writeContract || !Number.isSafeInteger(confirmations)
      || confirmations < 1 || confirmations > 32)
      throw new Error('A journal, RPC client and distinct sponsored signer are required.');
    for (const cap of [maxEntropyFeeWei,maxGasPriceWei,maxNativePerTransactionWei])
      if (typeof cap !== 'bigint' || cap <= 0n) throw new Error('Every sponsor spend cap must be explicit.');
    this.intake = intake; this.rpc = publicClient; this.signer = sponsorClient;
    this.maxEntropyFeeWei = maxEntropyFeeWei; this.maxGasPriceWei = maxGasPriceWei;
    this.maxNativePerTransactionWei = maxNativePerTransactionWei;
    this.confirmations = confirmations; this.busy = false;
  }
  async #vault(fn,args=[]) {
    return this.rpc.readContract({address:this.intake.vault,abi:VAULT,functionName:fn,args});
  }
  async #assertDomain() {
    this.intake.audit();
    if (await this.rpc.getChainId() !== 143) throw new Error('Expected Monad chain 143.');
    const code = await this.rpc.getBytecode({address:this.intake.vault});
    if (!code || code === '0x') throw new Error('Threshold vault bytecode is not deployed.');
    if (norm(await this.#vault('chog')) !== norm(this.intake.token))
      throw new Error('Vault token differs from the journal.');
    if (norm(await this.#vault('batchOperator')) !== norm(this.signer.account.address))
      throw new Error('The sponsored signer is not the vault batch operator.');
  }
  #entries(batch) {
    const rows = this.intake.db.prepare('SELECT * FROM openings WHERE batch_id=? ORDER BY position').all(batch.batchId);
    if (rows.length !== batch.entries.length ||
      rows.some((row,index) => row.event_id !== batch.entries[index].eventId ||
        row.recipient !== batch.entries[index].recipient || row.position !== index
        || row.opened_epoch !== batch.epochId))
      throw new Error('Journal entries changed since the signed batch export.');
    return rows;
  }
  async #onchainBatch(batch) {
    const next = await this.#vault('nextBatchId');
    if (next < BigInt(batch.batchId)) throw new Error('Batch ID skips an unpublished on-chain ID.');
    if (next === BigInt(batch.batchId)) return null;
    const fields = await this.#vault('batches',[BigInt(batch.batchId)]);
    if (BigInt(fields[0]) !== BigInt(batch.epochId) ||
      fields[1].toLowerCase() !== batch.root.toLowerCase() ||
      Number(fields[4]) !== batch.entries.length)
      throw new Error('Published batch does not match the durable signed candidate.');
    return fields;
  }
  async #send(functionName,args,value=0n) {
    const request = {address:this.intake.vault,abi:VAULT,functionName,args,
      account:this.signer.account,value};
    const gasPrice = await this.rpc.getGasPrice();
    if (gasPrice > this.maxGasPriceWei) throw new Error('Sponsor gas price cap exceeded.');
    const { request: simulated } = await this.rpc.simulateContract(request);
    const estimatedGas = await this.rpc.estimateContractGas(request);
    const gas = estimatedGas * 125n / 100n + 25_000n;
    if (gas > 800_000n || gas * gasPrice + value > this.maxNativePerTransactionWei)
      throw new Error('Sponsor transaction gas/spend cap exceeded.');
    if (await this.rpc.getBalance({address:this.signer.account.address}) < gas * gasPrice + value)
      throw new Error('Sponsor wallet has insufficient MON for oracle fee and transaction.');
    // Pin the signed transaction's gas price to the checked value; otherwise
    // a new RPC estimate at signing time could bypass this sponsor cap.
    const hash = await this.signer.writeContract({...simulated,gas,gasPrice});
    const receipt = await this.rpc.waitForTransactionReceipt({hash,confirmations:this.confirmations});
    if (receipt.status !== 'success') throw new Error('Sponsor transaction reverted on-chain.');
    return {hash,receipt};
  }
  async #exclusive(task) {
    if (this.busy) throw new Error('Another sponsor operation is in progress.');
    this.busy = true;
    try { return await task(); } finally { this.busy = false; }
  }
  async purchaseCapacity({epochId,slots,ownerPermit}={}) {
    return this.#exclusive(async () => {
      await this.#assertDomain();
      if(!Number.isSafeInteger(epochId)||epochId<0||!Number.isSafeInteger(slots)
        ||slots<1||slots>40||await this.#vault('currentEpochId')!==BigInt(epochId))
        throw new Error('Capacity can only be purchased for the current funded epoch.');
      const before=await this.#vault('epochs',[BigInt(epochId)]);
      if(before[5])throw new Error('This epoch has already closed to new openings.');
      const nonce=await this.#vault('capacityPermitNonce');
      const p=ownerPermit;
      if(!p||p.epochId!==epochId||p.slots!==slots||BigInt(p.nonce)!==nonce
        ||!Number.isSafeInteger(p.deadline)||!SIGNATURE.test(p.signature))
        throw new Error('A specific owner-signed capacity permit is required.');
      const now=BigInt(Math.floor(Date.now()/1000));
      if(BigInt(p.deadline)<now||BigInt(p.deadline)>now+7n*24n*60n*60n)
        throw new Error('Capacity authorization expired or is too long-lived.');
      const recovered=await recoverTypedDataAddress({
        ...capacityPermitTypedData({chainId:143,vault:this.intake.vault,...p}),signature:p.signature});
      if(norm(recovered)!==norm(await this.#vault('owner')))
        throw new Error('The sponsor cannot reserve funds without the vault owner signature.');
      const {hash}=await this.#send('purchaseCapacity',[
        BigInt(epochId),slots,BigInt(p.deadline),p.signature]);
      const after=await this.#vault('epochs',[BigInt(epochId)]);
      if(Number(after[4])!==Number(before[4])+slots||
        after[3]!==before[3]+BigInt(slots)*25n*10n**18n)
        throw new Error('Purchased capacity was not ring-fenced in the vault.');
      return {epochId,slots,purchasedSlots:Number(after[4]),
        pendingCapacity:after[3],hash};
    });
  }
  async publish({batchId,ownerPermit}) {
    return this.#exclusive(async () => {
      await this.#assertDomain();
      const batch = this.intake.exportUnsignedBatch(batchId);
      this.#entries(batch);
      const already = await this.#onchainBatch(batch);
      if (already) return {batchId,root:batch.root,alreadyCommitted:true,seeded:already[6]};
      if (await this.#vault('newBatchesPaused') ||
        await this.#vault('currentEpochId') < BigInt(batch.epochId))
        throw new Error('The owner has paused or has not funded this vault epoch.');
      const epoch=await this.#vault('epochs',[BigInt(batch.epochId)]);
      if(epoch[3]<BigInt(batch.entries.length)*25n*10n**18n)
        throw new Error('This batch has no ring-fenced opening capacity in its original epoch.');
      const p = ownerPermit;
      if (!p || p.batchId !== batchId || p.epochId !== batch.epochId ||
        p.root?.toLowerCase() !== batch.root.toLowerCase() ||
        p.entries !== batch.entries.length || !HEX32.test(p.userRandomNumber) ||
        !SIGNATURE.test(p.signature) || !Number.isSafeInteger(p.deadline))
        throw new Error('An exact owner-signed, unexpired batch permit is required.');
      const owner = await this.#vault('owner');
      const typed = batchPermitTypedData({chainId:143,vault:this.intake.vault,...p});
      const recovered = await recoverTypedDataAddress({...typed,signature:p.signature});
      if (norm(recovered) !== norm(owner))
        throw new Error('The operator cannot publish a root without the vault owner signature.');
      const now = BigInt(Math.floor(Date.now()/1000));
      if (BigInt(p.deadline) < now || BigInt(p.deadline) > now + 7n*24n*60n*60n)
        throw new Error('Batch authorization expired or is too long-lived.');
      const fee = await this.#vault('currentEntropyFee');
      if (fee > this.maxEntropyFeeWei) throw new Error('On-chain oracle fee exceeds sponsor cap.');
      const {hash} = await this.#send('commitBatch',[
        BigInt(batch.epochId),batch.root,batch.entries.length,p.userRandomNumber,
        BigInt(p.deadline),p.signature],fee);
      const committed = await this.#onchainBatch(batch);
      if (!committed) throw new Error('No matching vault root after sponsor commit.');
      return {batchId,root:batch.root,hash,oracleFeeWei:fee,
        sequence:committed[3],alreadyCommitted:false,seeded:committed[6]};
    });
  }
  async redeemReadyBatch({batchId,maxTransactions=40}={}) {
    return this.#exclusive(async () => {
      if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 40)
        throw new Error('Invalid per-run redemption limit.');
      await this.#assertDomain();
      const batch = this.intake.exportUnsignedBatch(batchId);
      const rows = this.#entries(batch), chainBatch = await this.#onchainBatch(batch);
      if (!chainBatch || !chainBatch[6])
        throw new Error('The owner-signed batch is not published or the oracle seed has not arrived.');
      // Rebuild proofs from the sealed journal. Never accept an arbitrary
      // browser-submitted destination, amount, batch, proof or transaction.
      const {candidateThresholdBatch} = await import('./claim-kit-threshold.mjs');
      const proof = candidateThresholdBatch({chainId:143,vault:this.intake.vault,
        epochId:batch.epochId,batchId,entries:rows.map(row => ({
          eventId:row.event_id,recipient:row.recipient}))});
      if (proof.root.toLowerCase() !== batch.root.toLowerCase())
        throw new Error('Proof recomputation failed.');
      const results = [];
      for (let i=0;i<rows.length && results.length<maxTransactions;i++) {
        const row = rows[i];
        if (await this.#vault('redeemed',[BigInt(batchId),BigInt(i)])) continue;
        if (await this.#vault('usedGameEvent',[row.event_id]))
          throw new Error('Event ID was already spent in another batch.');
        const recipient = getAddress(row.recipient);
        const priorCredit = await this.#vault('creditOf',[recipient]);
        const priorBalance = await this.rpc.readContract({address:this.intake.token,
          abi:TOKEN,functionName:'balanceOf',args:[recipient]});
        const {hash,receipt} = await this.#send('redeem',[
          BigInt(batchId),BigInt(i),recipient,row.event_id,proof.entries[i].proof]);
        if (!await this.#vault('redeemed',[BigInt(batchId),BigInt(i)]))
          throw new Error('Redemption receipt did not mark this opening spent.');
        const {decodeEventLog} = await import('viem');
        let credited,autoPaid;
        for (const log of receipt.logs) {
          if (norm(log.address) !== norm(this.intake.vault)) continue;
          try {
            const event=decodeEventLog({abi:VAULT,topics:log.topics,data:log.data});
            if (event.eventName==='BoxCredited' && event.args.eventId===row.event_id)
              credited=event.args;
            if (event.eventName==='AutoPaid' && norm(event.args.recipient)===norm(recipient))
              autoPaid=event.args;
          } catch { /* unrelated vault event */ }
        }
        if (!credited || ![5n,10n,25n].includes(credited.amount/10n**18n))
          throw new Error('Expected 5/10/25 CHOG credit log was not found.');
        const newCredit = await this.#vault('creditOf',[recipient]);
        const balance = await this.rpc.readContract({address:this.intake.token,
          abi:TOKEN,functionName:'balanceOf',args:[recipient]});
        if (priorCredit + credited.amount >= 50n*10n**18n) {
          if (!autoPaid || autoPaid.amount !== priorCredit + credited.amount ||
            norm(autoPaid.gasSponsor)!==norm(this.signer.account.address) ||
            newCredit !== 0n || balance-priorBalance !== autoPaid.amount)
            throw new Error('Automatic payout did not match the full accumulated credit.');
        } else if (autoPaid || newCredit !== priorCredit+credited.amount ||
          balance !== priorBalance) throw new Error('Premature or inconsistent CHOG payout.');
        results.push({eventId:row.event_id,batchId,index:i,amount:credited.amount,
          paidOut:autoPaid?.amount||0n,hash});
      }
      return {batchId,transactions:results,remaining:
        rows.length-Number((await this.#onchainBatch(batch))[5])};
    });
  }
  async settleFinalCredit({recipient,ownerPermit}={}) {
    return this.#exclusive(async () => {
      await this.#assertDomain();
      const destination=getAddress(recipient),p=ownerPermit;
      if (!this.intake.db.prepare(`SELECT 1 FROM openings o JOIN accounts a
        ON a.account_id=o.account_id WHERE o.recipient=? AND a.address_locked_at IS NOT NULL
        LIMIT 1`).get(destination.toLowerCase()))
        throw new Error('Final settlement recipient has no locked, published opening.');
      if (!await this.#vault('newBatchesPaused'))
        throw new Error('The owner must pause new batches for final settlement.');
      const amount=await this.#vault('creditOf',[destination]);
      const nonce=await this.#vault('settlementNonces',[destination]);
      if (!amount || amount>=50n*10n**18n) throw new Error('No sub-50 CHOG credit exists.');
      if (!p || norm(p.recipient)!==norm(destination) || BigInt(p.amount)!==amount
        || BigInt(p.nonce)!==nonce || !Number.isSafeInteger(p.deadline)
        || !SIGNATURE.test(p.signature))
        throw new Error('An exact owner-signed final settlement permit is required.');
      const now=BigInt(Math.floor(Date.now()/1000));
      if (BigInt(p.deadline)<now || BigInt(p.deadline)>now+7n*24n*60n*60n)
        throw new Error('Final settlement permit expired or is too long-lived.');
      const recovered=await recoverTypedDataAddress({
        ...finalSettlementTypedData({chainId:143,vault:this.intake.vault,...p}),signature:p.signature});
      if (norm(recovered)!==norm(await this.#vault('owner')))
        throw new Error('Final settlement requires the vault owner signature.');
      const priorBalance=await this.rpc.readContract({address:this.intake.token,
        abi:TOKEN,functionName:'balanceOf',args:[destination]});
      const {hash,receipt}=await this.#send('settleFinalCredit',[
        destination,BigInt(p.deadline),p.signature]);
      const finalBalance=await this.rpc.readContract({address:this.intake.token,
        abi:TOKEN,functionName:'balanceOf',args:[destination]});
      if (await this.#vault('creditOf',[destination])!==0n ||
        await this.#vault('settlementNonces',[destination])!==nonce+1n ||
        finalBalance-priorBalance!==amount)
        throw new Error('Final settlement did not send the full small balance to its locked address.');
      const {decodeEventLog}=await import('viem');
      if (!receipt.logs.some(log=>{
        if(norm(log.address)!==norm(this.intake.vault)) return false;
        try {
          const event=decodeEventLog({abi:VAULT,topics:log.topics,data:log.data});
          return event.eventName==='FinalSettled' &&
            norm(event.args.recipient)===norm(destination) && event.args.amount===amount &&
            norm(event.args.gasSponsor)===norm(this.signer.account.address);
        } catch { return false; }
      })) throw new Error('Final settlement receipt lacks the expected vault event.');
      return {recipient:destination,amount,hash,gasPaidBy:this.signer.account.address};
    });
  }
}
