import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ganache from 'ganache';
import solc from 'solc';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom,
  encodeAbiParameters, keccak256, toHex } from 'viem';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { batchPermitTypedData, capacityPermitTypedData, finalSettlementTypedData,
  ThresholdSponsorRunner } from '../sponsor-threshold.mjs';

// Test-only direct SQLite account setup stands in for the REAL WebAuthn
// registration/assertion tested separately in passkey-late-binding.mjs.
const folder=mkdtempSync(path.join(os.tmpdir(),'chogpit-threshold-sponsor-'));
const provider=ganache.provider({logging:{quiet:true},chain:{chainId:143},
  wallet:{totalAccounts:4,defaultBalance:1000}});
let intake;
try {
  const source=readFileSync(new URL('../contracts/ChogRewardVaultThresholdDraft.sol',import.meta.url),'utf8');
  const mocks=readFileSync(new URL('../contracts/test/Mocks.sol',import.meta.url),'utf8');
  const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',
    sources:{'T.sol':{content:source},'Mocks.sol':{content:mocks}},
    settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',
      outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
  if(compiled.errors?.some(e=>e.severity==='error'))
    throw Error(compiled.errors.map(e=>e.formattedMessage).join('\n'));
  const artifact={...compiled.contracts['T.sol'],...compiled.contracts['Mocks.sol']};
  const addresses=await provider.request({method:'eth_accounts'});
  const ownerAddress=addresses[0],sponsorAddress=addresses[1];
  const payout=privateKeyToAccount(`0x${'39'.repeat(32)}`);
  const ownerKey=privateKeyToAccount(provider.getInitialAccounts()[ownerAddress.toLowerCase()].secretKey);
  const chain={id:143,name:'Disposable test chain',
    nativeCurrency:{name:'MON',symbol:'MON',decimals:18},
    rpcUrls:{default:{http:['http://local.invalid']}}};
  const transport=custom(provider),rpc=createPublicClient({chain,transport});
  const owner=createWalletClient({chain,transport,account:ownerAddress});
  const sponsor=createWalletClient({chain,transport,account:sponsorAddress});
  const deploy=async (name,args=[])=>{
    const c=artifact[name],hash=await owner.deployContract({abi:c.abi,
      bytecode:`0x${c.evm.bytecode.object}`,args,gas:6_000_000n});
    const receipt=await rpc.waitForTransactionReceipt({hash});
    assert.equal(receipt.status,'success');return receipt.contractAddress;
  };
  const write=async (wallet,name,address,fn,args=[],value=0n)=>{
    const hash=await wallet.writeContract({address,abi:artifact[name].abi,functionName:fn,
      args,value,gas:2_000_000n});
    assert.equal((await rpc.waitForTransactionReceipt({hash})).status,'success');
  };
  const token=await deploy('MockChog'), entropy=await deploy('MockEntropy');
  const vault=await deploy('ChogRewardVaultThresholdDraft',
    [ownerAddress,sponsorAddress,token,entropy,addresses[3]]);
  const read=(fn,args=[])=>rpc.readContract({address:vault,
    abi:artifact.ChogRewardVaultThresholdDraft.abi,functionName:fn,args});
  const assetBalance=address=>rpc.readContract({address:token,
    abi:artifact.MockChog.abi,functionName:'balanceOf',args:[address]});
  const E=10n**18n,rulesHash=`0x${'dc'.repeat(32)}`;
  let currentEpoch=0;
  const backedSlots=new Map();
  intake=new LateBoundCampaignIntake(path.join(folder,'new-campaign.sqlite'),{
    campaignId:'CHOGPIT_LOCAL_SPONSOR_TEST',vault,token,rulesHash,allowMockToken:true,
    admissionPolicy:{rulesHash,canOpen:()=>true,
      currentEpochId:()=>currentEpoch,
      maxOpeningsForEpoch:epochId=>backedSlots.get(epochId)||0}
  });
  const playerAccount='a1'.repeat(16), unaddressed='b2'.repeat(16);
  const insertAccount=intake.db.prepare('INSERT INTO accounts(account_id,created_at,payout_address) VALUES(?,?,?)');
  insertAccount.run(playerAccount,Date.now(),null);
  insertAccount.run(unaddressed,Date.now(),null);
  const runner=new ThresholdSponsorRunner({intake,publicClient:rpc,sponsorClient:sponsor,
    maxEntropyFeeWei:3n*E,maxGasPriceWei:100n*10n**9n,
    maxNativePerTransactionWei:4n*E,confirmations:1});
  const permit=async batch=>{
    const userRandomNumber=keccak256(toHex(`owner-reviewed-root-${batch.root}`));
    const deadline=Math.floor(Date.now()/1000)+3600;
    const fields={chainId:143,vault,epochId:batch.epochId,batchId:batch.batchId,
      root:batch.root,entries:batch.entries.length,userRandomNumber,deadline};
    return {...fields,signature:await ownerKey.signTypedData(batchPermitTypedData(fields))};
  };
  const buyCapacity=async(epochId,slots)=>{
    const nonce=await read('capacityPermitNonce'),deadline=Math.floor(Date.now()/1000)+3600;
    const fields={chainId:143,vault,epochId,slots,nonce,deadline};
    const ownerPermit={...fields,
      signature:await ownerKey.signTypedData(capacityPermitTypedData(fields))};
    const result=await runner.purchaseCapacity({epochId,slots,ownerPermit});
    backedSlots.set(epochId,result.purchasedSlots);
    return result;
  };
  await write(owner,'MockChog',token,'mint',[ownerAddress,1000n*E]);
  await write(owner,'MockChog',token,'transfer',[vault,1000n*E]);
  assert.throws(()=>intake.recordServerOpening({accountId:playerAccount,
    runId:'11'.repeat(16),round:1,boxId:0,mode:'solo',arenaId:'demo'}),/slots.*exhausted/,
  'A server cannot grant an opening before its maximum 25 CHOG is ring-fenced.');
  const purchased0=await buyCapacity(0,2);
  assert.equal(purchased0.pendingCapacity,50n*E);
  await write(owner,'ChogRewardVaultThresholdDraft',vault,'setNewBatchesPaused',[false]);
  const open=(accountId,runId,round,mode='solo')=>intake.recordServerOpening({
    accountId,runId,round,boxId:0,mode,arenaId:'demo'});
  const first=open(playerAccount,'11'.repeat(16),1);
  intake.recordVerifiedAddress(playerAccount,payout.address); // test-only stand-in for a passkey assertion
  open(unaddressed,'22'.repeat(16),1,'pvp');
  const sealed0=intake.sealNextBatch({epochId:0,batchId:0});
  assert.equal(sealed0.unaddressedOutsideBatch,1);
  const batch0=intake.exportUnsignedBatch(0),sig0=await permit(batch0);
  await assert.rejects(()=>runner.publish({batchId:0,
    ownerPermit:{...sig0,root:`0x${'99'.repeat(32)}`}}),/exact owner-signed/);
  const wrongFeeRunner=new ThresholdSponsorRunner({intake,publicClient:rpc,sponsorClient:sponsor,
    maxEntropyFeeWei:1n,maxGasPriceWei:100n*10n**9n,maxNativePerTransactionWei:4n*E});
  await assert.rejects(()=>wrongFeeRunner.publish({batchId:0,ownerPermit:sig0}),
    /fee exceeds sponsor cap/);
  const sponsorBefore=await rpc.getBalance({address:sponsorAddress});
  const published0=await runner.publish({batchId:0,ownerPermit:sig0});
  assert.equal(published0.alreadyCommitted,false);
  assert.equal((await runner.publish({batchId:0})).alreadyCommitted,true,
    'A process restart must not publish a second root or require a new owner signature.');
  await assert.rejects(()=>runner.redeemReadyBatch({batchId:0}),/seed has not arrived/);
  const roll=(seed,epoch,batch,index,eventId)=>BigInt(keccak256(encodeAbiParameters([
    {type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint256'},
    {type:'address'},{type:'bytes32'}
  ],[seed,BigInt(epoch),BigInt(batch),BigInt(index),payout.address,eventId])))%100n;
  let seed0;
  for(let i=0;i<1000;i++){
    const candidate=keccak256(toHex(`five-${i}`));
    if(roll(candidate,0,0,0,first.eventId)<70n){seed0=candidate;break;}
  }
  assert.ok(seed0);
  await write(owner,'MockEntropy',entropy,'fulfill',[published0.sequence,seed0]);
  const redeemed0=await runner.redeemReadyBatch({batchId:0});
  assert.equal(redeemed0.transactions.length,1);
  assert.equal(redeemed0.transactions[0].amount,5n*E);
  assert.equal(redeemed0.transactions[0].paidOut,0n);
  assert.equal(await assetBalance(payout.address),0n);
  assert.equal(await read('creditOf',[payout.address]),5n*E);
  assert.equal((await runner.redeemReadyBatch({batchId:0})).transactions.length,0);
  await write(owner,'ChogRewardVaultThresholdDraft',vault,'closeCurrentEpoch');
  await assert.rejects(()=>write(owner,'ChogRewardVaultThresholdDraft',vault,
    'openNextEpoch',[1000n*E]),/revert/i,
  'The next 1,000-CHOG epoch cannot spend five carried credits or 25 reserved for the unaddressed player.');
  await write(owner,'MockChog',token,'mint',[ownerAddress,1000n*E]);
  await write(owner,'MockChog',token,'transfer',[vault,1000n*E]);
  await write(owner,'ChogRewardVaultThresholdDraft',vault,'openNextEpoch',[1000n*E]);
  currentEpoch=1;
  await buyCapacity(1,9);
  await write(owner,'ChogRewardVaultThresholdDraft',vault,'setNewBatchesPaused',[false]);
  // One separately backed co-op event travels through the exact same signed
  // batch, oracle and sponsor-paid 50-CHOG threshold as solo/PvP events.
  const ids=Array.from({length:9},(_,i)=>open(playerAccount,
    `${(i+1).toString(16).padStart(2,'0')}`.repeat(16),2,i===8?'coop':'solo').eventId);
  const sealed1=intake.sealNextBatch({epochId:1,batchId:1});
  assert.equal(sealed1.unaddressedOutsideBatch,0);
  assert.equal(sealed1.pendingOutsideBatch,1,
    'The old epoch’s unaddressed opening remains separately reserved.');
  assert.throws(()=>intake.exportUnsignedManifest(),/inclusion/);
  const batch1=intake.exportUnsignedBatch(1),sig1=await permit(batch1);
  assert.deepEqual(new Set(batch1.entries.map(entry=>entry.eventId)),new Set(ids));
  assert.equal(batch1.entries.filter(entry=>entry.mode==='coop').length,1,
    'An admitted private co-op event survives batch export for independent review.');
  const published1=await runner.publish({batchId:1,ownerPermit:sig1});
  let seed1;
  for(let i=0;i<100000;i++){
    const candidate=keccak256(toHex(`nine-more-five-${i}`));
    if(batch1.entries.every((entry,index)=>roll(candidate,1,1,index,entry.eventId)<70n)){
      seed1=candidate;break;
    }
  }
  assert.ok(seed1);
  await write(owner,'MockEntropy',entropy,'fulfill',[published1.sequence,seed1]);
  const firstEight=await runner.redeemReadyBatch({batchId:1,maxTransactions:8});
  assert.equal(firstEight.transactions.length,8);
  assert.equal(await read('creditOf',[payout.address]),45n*E);
  assert.equal(await assetBalance(payout.address),0n);
  const final=await runner.redeemReadyBatch({batchId:1});
  assert.equal(final.transactions.length,1);
  assert.equal(final.transactions[0].paidOut,50n*E);
  assert.equal(await assetBalance(payout.address),50n*E);
  assert.equal(await read('creditOf',[payout.address]),0n);
  assert.equal(await rpc.getBalance({address:payout.address}),0n,
    'Player had no MON and never submitted a transaction.');
  assert.ok((await rpc.getBalance({address:sponsorAddress}))<sponsorBefore,
    'The batch operator paid the oracle fee and every redemption transaction.');
  assert.equal(intake.audit().unaddressed,1,
    'A different player’s unaddressed opening remains pending, not forfeited or lost.');
  assert.equal(await read('totalPendingCapacity'),25n*E,
    'Its 25-CHOG worst-case liability stays ring-fenced after an entire later funded epoch.');
  const latePayout=privateKeyToAccount(`0x${'55'.repeat(32)}`);
  intake.recordVerifiedAddress(unaddressed,latePayout.address); // test-only: real flow requires passkey assertion
  const sealed2=intake.sealNextBatch({epochId:0,batchId:2});
  assert.equal(sealed2.count,1);
  assert.equal(intake.audit().pending,0);
  const batch2=intake.exportUnsignedBatch(2);
  const published2=await runner.publish({batchId:2,ownerPermit:await permit(batch2)});
  assert.equal(await read('totalPendingCapacity'),0n,
    'The late opening consumes its ring-fenced original-epoch slot.');
  const lateId=batch2.entries[0].eventId;
  let seed2;
  // Here the oracle roll is for the late recipient, not the first player.
  for(let i=0;i<1000;i++){
    const candidate=keccak256(toHex(`late-five-${i}`));
    const roll2=BigInt(keccak256(encodeAbiParameters([
      {type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint256'},
      {type:'address'},{type:'bytes32'}
    ],[candidate,0n,2n,0n,latePayout.address,lateId])))%100n;
    if(roll2<70n){seed2=candidate;break;}
  }
  assert.ok(seed2);
  await write(owner,'MockEntropy',entropy,'fulfill',[published2.sequence,seed2]);
  const lateCredit=await runner.redeemReadyBatch({batchId:2});
  assert.equal(lateCredit.transactions[0].amount,5n*E);
  assert.equal(await assetBalance(latePayout.address),0n);
  const deadline=Math.floor(Date.now()/1000)+3600;
  const settlement={recipient:latePayout.address,amount:5n*E,
    nonce:await read('settlementNonces',[latePayout.address]),deadline};
  const ownerPermit={...settlement,signature:await ownerKey.signTypedData(
    finalSettlementTypedData({chainId:143,vault,...settlement}))};
  await assert.rejects(()=>runner.settleFinalCredit({recipient:latePayout.address,
    ownerPermit}),/pause/,'The sponsor cannot silently bypass the 50 threshold.');
  await write(owner,'ChogRewardVaultThresholdDraft',vault,'setNewBatchesPaused',[true]);
  await assert.rejects(()=>runner.settleFinalCredit({recipient:latePayout.address,
    ownerPermit:{...ownerPermit,amount:10n*E}}),/exact owner-signed/);
  const settled=await runner.settleFinalCredit({recipient:latePayout.address,ownerPermit});
  assert.equal(settled.amount,5n*E);
  assert.equal(await assetBalance(latePayout.address),5n*E);
  assert.equal(await read('creditOf',[latePayout.address]),0n);
  assert.equal(await rpc.getBalance({address:latePayout.address}),0n);
  await assert.rejects(()=>runner.settleFinalCredit({recipient:latePayout.address,
    ownerPermit}),/No sub-50/,'Final-settlement signature cannot pay twice.');
  console.log('PASS: solo/PvP/co-op candidate batches, owner-signed roots, sponsor-paid oracle/redemptions, cross-epoch 5→50 auto-transfer, deferred address batching, and owner-authorized five-CHOG final settlement on disposable chain');
} finally {
  if(intake) intake.close();
  await provider.disconnect(); rmSync(folder,{recursive:true,force:true});
}
