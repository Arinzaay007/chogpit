// Private, portable recovery evidence for the ISOLATED passkey/threshold
// candidate only. This module never admits a player, posts a root, sends a
// transaction, mounts an HTTP route or authorizes a real CHOG award.
//
// A local hash chain and a backup can both be rewritten by the same operator.
// The returned checkpoint digest MUST be retained in a genuinely independent,
// access-controlled append-only system. No such system is configured here.
// The snapshot contains passkeys, sessions, addresses and verifier metadata:
// encrypt and access-control any off-host copy; never publish the SQLite file.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { link, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LateBoundCampaignIntake } from './late-bound-intake.mjs';

const SCHEMA = 'CHOGPIT_CANDIDATE_RECOVERY_V1';
const KIND = 'PASSKEY_LATE_BOUND_V5_ADDRESS_AUDIT';
const H32 = /^0x[a-f0-9]{64}$/;
const REPORT_FIELDS = ['campaignId', 'journalHead', 'journalEntries', 'openings',
  'batched', 'pending', 'unaddressed', 'batches'];
const economicStateHash = db => {
  // Address choices now have their own V5 audit entries; account creations
  // and verifier attestations can still change without an opening journal
  // entry. Anchor their PRIVATE state too; export only its hash.
  const tables = [
    ['accounts','account_id,created_at,payout_address,address_locked_at','account_id'],
    ['reviewed_persons','account_id,person_tag,issuer,evidence_hash,verified_at,expires_at','account_id'],
    ['reviewed_admission_config','campaign_id,vault,rules_hash,code_hash,start_at,end_at,issuer,confirmation_depth,halted','campaign_id'],
    ['reviewed_capacity_snapshots','epoch_id,block_number,block_hash,purchased_slots,pending_capacity,vault_balance,verified_at','epoch_id,block_number']
  ];
  const state=tables.map(([name,columns,order])=>[name,
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
      ? db.prepare(`SELECT ${columns} FROM ${name} ORDER BY ${order}`).all() : null]);
  return `0x${createHash('sha256')
    .update(`CHOGPIT_CANDIDATE_PRIVATE_STATE_V1\n${JSON.stringify(state)}`, 'utf8')
    .digest('hex')}`;
};
const digestOf = checkpoint => {
  const { digest: _omitted, ...body } = checkpoint;
  return `0x${createHash('sha256')
    .update(`${SCHEMA}\n${JSON.stringify(body)}`, 'utf8').digest('hex')}`;
};
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `0x${hash.digest('hex')}`;
}
function validated(checkpoint, trustedDigest) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)
    || checkpoint.schema !== SCHEMA || checkpoint.mainnetClaimable !== false
    || !H32.test(trustedDigest) || !H32.test(checkpoint.digest)
    || !H32.test(checkpoint.backupSha256) || !H32.test(checkpoint.journalHead)
    || !H32.test(checkpoint.economicStateSha256)
    || checkpoint.digest !== trustedDigest || digestOf(checkpoint) !== trustedDigest)
    throw new Error('Candidate checkpoint is invalid or lacks a matching independently held digest.');
  return checkpoint;
}
function compareReport(report, checkpoint) {
  if (REPORT_FIELDS.some(key => report[key] !== checkpoint[key]))
    throw new Error('Candidate journal differs from the independently held checkpoint; stop and investigate.');
}
function inspectReadOnly(file, checkpoint) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    if (db.pragma('integrity_check(1)', { simple: true }) !== 'ok'
      || db.pragma('foreign_key_check').length)
      throw new Error('Candidate snapshot failed SQLite/foreign-key integrity checks.');
    const rows = db.prepare('SELECT * FROM late_schema').all();
    const row = rows[0];
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='openings'").get()?.sql;
    if (rows.length !== 1 || row.kind !== KIND || row.campaign_id !== checkpoint.campaignId
      || row.chain_id !== 143 || row.vault.toLowerCase() !== checkpoint.vault.toLowerCase()
      || row.token.toLowerCase() !== checkpoint.token.toLowerCase()
      || row.rules_hash !== checkpoint.rulesHash
      || !ddl?.replace(/\s+/g, '').includes("modeTEXTNOTNULLCHECK(modeIN('solo','pvp','coop'))"))
      throw new Error('Candidate snapshot has an incompatible or changed campaign schema.');
    // audit() is read-only. Give it only the identity fields required to
    // recompute the journal, Merkle roots and every outstanding box inclusion.
    // Opening the backup with the normal constructor would change its WAL
    // header and defeat byte-for-byte verification of the private snapshot.
    const report = LateBoundCampaignIntake.prototype.audit.call({
      db, campaignId: checkpoint.campaignId, vault: checkpoint.vault,
      accountMethod: 'passkey' });
    compareReport(report, checkpoint);
    if (economicStateHash(db) !== checkpoint.economicStateSha256)
      throw new Error('Private candidate account/verification state differs from the checkpoint.');
    return report;
  } finally { db.close(); }
}

