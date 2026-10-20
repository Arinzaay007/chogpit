import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import ganache from 'ganache';
import solc from 'solc';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom, keccak256 } from 'viem';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { ReviewedAdmissionCandidate } from '../campaign-admission.mjs';
import { capacityPermitTypedData } from '../sponsor-threshold.mjs';

// Disposable-chain verifier stub, NOT a real age, geography or uniqueness
// provider. The test demonstrates fail-closed boundaries, not legal approval.
const dir=mkdtempSync(path.join(os.tmpdir(),'chogpit-admission-'));
const provider=ganache.provider({logging:{quiet:true},chain:{chainId:143},
  wallet:{totalAccounts:3,defaultBalance:1000}});
let intake;
try{
  const source=readFileSync(new URL('../contracts/ChogRewardVaultThresholdDraft.sol',import.meta.url),'utf8');
  const mocks=readFileSync(new URL('../contracts/test/Mocks.sol',import.meta.url),'utf8');
  const result=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',
    sources:{'Vault.sol':{content:source},'Mocks.sol':{content:mocks}},
    settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',
      outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
  if(result.errors?.some(e=>e.severity==='error'))throw Error(result.errors.map(e=>e.formattedMessage).join('\n'));
  const artifacts={...result.contracts['Vault.sol'],...result.contracts['Mocks.sol']};
  const [ownerAddress,sponsorAddress]=await provider.request({method:'eth_accounts'});
  const ownerSigner=privateKeyToAccount(provider.getInitialAccounts()[ownerAddress.toLowerCase()].secretKey);
  const chain={id:143,name:'Disposable admission test',
    nativeCurrency:{name:'MON',symbol:'MON',decimals:18},
    rpcUrls:{default:{http:['http://local.invalid']}}};
  const transport=custom(provider),rpc=createPublicClient({chain,transport});
  const owner=createWalletClient({chain,transport,account:ownerAddress});
  const sponsor=createWalletClient({chain,transport,account:sponsorAddress});
  const deploy=async (name,args=[])=>{
    const item=artifacts[name],hash=await owner.deployContract({abi:item.abi,
      bytecode:`0x${item.evm.bytecode.object}`,args,gas:6_000_000n});
    const receipt=await rpc.waitForTransactionReceipt({hash});
    assert.equal(receipt.status,'success');return receipt.contractAddress;
  };
  const send=async(wallet,name,address,functionName,args=[])=>{
    const hash=await wallet.writeContract({address,abi:artifacts[name].abi,functionName,args,gas:1_500_000n});
    assert.equal((await rpc.waitForTransactionReceipt({hash})).status,'success');
  };
  const token=await deploy('MockChog'),entropy=await deploy('MockEntropy');
  const vault=await deploy('ChogRewardVaultThresholdDraft',
    [ownerAddress,sponsorAddress,token,entropy,ownerAddress]);
  await send(owner,'MockChog',token,'mint',[ownerAddress,1000n*10n**18n]);
  await send(owner,'MockChog',token,'transfer',[vault,1000n*10n**18n]);
  const deadline=BigInt(Math.floor(Date.now()/1000)+3600),slots=3;
  const capacitySignature=await ownerSigner.signTypedData(capacityPermitTypedData({
    chainId:143,vault,epochId:0,slots,nonce:0n,deadline}));
  await send(sponsor,'ChogRewardVaultThresholdDraft',vault,'purchaseCapacity',
    [0n,slots,deadline,capacitySignature]);
  await send(owner,'ChogRewardVaultThresholdDraft',vault,'setNewBatchesPaused',[false]);
  // One more block makes the unpause visible at confirmationDepth=1.
  await rpc.waitForTransactionReceipt({hash:await owner.sendTransaction({to:ownerAddress,value:0n,gas:21_000n})});
  let clock=Date.now();
  const rulesHash=`0x${'d3'.repeat(32)}`;
  let admission;
  const policy={rulesHash,currentEpochId:()=>admission.currentEpochId(),
    maxOpeningsForEpoch:id=>admission.maxOpeningsForEpoch(id),
    canOpen:(event,db)=>admission.canOpen(event,db)};
  intake=new LateBoundCampaignIntake(path.join(dir,'verified.sqlite'),{
    campaignId:'CHOGPIT_TEST_VERIFIED_ADMISSION',vault,token,rulesHash,
    admissionPolicy:policy,allowMockToken:true,now:()=>clock
  });
  const key=randomBytes(32),accounts=['a1','b2','c3','d4'].map(hex=>hex.repeat(16));
  for(const id of accounts) intake.db.prepare('INSERT INTO accounts(account_id,created_at) VALUES(?,?)')
    .run(id,clock);
  const runtime=await rpc.getBytecode({address:vault});
  admission=new ReviewedAdmissionCandidate(intake,{
    publicClient:rpc,expectedRuntimeCodeHash:keccak256(runtime),
    startAt:clock-1000,endAt:clock+60000,personHmacKey:key,
    verificationIssuer:'LOCAL_TEST_PROVIDER',confirmationDepth:1,
    snapshotMaxAgeMs:5000,now:()=>clock,allowMockToken:true,
    verificationProvider:{async verify({assertion}){
      return {issuer:'LOCAL_TEST_PROVIDER',adult:assertion.adult!==false,
        eligibleJurisdiction:assertion.eligible!==false,
        stablePersonId:assertion.person,evidenceId:assertion.evidence,
        expiresAt:clock+30000};
    }}
  });
  assert.throws(()=>intake.recordServerOpening({accountId:accounts[0],
    runId:'11'.repeat(16),round:1,boxId:0,mode:'solo',arenaId:'demo'}),/snapshot/,
  'Even a funded vault cannot admit a box until a recent confirmed snapshot exists.');
  const snapshot=await admission.refreshConfirmedCapacity();
  assert.equal(snapshot.purchasedSlots,3);
  assert.equal(snapshot.pendingCapacity,(75n*10n**18n).toString());
  const fakeAccounts={account:session=>({accountId:accounts[Number(session)]})};
  await assert.rejects(()=>admission.verifyPerson('0',fakeAccounts,{
    person:'same-human-001',evidence:'evidence-01',adult:false}),/verification failed/);
  for(const [session,person,evidence] of [
    ['0','same-human-001','evidence-01'],['1','same-human-001','evidence-02'],
    ['2','different-human','evidence-03'],['3','another-human-01','evidence-04']
  ]) await admission.verifyPerson(session,fakeAccounts,{person,evidence});
  await assert.rejects(()=>admission.verifyPerson('1',fakeAccounts,{
    person:'same-human-001',evidence:'evidence-01'}),/already used/,
  'A verifier assertion cannot be replayed on another passkey account.');
  const open=(id,hex,mode,round=1,boxId=0)=>intake.recordServerOpening({
    accountId:accounts[id],runId:hex.repeat(16),round,boxId,mode,arenaId:'demo'});
  const solo=open(0,'11','solo');
  const coop=open(1,'22','coop');
  assert.equal(solo.duplicate,false);assert.equal(coop.duplicate,false);
  assert.equal(open(1,'22','coop').duplicate,true,
    'Retrying the same co-op opening is idempotent and cannot consume another slot.');
  assert.throws(()=>open(2,'66','unsupported'),/server-owned opening/);
  assert.throws(()=>open(0,'22','pvp'),/Conflicting duplicate/,
    'A teammate cannot claim the same shared box by relabeling its mode or account.');
  assert.equal(intake.audit().openings,2);
  assert.throws(()=>open(0,'33','pvp',2),/admission policy rejected/,
    'Two passkeys for the same verified person cannot get a third opening by switching solo/co-op/PvP modes.');
  open(2,'44','pvp');
  assert.deepEqual(intake.db.prepare('SELECT mode FROM openings ORDER BY opened_at,event_id').all()
    .map(row=>row.mode).sort(),['coop','pvp','solo']);
  assert.equal(intake.audit().openings,3);
  assert.throws(()=>open(3,'55','coop'),/slots.*exhausted/,
    'A fourth account cannot spend three funded 25-CHOG slots, even in co-op.');
  clock+=6000;
  assert.throws(()=>admission.currentEpochId(),/recent confirmed/,
    'A stale RPC capacity view stops acceptance before another opening.');
  clock+=60000;
  assert.equal(admission.canOpen({accountId:accounts[3],openedAt:clock,
    epochId:0,priorEpochEvents:0},intake.db),false,
    'The exact UTC end is exclusive even if unused slots remain.');
  clock-=60000;
  await admission.refreshConfirmedCapacity();
  const originalGetBlock=admission.rpc.getBlock.bind(admission.rpc);
  admission.rpc=new Proxy(rpc,{get(target,name){
    if(name==='getBlock')return async args=>{
      const block=await originalGetBlock(args);
      return args.blockNumber===BigInt(snapshot.blockNumber)
        ? {...block,hash:`0x${'8e'.repeat(32)}`} : block;
    };
    return target[name];
  }});
  await assert.rejects(()=>admission.refreshConfirmedCapacity(),/Admission halted.*chain history/);
  assert.throws(()=>admission.currentEpochId(),/Admission halted/);
  console.log('PASS: funded-slot snapshot, free verifier stub, two openings per person across solo/PvP/co-op and passkeys, shared-box replay, UTC cutoff, stale-RPC failure, and reorg halt (mock chain only)');
}finally{
  if(intake)intake.close();
  await provider.disconnect();rmSync(dir,{recursive:true,force:true});
}
