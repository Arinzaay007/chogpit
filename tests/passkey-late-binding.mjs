import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { PasskeyAccounts } from '../passkey-accounts.mjs';

const folder = mkdtempSync(path.join(os.tmpdir(),'chogpit-passkey-'));
const server = http.createServer((_req,res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html><title>Local WebAuthn test only</title></html>');
});
server.listen(0,'localhost'); await once(server,'listening');
const origin = `http://localhost:${server.address().port}`;
const rulesHash = `0x${'bc'.repeat(32)}`;
const vault = `0x${'ab'.repeat(20)}`;
const address = `0x${'47'.repeat(20)}`;
let browser, intake;
try {
  const intakeOptions={campaignId:'CHOGPIT_TEST_PASSKEY_001',vault,rulesHash,
    admissionPolicy:{rulesHash,canOpen:()=>true,
      currentEpochId:()=>0,maxOpeningsForEpoch:()=>40},allowMockToken:true};
  intake=new LateBoundCampaignIntake(path.join(folder,'journal.sqlite'),intakeOptions);
  assert.equal(intake.db.prepare('SELECT kind FROM late_schema').get().kind,'PASSKEY_LATE_BOUND_V5_ADDRESS_AUDIT');
  const oldFile=path.join(folder,'obsolete-draft.sqlite');
  const obsolete=new LateBoundCampaignIntake(oldFile,intakeOptions);
  obsolete.db.prepare('UPDATE late_schema SET kind=?').run('PASSKEY_LATE_BOUND_V4_COOP');
  obsolete.close();
  assert.throws(()=>new LateBoundCampaignIntake(oldFile,intakeOptions),/different vault or rules version/,
    'An older V4 journal without address receipts cannot masquerade as a V5 journal.');
  const oldConstraintFile=path.join(folder,'obsolete-check.sqlite');
  const oldConstraintDb=new Database(oldConstraintFile);
  oldConstraintDb.exec(`CREATE TABLE openings(event_id TEXT,opened_epoch INTEGER,
    opened_at INTEGER,account_id TEXT,batch_id INTEGER,
    mode TEXT NOT NULL CHECK(mode IN ('solo','pvp')))`);
  oldConstraintDb.close();
  assert.throws(()=>new LateBoundCampaignIntake(oldConstraintFile,intakeOptions),
    /Incompatible openings table or account provenance/,
    'A leftover V3 CHECK must fail before the journal can be labeled V5.');
  const accounts = new PasskeyAccounts(intake,{rpID:'localhost',origin});
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(origin);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{
    protocol:'ctap2', transport:'internal',hasResidentKey:true,hasUserVerification:true,
    isUserVerified:true,automaticPresenceSimulation:true
  }});
  const registration = await accounts.beginRegistration();
  const registerResponse = await page.evaluate(async options => {
    const bytes = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),
      char => char.charCodeAt(0));
    const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    const pk = {...options, challenge:bytes(options.challenge), user:{...options.user,id:bytes(options.user.id)},
      excludeCredentials:options.excludeCredentials?.map(c=>({...c,id:bytes(c.id)}))};
    const result = await navigator.credentials.create({publicKey:pk});
    return { id:result.id,rawId:b64(result.rawId),type:result.type,
      response:{clientDataJSON:b64(result.response.clientDataJSON),
        attestationObject:b64(result.response.attestationObject),
        transports:result.response.getTransports?.()||[]},
      clientExtensionResults:result.getClientExtensionResults(),
      authenticatorAttachment:result.authenticatorAttachment };
  }, registration.options);
  const registered = await accounts.finishRegistration({requestId:registration.requestId,
    response:registerResponse});
  assert.match(registered.accountId,/^[a-f0-9]{32}$/);
  assert.equal(accounts.account(registered.session).payoutAddress,null);
  await assert.rejects(() => accounts.finishRegistration({ requestId:registration.requestId,
    response:registerResponse }), /already used/);
  const opening = intake.recordServerOpening({runId:'d7'.repeat(16),round:1,boxId:0,
    accountId:registered.accountId,mode:'solo',arenaId:'demo'});
  assert.equal(opening.source,'FRESH_PASSKEY_ACCOUNT_V2');
  // A different real passkey account remains unaddressed while the first
  // player's award moves ahead; it cannot silently disappear from audit.
  const registration2 = await accounts.beginRegistration();
  const registerResponse2 = await page.evaluate(async options => {
    const bytes = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),
      char => char.charCodeAt(0));
    const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    const pk = {...options,challenge:bytes(options.challenge),user:{...options.user,id:bytes(options.user.id)}};
    const result = await navigator.credentials.create({publicKey:pk});
    return {id:result.id,rawId:b64(result.rawId),type:result.type,
      response:{clientDataJSON:b64(result.response.clientDataJSON),
        attestationObject:b64(result.response.attestationObject),
        transports:result.response.getTransports?.()||[]},
      clientExtensionResults:result.getClientExtensionResults(),
      authenticatorAttachment:result.authenticatorAttachment};
  },registration2.options);
  const registered2 = await accounts.finishRegistration({requestId:registration2.requestId,
    response:registerResponse2});
  intake.recordServerOpening({runId:'e8'.repeat(16),round:1,boxId:0,
    accountId:registered2.accountId,mode:'pvp',arenaId:'demo'});
  assert.throws(() => intake.sealNextBatch({epochId:0,batchId:0}), /confirmed addresses/);
  assert.throws(() => accounts.account('bad-session'), /session/);
  async function assertPasskey(options) {
    return page.evaluate(async options => {
      const bytes = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),
        char => char.charCodeAt(0));
      const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      const pk = {...options,challenge:bytes(options.challenge),
        allowCredentials:options.allowCredentials?.map(c=>({...c,id:bytes(c.id)}))};
      const result = await navigator.credentials.get({publicKey:pk});
      return {id:result.id,rawId:b64(result.rawId),type:result.type,
        response:{clientDataJSON:b64(result.response.clientDataJSON),
          authenticatorData:b64(result.response.authenticatorData),
          signature:b64(result.response.signature),
          userHandle:result.response.userHandle ? b64(result.response.userHandle) : undefined},
        clientExtensionResults:result.getClientExtensionResults(),
        authenticatorAttachment:result.authenticatorAttachment};
    },options);
  }
  const bind = await accounts.beginAddressConfirmation({session:registered.session,address});
  const bindResponse = await assertPasskey(bind.options);
  const confirmed = await accounts.finishAddressConfirmation({session:registered.session,
    requestId:bind.requestId,response:bindResponse});
  assert.equal(confirmed.payoutAddress.toLowerCase(),address.toLowerCase());
  await assert.rejects(() => accounts.finishAddressConfirmation({session:registered.session,
    requestId:bind.requestId,response:bindResponse}), /already used/);
  const badBind=await accounts.beginAddressConfirmation({session:registered.session,
    address:`0x${'46'.repeat(20)}`});
  const badResponse=await assertPasskey(badBind.options);
  const counterBefore=intake.db.prepare('SELECT sign_count FROM passkey_credentials LIMIT 1').get().sign_count;
  const headBefore=intake.audit().journalHead;
  intake.db.exec(`CREATE TRIGGER block_address_receipt BEFORE INSERT ON audit_log
    WHEN NEW.kind='PASSKEY_ADDRESS' BEGIN SELECT RAISE(ABORT,'address receipt unavailable'); END`);
  await assert.rejects(()=>accounts.finishAddressConfirmation({session:registered.session,
    requestId:badBind.requestId,response:badResponse}),/address receipt unavailable/);
  assert.equal(accounts.account(registered.session).payoutAddress,address.toLowerCase());
  assert.equal(intake.db.prepare('SELECT sign_count FROM passkey_credentials LIMIT 1').get().sign_count,counterBefore);
  assert.equal(intake.audit().journalHead,headBefore);
  intake.db.exec('DROP TRIGGER block_address_receipt');
  const nextAddress=`0x${'48'.repeat(20)}`;
  const changed=await accounts.beginAddressConfirmation({session:registered.session,address:nextAddress});
  const changedResponse=await assertPasskey(changed.options);
  const changedResult=await accounts.finishAddressConfirmation({session:registered.session,
    requestId:changed.requestId,response:changedResponse});
  assert.equal(changedResult.payoutAddress.toLowerCase(),nextAddress.toLowerCase());
  assert.equal(intake.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind='PASSKEY_ADDRESS'").get().n,2);
  assert.equal(intake.audit().pending,2);
  const candidate = intake.sealNextBatch({epochId:0,batchId:0});
  assert.equal(candidate.state,'CANDIDATE_UNPUBLISHED');
  assert.equal(candidate.pendingOutsideBatch,1);
  assert.equal(candidate.unaddressedOutsideBatch,1);
  assert.equal(intake.audit().pending,1);
  assert.equal(intake.audit().unaddressed,1);
  assert.equal(intake.exportUnsignedBatch(0).pendingOutsideBatch,1);
  assert.throws(() => intake.exportUnsignedManifest(), /inclusion/,
    'A partial batch must not be passed off as the complete campaign manifest.');
  await assert.rejects(() => accounts.beginAddressConfirmation({session:registered.session,
    address}), /locked/);
  const bind2 = await accounts.beginAddressConfirmation({session:registered2.session,
    address:`0x${'49'.repeat(20)}`});
  const response2 = await assertPasskey(bind2.options);
  await accounts.finishAddressConfirmation({session:registered2.session,
    requestId:bind2.requestId,response:response2});
  intake.sealNextBatch({epochId:0,batchId:1});
  const manifest = intake.exportUnsignedManifest();
  assert.equal(manifest.batches[0].entries[0].recipient,nextAddress.toLowerCase());
  assert.equal(manifest.batches[1].entries[0].recipient,`0x${'49'.repeat(20)}`);
  assert.equal(manifest.attestation,null);
  const auth = await accounts.beginAuthentication();
  const authResponse = await assertPasskey(auth.options);
  const signedIn = await accounts.finishAuthentication({requestId:auth.requestId,response:authResponse});
  assert.ok([registered.accountId,registered2.accountId].includes(signedIn.accountId));
  assert.equal(signedIn.addressLocked,true);
  accounts.signOut(registered.session);
  assert.throws(() => accounts.account(registered.session), /expired/);
  await assert.rejects(() => accounts.finishAuthentication({requestId:auth.requestId,
    response:authResponse}), /already used/);
  const wrong = await accounts.beginAuthentication();
  const wrongResponse = await assertPasskey(wrong.options);
  wrongResponse.response.clientDataJSON = registerResponse.response.clientDataJSON;
  await assert.rejects(() => accounts.finishAuthentication({requestId:wrong.requestId,
    response:wrongResponse}), /challenge|type|verify|ceremony/i);
  console.log('PASS: browser WebAuthn registration/login, replay rejection, atomic V5 payout-address audit receipts and pre-batch change, immutable batch recipient and unsigned manifest');
} finally {
  if (browser) await browser.close();
  if (intake) intake.close();
  server.close(); rmSync(folder,{recursive:true,force:true});
}
