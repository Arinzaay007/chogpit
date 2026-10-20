import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaimLedger } from '../claim-ledger.mjs';
import { manifestDigest } from '../claim-audit.mjs';

const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-audit-test-'));
const dbPath = path.join(temp, 'source.sqlite'), campaignId = 'LOCAL_TEST_AUDIT_42';
const a = `0x${'11'.repeat(20)}`, b = `0x${'22'.repeat(20)}`;
const vault = `0x${'aa'.repeat(20)}`, wrongVault = `0x${'bb'.repeat(20)}`;
let ledger;
try {
  let clock = 1_000_000;
  ledger = new ClaimLedger(dbPath, { allowLocalTests: true, now: () => ++clock });
  const preview = { runId: 'f'.repeat(32), round: 1, boxId: 0,
    wallet: a, mode: 'solo', arenaId: 'demo' };
  assert.equal(ledger.recordObservation(preview).claimable, false);
  const firstHead = ledger.auditObservations().journalHead;
  assert.equal(ledger.recordObservation(preview).duplicate, true);
  assert.equal(ledger.auditObservations().journalHead, firstHead, 'Replay does not append a second journal entry.');
  assert.deepEqual(ledger.auditObservations().issues, []);
  ledger.db.exec(`CREATE TRIGGER block_second_preview BEFORE INSERT ON audit_log
    WHEN NEW.kind='PREVIEW_OBSERVATION' BEGIN SELECT RAISE(ABORT, 'disk checkpoint failed'); END`);
  assert.throws(() => ledger.recordObservation({ ...preview, round: 2 }), /disk checkpoint failed/);
  assert.equal(ledger.observationCount(), 1, 'An audit-write failure rolls back the box observation.');
  ledger.db.exec('DROP TRIGGER block_second_preview');
  ledger.startLocalCampaign(campaignId);
  for (let i = 0; i < 42; i++) {
    ledger.recordLocalTestEvent(campaignId, { runId: 'd'.repeat(32), round: i + 1, boxId: 0,
      wallet: i % 2 ? b : a, mode: i % 3 ? 'solo' : 'pvp', arenaId: 'demo' });
  }
  assert.equal(ledger.claimEventCount(), 42);
  assert.equal(ledger.auditLocalCampaign(campaignId).pendingCount, 42);
  assert.deepEqual(ledger.auditLocalCampaign(campaignId).issues, []);
  assert.throws(() => ledger.finalizeLocalCampaign(campaignId), /unbatched events/);
  ledger.db.exec(`CREATE TRIGGER block_proof BEFORE INSERT ON proofs
    BEGIN SELECT RAISE(ABORT, 'proof storage unavailable'); END`);
  const journalBeforeFailure = ledger.auditLocalCampaign(campaignId).journalHead;
  assert.throws(() => ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault }),
    /proof storage unavailable/);
  assert.equal(ledger.auditLocalCampaign(campaignId).batchCount, 0);
  assert.equal(ledger.auditLocalCampaign(campaignId).pendingCount, 42);
  assert.equal(ledger.auditLocalCampaign(campaignId).journalHead, journalBeforeFailure,
    'A partial batch never commits a candidate root or audit checkpoint.');
  ledger.db.exec('DROP TRIGGER block_proof');
  assert.equal(ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault }).count, 40);
  assert.equal(ledger.auditLocalCampaign(campaignId).pendingCount, 2);
  assert.throws(() => ledger.finalizeLocalCampaign(campaignId), /unbatched events/);
  assert.throws(() => ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault: wrongVault }),
    /cannot silently change vault or chain/);
  assert.equal(ledger.auditLocalCampaign(campaignId).batchCount, 1);
  assert.equal(ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault }).count, 2);
  const sealed = ledger.finalizeLocalCampaign(campaignId);
  assert.equal(sealed.eventCount, 42); assert.equal(sealed.batchCount, 2);
  assert.deepEqual(sealed.manifest.batches.map(item => item.entries.length), [40, 2]);
  assert.equal(sealed.digest, manifestDigest(sealed.manifest));
  assert.equal(sealed.manifest.events.length, 42);
  assert.ok(sealed.manifest.events.every(item => item.provenance === 'LOCAL_TEST_ONLY'));
  assert.ok(sealed.manifest.events.every(item => item.runId !== preview.runId),
    'A preview observation is never part of a mock-claim manifest.');
  assert.deepEqual(ledger.auditLocalCampaign(campaignId).issues, []);
  assert.equal(ledger.getLocalProofsForWallet({ campaignId, wallet: a, sessionAccount: a }).length, 21);
  assert.equal(ledger.getLocalProofsForWallet({ campaignId, wallet: b, sessionAccount: b }).length, 21);
  assert.throws(() => ledger.getLocalProofsForWallet({ campaignId, wallet: b, sessionAccount: a }),
    /another wallet/);
  assert.throws(() => ledger.recordLocalTestEvent(campaignId,
    { runId: 'e'.repeat(32), round: 1, boxId: 0, wallet: a, mode: 'solo', arenaId: 'demo' }),
  /not accepting events/);

  const cli = (...args) => spawnSync(process.execPath,
    ['scripts/audit_claim_journal.mjs', dbPath, ...args], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  const status = cli('--campaign', campaignId);
  assert.equal(status.status, 0, status.stderr);
  const summary = JSON.parse(status.stdout);
  assert.equal(summary.mainnetClaimable, false);
  assert.equal(summary.issueCount, 0);
  assert.equal(summary.campaigns[0].manifestDigest, sealed.digest);
  assert.ok(!status.stdout.includes(a), 'Default audit output must not expose wallet addresses.');
  const exportFile = path.join(temp, 'external-manifest.json');
  const exported = cli('--campaign', campaignId, '--export', exportFile);
  assert.equal(exported.status, 0, exported.stderr);
  const certificate = JSON.parse(await readFile(exportFile, 'utf8'));
  assert.equal(certificate.digest, sealed.digest);
  assert.equal(certificate.mainnetClaimable, false);
  assert.equal(manifestDigest(certificate.manifest), sealed.digest);
  assert.equal((await stat(exportFile)).mode & 0o777, 0o600);
  assert.notEqual(cli('--campaign', campaignId, '--export', exportFile).status, 0,
    'Audit export cannot overwrite an external checkpoint.');

  assert.ok((await stat(`${dbPath}-wal`)).size > 0,
    'The source still has uncheckpointed WAL data before the online backup.');
  const snapshotFile = path.join(temp, 'snapshot.sqlite');
  const snapshot = await ledger.snapshotTo(snapshotFile);
  assert.equal(snapshot.observationCount, 1);
  assert.equal(snapshot.unattestedLegacyCount, 0);
  assert.equal(snapshot.localCampaigns, 1);
  assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600);
  await assert.rejects(() => ledger.snapshotTo(snapshotFile), /EEXIST/);
  await assert.rejects(() => ledger.snapshotTo(dbPath), /Cannot overwrite/);
  const backedUp = spawnSync(process.execPath,
    ['scripts/backup_claim_journal.mjs', dbPath, path.join(temp, 'manual-backup.sqlite')],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(backedUp.status, 0, backedUp.stderr);
  assert.equal(JSON.parse(backedUp.stdout).mainnetClaimable, false);
  const missingSource = path.join(temp, 'does-not-exist.sqlite');
  assert.notEqual(spawnSync(process.execPath,
    ['scripts/backup_claim_journal.mjs', missingSource, path.join(temp, 'unexpected.sqlite')],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' }).status, 0);
  await assert.rejects(() => stat(missingSource), /ENOENT/);
  const recovered = new ClaimLedger(snapshotFile, { allowLocalTests: true });
  assert.equal(recovered.auditLocalCampaign(campaignId).digest, sealed.digest);
  assert.deepEqual(recovered.auditLocalCampaign(campaignId).issues, []);
  assert.equal(recovered.auditLocalCampaign(campaignId).eventCount, 42);
  assert.equal(recovered.getLocalProofsForWallet({ campaignId, wallet: a, sessionAccount: a }).length, 21);
  assert.throws(() => recovered.db.prepare('UPDATE audit_log SET digest=? WHERE seq=1').run(`0x${'1'.repeat(64)}`),
    /append-only/);
  assert.throws(() => recovered.db.prepare('DELETE FROM audit_log WHERE seq=1').run(), /append-only/);
  const changed = recovered.db.prepare('SELECT event_id FROM claim_events WHERE campaign_id=? LIMIT 1').get(campaignId).event_id;
  recovered.db.prepare('UPDATE claim_events SET wallet=? WHERE event_id=?').run(b, changed);
  assert.ok(recovered.auditLocalCampaign(campaignId).issues.some(issue => /altered in intake journal/.test(issue)));
  assert.throws(() => recovered.getLocalProofsForWallet({ campaignId, wallet: a, sessionAccount: a }),
    /finalized, reconciled/);
  const originalWallet = sealed.manifest.events.find(item => item.eventId === changed).wallet;
  recovered.db.prepare('UPDATE claim_events SET wallet=? WHERE event_id=?').run(originalWallet, changed);
  assert.deepEqual(recovered.auditLocalCampaign(campaignId).issues, []);
  recovered.db.exec('DROP TRIGGER audit_log_no_update');
  recovered.db.prepare('UPDATE audit_log SET digest=? WHERE seq=1').run(`0x${'1'.repeat(64)}`);
  recovered.close();
  assert.throws(() => new ClaimLedger(snapshotFile), /integrity\/schema check/,
    'A tampered audit chain refuses to reopen.');

  // Legacy version-one-style rows are explicitly marked unattested, never
  // backfilled into claims or silently treated as verified.
  const legacyFile = path.join(temp, 'legacy.sqlite');
  const legacy = new ClaimLedger(legacyFile);
  legacy.recordObservation(preview);
  legacy.db.exec('DROP TRIGGER audit_log_no_delete; DELETE FROM audit_log;');
  legacy.close();
  const migrated = new ClaimLedger(legacyFile);
  assert.equal(migrated.auditObservations().unattestedLegacyCount, 1);
  assert.equal(migrated.auditObservations().claimable, false);
  assert.equal(migrated.claimEventCount(), 0);
  assert.equal(migrated.recordObservation({ ...preview, round: 2 }).claimable, false);
  assert.equal(migrated.auditObservations().unattestedLegacyCount, 1);
  assert.equal(migrated.auditObservations().observationCount, 2);
  assert.equal((await migrated.snapshotTo(path.join(temp, 'legacy-backup.sqlite'))).unattestedLegacyCount, 1);
  migrated.close();
  const flagged = spawnSync(process.execPath, ['scripts/audit_claim_journal.mjs', legacyFile],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(flagged.status, 2, 'Read-only audit must flag unjournaled legacy observations.');
  assert.equal(JSON.parse(flagged.stdout).unattestedLegacyObservations, 1);
  console.log('PASS: append-only local audit checkpoints, 40+2 complete inclusion, crash-atomic batch, portable WAL backup, external manifest, tamper/legacy detection');
} finally {
  if (ledger?.db.open) ledger.close();
  await rm(temp, { recursive: true, force: true });
}
