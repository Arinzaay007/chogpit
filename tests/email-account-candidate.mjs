import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LateBoundCampaignIntake, lateBoundEventId, emailBoundEventId } from '../late-bound-intake.mjs';
import { EmailAccounts, normalizeCampaignEmail } from '../email-accounts.mjs';
import { createCandidateRecoveryPoint } from '../candidate-recovery.mjs';

// Mock-token/delivery, private disposable SQLite only. The policy stub proves
// candidate flow; it is NOT a funded on-chain snapshot or an eligibility ruling.
const dir = mkdtempSync(path.join(os.tmpdir(),'chogpit-email-candidate-'));
const file = path.join(dir,'EMAIL.sqlite');
let intake;
try {
  const rulesHash = `0x${'a5'.repeat(32)}`;
  let clock = 1790000000000, slots = 3;
  const policy = { rulesHash, currentEpochId:()=>0,
    maxOpeningsForEpoch:()=>slots,
    canOpen: ({ accountId, openedAt, priorEpochEvents }, db) =>
      openedAt === clock && priorEpochEvents < slots &&
      Boolean(db.prepare('SELECT 1 FROM email_identities WHERE account_id=?').get(accountId)) &&
      db.prepare('SELECT COUNT(*) AS n FROM openings WHERE account_id=?').get(accountId).n < 2 };
  const options = { campaignId:'CHOGPIT_EMAIL_TEST_ONLY',
    vault:`0x${'12'.repeat(20)}`,token:`0x${'35'.repeat(20)}`,
    rulesHash,admissionPolicy:policy,accountMethod:'email',
    allowMockToken:true,now:()=>clock };
  intake = new LateBoundCampaignIntake(file,options);
  let outbox=[], shouldFail=false;
  const mailer=async message=>{
    if (shouldFail) throw Error('offline');
    outbox.push(message);
  };
  let accounts = new EmailAccounts(intake,{origin:'http://localhost:31555',sendMagicLink:mailer,
    now:()=>clock});
  const pop=(purpose)=>{
    const mail=outbox.pop();
    assert.equal(mail.purpose,purpose);
    const url=new URL(mail.url);
    assert.equal(url.pathname,'/campaign-email-account.html');
    assert.match(url.hash,new RegExp(`^#${purpose}=[A-Za-z0-9_-]{43}$`));
    return url.hash.split('=')[1];
  };
  assert.equal(normalizeCampaignEmail('  Alice+1@Example.org  '),'alice+1@example.org');
  assert.throws(()=>normalizeCampaignEmail('alice..ab@example.org'),/supported/);
  assert.throws(()=>normalizeCampaignEmail('alice@example.org\nBcc:attacker@example.org'),/supported/);
  assert.notEqual(emailBoundEventId(options.campaignId,'aa'.repeat(16),1,0),
    lateBoundEventId(options.campaignId,'aa'.repeat(16),1,0));
  assert.throws(()=>new LateBoundCampaignIntake(file,{...options,accountMethod:'passkey'}),
    /account provenance/);
  shouldFail=true;
  await assert.rejects(()=>accounts.requestLogin('alice@example.org'),/delivery failed/);
  assert.equal(intake.db.prepare('SELECT COUNT(*) AS n FROM email_magic_links').get().n,0);
  shouldFail=false;
  const response=await accounts.requestLogin(' Alice@Example.org ');
  assert.equal(response.sent,true);
  assert.equal(JSON.stringify(response).includes('localhost'),false,
    'The link and secret must never appear in the API response.');
  const aliceLink=pop('login');
  assert.throws(()=>accounts.finishAddressConfirmation({session:'x',token:aliceLink}),/session/);
  assert.throws(()=>accounts.finishLogin('a'.repeat(43)),/invalid/);
  const alice=accounts.finishLogin(aliceLink);
  assert.match(alice.session,/^[A-Za-z0-9_-]{43}$/);
  assert.match(alice.accountId,/^[a-f0-9]{32}$/);
  assert.throws(()=>accounts.finishLogin(aliceLink),/already used/);
  assert.equal(accounts.account(alice.session).accountId,alice.accountId);
  assert.equal(intake.audit().journalEntries,1);
  // Re-login with the same normalized mailbox preserves the account and its
  // lifetime two-opening count, not a new quota per session/browser.
  clock+=61000;
  await accounts.requestLogin('ALICE@EXAMPLE.ORG');
  const relogin=accounts.finishLogin(pop('login'));
  assert.equal(relogin.accountId,alice.accountId);
  assert.equal(intake.audit().journalEntries,1);
  clock+=61000;
  await accounts.requestLogin('bob@example.org');
  const bobLink=pop('login');
  intake.db.exec(`CREATE TRIGGER email_block_registration BEFORE INSERT ON audit_log
    WHEN NEW.kind='EMAIL_REGISTER' BEGIN SELECT RAISE(ABORT,'registration receipt failed'); END`);
  assert.throws(()=>accounts.finishLogin(bobLink),/registration receipt failed/);
  assert.equal(intake.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,1);
  assert.equal(intake.db.prepare("SELECT used_at FROM email_magic_links WHERE normalized_email='bob@example.org'").get().used_at,null);
  intake.db.exec('DROP TRIGGER email_block_registration');
  const bob=accounts.finishLogin(bobLink);
  assert.notEqual(bob.accountId,alice.accountId);
  const open=(accountId,byte,mode,round=1,boxId=0)=>intake.recordServerOpening({
    runId:byte.repeat(16),round,boxId,mode,arenaId:'demo',accountId});
  assert.equal(open(alice.accountId,'11','solo').source,'FRESH_EMAIL_ACCOUNT_V1');
  assert.equal(open(alice.accountId,'11','solo').duplicate,true);
  assert.equal(open(alice.accountId,'22','coop').source,'FRESH_EMAIL_ACCOUNT_V1');
  assert.throws(()=>open(alice.accountId,'33','pvp'),/two campaign openings/,
    'Two openings per email include solo, co-op and PvP together.');
  assert.equal(open(bob.accountId,'44','pvp').duplicate,false);
  assert.throws(()=>open(bob.accountId,'55','solo'),/slots.*exhausted/,
    'Three backed slots cannot be consumed a fourth time even with another email.');
  assert.throws(()=>intake.sealNextBatch({epochId:0,batchId:0}),/confirmed addresses/);
  assert.equal(intake.audit().unaddressed,3);
  assert.throws(()=>accounts.finishLogin('b'.repeat(43)),/invalid/);
  await assert.rejects(()=>accounts.requestAddressConfirmation({session:'bad',address:options.vault,
    confirmAddress:options.vault}),/session/);
  const a1=`0x${'46'.repeat(20)}`, a2=`0x${'48'.repeat(20)}`;
  const requested=await accounts.requestAddressConfirmation({session:alice.session,
    address:a1,confirmAddress:a1});
  assert.equal(JSON.stringify(requested).includes('address='),false);
  const addressLink=pop('address');
  assert.throws(()=>accounts.finishLogin(addressLink),/invalid/,
    'An address token must not sign someone in.');
  assert.throws(()=>accounts.finishAddressConfirmation({session:bob.session,token:addressLink}),
    /another account/);
  const head=intake.audit().journalHead;
  intake.db.exec(`CREATE TRIGGER email_block_address BEFORE INSERT ON audit_log
    WHEN NEW.kind='EMAIL_ADDRESS' BEGIN SELECT RAISE(ABORT,'receipt failed'); END`);
  assert.throws(()=>accounts.finishAddressConfirmation({session:alice.session,token:addressLink}),
    /receipt failed/);
  assert.equal(intake.audit().journalHead,head);
  assert.equal(accounts.account(alice.session).payoutAddress,null);
  assert.equal(intake.db.prepare('SELECT used_at FROM email_magic_links WHERE purpose=\'address\'').get().used_at,null,
    'A failed receipt must atomically roll back the link consumption and address change.');
  intake.db.exec('DROP TRIGGER email_block_address');
  assert.equal(accounts.finishAddressConfirmation({session:alice.session,token:addressLink})
    .payoutAddress.toLowerCase(),a1.toLowerCase());
  assert.throws(()=>accounts.finishAddressConfirmation({session:alice.session,token:addressLink}),/already used/);
  clock+=61000;
  await accounts.requestAddressConfirmation({session:alice.session,address:a2,confirmAddress:a2});
  const addressChange=pop('address');
  accounts.finishAddressConfirmation({session:alice.session,token:addressChange});
  assert.equal(intake.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind='EMAIL_ADDRESS'").get().n,2);
  const batch=intake.sealNextBatch({epochId:0,batchId:0});
  assert.equal(batch.count,2);
  assert.equal(batch.pendingOutsideBatch,1);
  assert.equal(batch.unaddressedOutsideBatch,1);
  assert.deepEqual(intake.exportUnsignedBatch(0).entries.map(e=>e.source),
    ['FRESH_EMAIL_ACCOUNT_V1','FRESH_EMAIL_ACCOUNT_V1']);
  assert.throws(()=>intake.exportUnsignedManifest(),/inclusion/);
  await assert.rejects(()=>accounts.requestAddressConfirmation({session:alice.session,address:a1,
    confirmAddress:a1}),/cannot be confirmed/);
  assert.equal(intake.audit().unaddressed,1);
  clock+=61000;
  await accounts.requestAddressConfirmation({session:bob.session,address:`0x${'49'.repeat(20)}`,
    confirmAddress:`0x${'49'.repeat(20)}`});
  accounts.finishAddressConfirmation({session:bob.session,token:pop('address')});
  intake.sealNextBatch({epochId:0,batchId:1});
  const manifest=intake.exportUnsignedManifest();
  assert.equal(manifest.batches.length,2);
  assert.equal(manifest.batches[0].entries.length,2);
  assert.equal(manifest.attestation,null);
  assert.throws(()=>intake.db.prepare('UPDATE audit_log SET kind=? WHERE seq=1').run('WRONG'),
    /append-only/);
  assert.equal(intake.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,2);
  clock+=61000;
  await accounts.requestLogin('expired@example.org');
  const expired=pop('login');
  clock+=10*60*1000;
  assert.throws(()=>accounts.finishLogin(expired),/expired/);
  assert.equal(intake.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,2);
  accounts.signOut(alice.session);
  assert.throws(()=>accounts.account(alice.session),/expired/);
  // An old link cannot open a new account or modify an already locked address.
  await assert.rejects(()=>createCandidateRecoveryPoint(intake,path.join(dir,'backup.sqlite'),
    path.join(dir,'checkpoint.json')),/candidate journal|output paths|intake/);
  intake.close(); intake=null;
  intake=new LateBoundCampaignIntake(file,options);
  accounts=new EmailAccounts(intake,{origin:'http://localhost:31555',sendMagicLink:mailer,
    now:()=>clock});
  assert.equal(accounts.account(bob.session).accountId,bob.accountId);
  assert.equal(intake.audit().openings,3);
  assert.throws(()=>new LateBoundCampaignIntake(file,{...options,accountMethod:'passkey'}),
    /account provenance/);
  console.log('PASS: isolated email magic links, sender failure, case-folded stable accounts, two/email across modes, global backing, audited one-time address binding, late batch, schema separation and restart; mock only');
} finally {
  if (intake) intake.close();
  rmSync(dir,{recursive:true,force:true});
}
