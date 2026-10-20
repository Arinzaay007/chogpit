import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256 } from 'viem';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { EmailAccounts } from '../email-accounts.mjs';
import { EmailAdmissionCandidate } from '../email-admission.mjs';

// A deliberately FAKE chain and FAKE delivery service. No authority, actual
// deployed contract, real email or player eligibility is established by this.
const dir=mkdtempSync(path.join(os.tmpdir(),'chogpit-email-policy-'));
let intake;
try {
  let clock=1810000000000;
  const vault=`0x${'14'.repeat(20)}`,token=`0x${'33'.repeat(20)}`;
  const runtime='0x6001600055';
  const blockHash=`0x${'af'.repeat(32)}`;
  let servedHash=blockHash, purchased=3, paused=false, chainId=143;
  const wei=10n**18n;
  const rpc={
    getChainId:async()=>chainId,getBlockNumber:async()=>200n,
    getBlock:async({blockNumber})=>({number:blockNumber,hash:servedHash}),
    getBytecode:async()=>runtime,
    readContract:async({functionName})=>({
      chog:token,currentEpochId:0n,newBatchesPaused:paused,
      outstandingCredits:0n,totalReserved:0n,totalPendingCapacity:75n*wei,
      epochs:[1000n*wei,0n,0n,75n*wei,purchased,false],
      balanceOf:1000n*wei
    })[functionName]
  };
  const rulesHash=`0x${'f2'.repeat(32)}`;
  let admission;
  const policy={rulesHash,
    currentEpochId:()=>admission.currentEpochId(),
    maxOpeningsForEpoch:id=>admission.maxOpeningsForEpoch(id),
    canOpen:(event,db)=>admission.canOpen(event,db)};
  intake=new LateBoundCampaignIntake(path.join(dir,'email-policy.sqlite'),{
    campaignId:'CHOGPIT_EMAIL_FUNDED_MOCK',vault,token,rulesHash,
    accountMethod:'email',admissionPolicy:policy,allowMockToken:true,now:()=>clock});
  const outbox=[];
  const accounts=new EmailAccounts(intake,{origin:'http://localhost:34444',
    sendMagicLink:async msg=>outbox.push(msg),now:()=>clock});
  const signup=async email=>{
    await accounts.requestLogin(email);
    const token=outbox.pop().url.split('#login=')[1];
    return accounts.finishLogin(token);
  };
  const alice=await signup('alice@example.org');
  admission=new EmailAdmissionCandidate(intake,{publicClient:rpc,
    expectedRuntimeCodeHash:keccak256(runtime),startAt:clock-1000,
    endAt:clock+30000,confirmationDepth:1,snapshotMaxAgeMs:5000,
    now:()=>clock,allowMockToken:true});
  assert.throws(()=>admission.currentEpochId(),/snapshot/);
  assert.throws(()=>intake.recordServerOpening({runId:'10'.repeat(16),round:1,boxId:0,
    mode:'solo',arenaId:'demo',accountId:alice.accountId}),/snapshot/);
  const snapshot=await admission.refreshConfirmedCapacity();
  assert.equal(snapshot.purchasedSlots,3);
  assert.equal(snapshot.vaultBalance,(1000n*wei).toString());
  assert.throws(()=>new EmailAdmissionCandidate(intake,{publicClient:rpc,
    expectedRuntimeCodeHash:keccak256(runtime),startAt:clock-1000,
    endAt:clock+30001,confirmationDepth:1,snapshotMaxAgeMs:5000,
    now:()=>clock,allowMockToken:true}),/settings changed/);
  const open=(identity,byte,mode)=>intake.recordServerOpening({
    runId:byte.repeat(16),round:1,boxId:0,mode,arenaId:'demo',accountId:identity.accountId});
  open(alice,'11','solo');
  open(alice,'22','coop');
  assert.throws(()=>open(alice,'33','pvp'),/two campaign openings/);
  const bob=await signup('bob@example.org');
  open(bob,'44','pvp');
  assert.throws(()=>open(bob,'55','solo'),/slots.*exhausted/,
    'Another verified inbox cannot exceed three confirmed backed slots.');
  assert.equal(intake.audit().openings,3);
  assert.equal(intake.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='reviewed_persons'").get().n,0,
    'An email campaign must not silently rely on person-verification records.');
  clock+=6001;
  assert.throws(()=>admission.currentEpochId(),/snapshot/,
    'A stale chain snapshot cannot authorize another opening.');
  clock+=30000;
  assert.equal(admission.canOpen({accountId:bob.accountId,openedAt:clock,
    priorEvents:3,priorEpochEvents:3,epochId:0},intake.db),false,
    'The exact UTC campaign end is exclusive.');
  clock-=30000;
  servedHash=`0x${'aa'.repeat(32)}`;
  await assert.rejects(()=>admission.refreshConfirmedCapacity(),/halted.*history/);
  assert.throws(()=>admission.currentEpochId(),/halted/);
  assert.equal(intake.db.prepare('SELECT halted FROM email_admission_config').get().halted,1);
  console.log('PASS: email-only candidate checks confirmed mock chain funding, exact UTC end, two per mailbox, global slots, stale snapshot/reorg halt; no person verification or real launch');
} finally {
  if (intake) intake.close();
  rmSync(dir,{recursive:true,force:true});
}