// Capture a coherent SQLite/WAL snapshot, audit the copy, then publish a
// no-overwrite private backup and a small pseudonym-free checkpoint. Crash
// between the two publications leaves an UNTRUSTED orphan backup, not a prize.
// Never present this operation as automatic, off-host, immutable or signed.
export async function createCandidateRecoveryPoint(intake, snapshotFile, checkpointFile) {
  if (!(intake instanceof LateBoundCampaignIntake) || !intake.db?.open
    || intake.accountMethod !== 'passkey'
    || typeof snapshotFile !== 'string' || !snapshotFile
    || typeof checkpointFile !== 'string' || !checkpointFile)
    throw new Error('An open isolated candidate journal and two new output paths are required.');
  const snapshot = path.resolve(snapshotFile), anchor = path.resolve(checkpointFile);
  if (snapshot === anchor || [intake.file, `${intake.file}-wal`, `${intake.file}-shm`]
    .includes(snapshot) || [intake.file, `${intake.file}-wal`, `${intake.file}-shm`].includes(anchor))
    throw new Error('Recovery outputs must not overwrite the live journal or each other.');
  mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(anchor), { recursive: true, mode: 0o700 });
  const tempSnapshot = `${snapshot}.${randomBytes(12).toString('hex')}.part`;
  const tempAnchor = `${anchor}.${randomBytes(12).toString('hex')}.part`;
  let snapshotPublished = false, anchorPublished = false;
  try {
    const before = intake.audit(), beforeEconomic = economicStateHash(intake.db);
    const fd = await open(tempSnapshot, 'wx', 0o600);
    await fd.close();
    // SQLite online backup includes committed WAL rows; copying just .sqlite
    // would silently lose recent passkey registrations and/or openings.
    await intake.db.backup(tempSnapshot);
    const snapshotFd = await open(tempSnapshot, 'r');
    try { await snapshotFd.sync(); } finally { await snapshotFd.close(); }
    const after = intake.audit();
    if (REPORT_FIELDS.some(key => before[key] !== after[key])
      || beforeEconomic !== economicStateHash(intake.db))
      throw new Error('Candidate intake changed during backup; retry from a stable journal.');
    const body = { schema: SCHEMA, mainnetClaimable: false, chainId: 143,
      campaignId: intake.campaignId, vault: intake.vault, token: intake.token,
      rulesHash: intake.rulesHash,
      journalHead: before.journalHead, journalEntries: before.journalEntries,
      openings: before.openings, batched: before.batched, pending: before.pending,
      unaddressed: before.unaddressed, batches: before.batches,
      economicStateSha256: beforeEconomic, backupSha256: await fileHash(tempSnapshot),
      warning: 'PRIVATE CANDIDATE BACKUP. NOT AN ELIGIBLE OPENING OR REAL-CHOG PAYOUT. External independent digest retention and reviewed recovery are still required.' };
    const checkpoint = { ...body, digest: digestOf(body) };
    inspectReadOnly(tempSnapshot, checkpoint);
    // Hard links atomically refuse existing paths even if they are symlinks.
    await link(tempSnapshot, snapshot); snapshotPublished = true;
    const checkpointFd = await open(tempAnchor, 'wx', 0o600);
    try {
      await checkpointFd.writeFile(JSON.stringify(checkpoint, null, 2) + '\n');
      await checkpointFd.sync();
    } finally { await checkpointFd.close(); }
    await link(tempAnchor, anchor); anchorPublished = true;
    return { snapshot, checkpointFile: anchor, digest: checkpoint.digest,
      journalHead: checkpoint.journalHead, openings: checkpoint.openings,
      pending: checkpoint.pending, unaddressed: checkpoint.unaddressed,
      mainnetClaimable: false };
  } catch (error) {
    if (snapshotPublished && !anchorPublished) await unlink(snapshot);
    throw error;
  } finally {
    await unlink(tempSnapshot).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(tempAnchor).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Pass the digest retrieved from a SEPARATE trusted store, never from the
// adjacent JSON itself. Without that out-of-band value this verifier refuses
// to treat the local checkpoint as an anti-rollback anchor.
export async function verifyCandidateRecoveryPoint(snapshotFile, checkpointFile, trustedDigest) {
  if (!H32.test(trustedDigest))
    throw new Error('An independently held checkpoint digest is required.');
  const checkpoint = validated(JSON.parse(await readFile(checkpointFile, 'utf8')), trustedDigest);
  if (await fileHash(snapshotFile) !== checkpoint.backupSha256)
    throw new Error('Private candidate snapshot bytes differ from the independently held checkpoint.');
  return { ...inspectReadOnly(snapshotFile, checkpoint),
    verifiedAgainstExternalDigest: true, mainnetClaimable: false };
}

// Fail closed on startup if an independently fetched latest checkpoint does
// not describe the local journal exactly. Legitimate new entries need a new
// independently retained checkpoint; never 'repair' missing openings by
// accepting an older file. This is NOT wired into a public service.
export function assertCandidateJournalAtCheckpoint(intake, checkpoint, trustedDigest) {
  if (!(intake instanceof LateBoundCampaignIntake) || !intake.db?.open
    || intake.accountMethod !== 'passkey')
    throw new Error('An open V5 passkey candidate intake is required; email recovery needs a separate versioned checkpoint.');
  validated(checkpoint, trustedDigest);
  if (checkpoint.campaignId !== intake.campaignId ||
    checkpoint.vault.toLowerCase() !== intake.vault.toLowerCase() ||
    checkpoint.token.toLowerCase() !== intake.token.toLowerCase() ||
    checkpoint.rulesHash !== intake.rulesHash)
    throw new Error('Trusted checkpoint belongs to a different campaign identity.');
  compareReport(intake.audit(), checkpoint);
  if (economicStateHash(intake.db) !== checkpoint.economicStateSha256)
    throw new Error('Private candidate account/verification state differs from the checkpoint.');
  return { journalHead: checkpoint.journalHead, verifiedAgainstExternalDigest: true,
    mainnetClaimable: false };
}
