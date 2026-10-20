import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { createCandidateRecoveryPoint, verifyCandidateRecoveryPoint,
  assertCandidateJournalAtCheckpoint } from '../candidate-recovery.mjs';

// All identities and assets below are invented. There is no mainnet signer,
// CHOG, remote trusted store or production verifier in this recovery drill.
const dir=mkdtempSync(path.join(os.tmpdir(),'chogpit-candidate-recovery-'));
const identity={campaignId:'CHOGPIT_RECOVERY_TEST_001',vault:`0x${'ab'.repeat(20)}`,
  token:`0x${'cd'.repeat(20)}`,rulesHash:`0x${'e3'.repeat(32)}`};
const options={...identity,allowMockToken:true,
  admissionPolicy:{rulesHash:identity.rulesHash,canOpen:()=>true,
    currentEpochId:()=>0,maxOpeningsForEpoch:()=>5}};
const live=path.join(dir,'live.sqlite');
let intake,restored;
try {
  intake=new LateBoundCampaignIntake(live,options);
  const [a,b,c]=['a1','b2','c3'].map(hex=>hex.repeat(16));
  const insert=intake.db.prepare('INSERT INTO accounts(account_id,created_at,payout_address) VALUES(?,?,?)');
  insert.run(a,Date.now(),null);
  insert.run(b,Date.now(),null);
  insert.run(c,Date.now(),null);
  // Test-only direct accounts and address binding; real confirmation requires
  // a fresh passkey assertion (tested in passkey-late-binding.mjs).
  const open=(accountId,runId,mode)=>intake.recordServerOpening({
    accountId,runId,round:1,boxId:0,mode,arenaId:'demo'});
  open(a,'11'.repeat(16),'solo');
  intake.recordVerifiedAddress(a,`0x${'42'.repeat(20)}`);
  open(b,'22'.repeat(16),'coop');
  intake.sealNextBatch({epochId:0,batchId:0});
  assert.equal(intake.audit().pending,1);
  const snapshot1=path.join(dir,'private-backup-1.sqlite');
  const checkpoint1=path.join(dir,'checkpoint-1.json');
  const first=await createCandidateRecoveryPoint(intake,snapshot1,checkpoint1);
  const independentlyHeldDigest=first.digest; // only an in-memory stand-in for a trusted external anchor
  assert.match(independentlyHeldDigest,/^0x[a-f0-9]{64}$/);
  assert.equal(first.unaddressed,1);
  assert.equal((await stat(snapshot1)).mode & 0o777,0o600);
  assert.equal((await stat(checkpoint1)).mode & 0o777,0o600);
  const firstAnchor=JSON.parse(await readFile(checkpoint1,'utf8'));
  assert.equal(firstAnchor.mainnetClaimable,false);
  assert.equal(firstAnchor.openings,2);
  assert.equal(firstAnchor.pending,1);
  assert.equal(firstAnchor.unaddressed,1);
  assert.equal((await verifyCandidateRecoveryPoint(snapshot1,checkpoint1,independentlyHeldDigest)).pending,1);
  assert.equal(assertCandidateJournalAtCheckpoint(intake,firstAnchor,independentlyHeldDigest)
    .mainnetClaimable,false);
  await assert.rejects(()=>verifyCandidateRecoveryPoint(snapshot1,checkpoint1),/independently held/);
  await assert.rejects(()=>createCandidateRecoveryPoint(intake,snapshot1,checkpoint1),/EEXIST/,
    'A checkpoint or backup cannot overwrite a prior private snapshot.');
  await assert.rejects(()=>createCandidateRecoveryPoint(intake,live,path.join(dir,'bad.json')),
    /must not overwrite/);
  // Account/verifier state can change without an opening-journal append. The
  // separate private-state hash must catch that even with identical counts.
  insert.run('d4'.repeat(16),Date.now(),null);
  assert.equal(intake.audit().journalHead,firstAnchor.journalHead);
  assert.throws(()=>assertCandidateJournalAtCheckpoint(intake,firstAnchor,independentlyHeldDigest),
    /Private candidate account\/verification state differs/);

  // A subsequent valid opening changes the journal head. Never quietly treat
  // a stale checkpoint as proof that an unanchored co-op/PvP event was saved.
  open(c,'33'.repeat(16),'pvp');
  assert.throws(()=>assertCandidateJournalAtCheckpoint(intake,firstAnchor,independentlyHeldDigest),
    /differs from the independently held checkpoint/);
  const unchangedHead=intake.audit().journalHead;
  intake.db.exec(`CREATE TRIGGER reject_address_audit BEFORE INSERT ON audit_log
    WHEN NEW.kind='PASSKEY_ADDRESS' BEGIN SELECT RAISE(ABORT,'address audit unavailable'); END`);
  assert.throws(()=>intake.recordVerifiedAddress(c,`0x${'55'.repeat(20)}`),
    /address audit unavailable/,'An audit-write failure cannot change the payout address.');
  assert.equal(intake.db.prepare('SELECT payout_address FROM accounts WHERE account_id=?').get(c).payout_address,null);
  assert.equal(intake.audit().journalHead,unchangedHead);
  intake.db.exec('DROP TRIGGER reject_address_audit');
  intake.db.prepare('UPDATE accounts SET payout_address=? WHERE account_id=?')
    .run(`0x${'66'.repeat(20)}`,b); // simulated unauthorized DB edit, NOT a passkey flow
  assert.throws(()=>intake.sealNextBatch({epochId:0,batchId:1}),/passkey audit history/,
    'A manually changed address cannot enter an unsigned root without its passkey receipt.');
  intake.db.prepare('UPDATE accounts SET payout_address=NULL WHERE account_id=?').run(b);
  assert.equal(intake.audit().unaddressed,2);
  const snapshot2=path.join(dir,'private-backup-2.sqlite');
  const checkpoint2=path.join(dir,'checkpoint-2.json');
  const second=await createCandidateRecoveryPoint(intake,snapshot2,checkpoint2);
  const secondAnchor=JSON.parse(await readFile(checkpoint2,'utf8'));
  assert.equal(second.pending,2);
  assert.equal(second.unaddressed,2);
  assert.equal((await verifyCandidateRecoveryPoint(snapshot2,checkpoint2,second.digest)).openings,3);
  assert.throws(()=>assertCandidateJournalAtCheckpoint(intake,firstAnchor,second.digest),
    /independently held digest/,'A local anchor cannot be relabeled as the newer independent digest.');

  // Recover the earlier, coherent WAL snapshot. It retains the unaddressed
  // co-op obligation but must fail against the latest externally held anchor:
  // a backup alone cannot hide the later accepted PvP box.
  const restoredFile=path.join(dir,'restored.sqlite');
  await copyFile(snapshot1,restoredFile);
  restored=new LateBoundCampaignIntake(restoredFile,options);
  assert.equal(restored.audit().openings,2);
  assert.equal(restored.audit().unaddressed,1);
  assertCandidateJournalAtCheckpoint(restored,firstAnchor,independentlyHeldDigest);
  assert.throws(()=>assertCandidateJournalAtCheckpoint(restored,secondAnchor,second.digest),
    /differs from the independently held checkpoint/);
  restored.close();restored=null;

  const tamperedFile=path.join(dir,'edited.sqlite');
  await copyFile(snapshot2,tamperedFile);
  const edited=new Database(tamperedFile);
  edited.prepare("UPDATE openings SET mode='pvp' WHERE mode='coop'").run();
  edited.close();
  await assert.rejects(()=>verifyCandidateRecoveryPoint(tamperedFile,checkpoint2,second.digest),
    /snapshot bytes differ/,'Even a valid SQLite file fails against the independently held digest.');
  const alteredAnchor=path.join(dir,'altered-checkpoint.json');
  await writeFile(alteredAnchor,JSON.stringify({...secondAnchor,pending:0}),{flag:'wx',mode:0o600});
  await assert.rejects(()=>verifyCandidateRecoveryPoint(snapshot2,alteredAnchor,second.digest),
    /invalid or lacks a matching independently held digest/);
  const occupied=path.join(dir,'occupied.json');
  await writeFile(occupied,'already exists',{flag:'wx'});
  const orphan=path.join(dir,'do-not-publish.sqlite');
  await assert.rejects(()=>createCandidateRecoveryPoint(intake,orphan,occupied),/EEXIST/);
  await assert.rejects(()=>stat(orphan),/ENOENT/,
    'A failed checkpoint publication cannot leave a backup that looks certified.');
  console.log('PASS: private WAL-safe V5 candidate snapshots, atomic address-audit failure, externally anchorable digests, pending co-op inclusion, restore/rollback/tamper and no-overwrite checks; no live payout');
} finally {
  if(restored?.db.open)restored.close();
  if(intake?.db.open)intake.close();
  rmSync(dir,{recursive:true,force:true});
}
