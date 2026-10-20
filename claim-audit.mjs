// Local mock-claim inclusion and journal checks. A self-contained SQLite hash
// chain detects accidents, not a malicious database owner who can rewrite all
// rows. Keep exported checkpoints OUTSIDE the game server for external review.
import { createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { candidateClaimBatch } from './claim-kit.mjs';

export const JOURNAL_GENESIS = `0x${'0'.repeat(64)}`;
const TYPES = new Set(['PREVIEW_OBSERVATION', 'LOCAL_CAMPAIGN_OPENED',
  'LOCAL_EVENT', 'LOCAL_BATCH', 'LOCAL_CAMPAIGN_SEALED']);
const sha = text => `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const digestFor = (seq, previous, kind, ref, payload) =>
  sha(`CHOGPIT_JOURNAL_V1\n${seq}\n${previous}\n${kind}\n${ref}\n${payload}`);
export const manifestDigest = manifest => sha(`CHOGPIT_LOCAL_TEST_MANIFEST_V1\n${JSON.stringify(manifest)}`);
export const logObservation = row => ({ eventKey: row.event_key, runId: row.run_id, round: row.round,
  boxId: row.box_id, wallet: row.wallet, mode: row.mode, arenaId: row.arena_id,
  openedAt: row.opened_at, provenance: row.provenance });
export const logLocalEvent = row => ({ eventId: row.event_id, campaignId: row.campaign_id,
  runId: row.run_id, round: row.round, boxId: row.box_id, wallet: row.wallet,
  mode: row.mode, arenaId: row.arena_id, openedAt: row.opened_at, provenance: row.provenance });
export const logBatch = (row, entries) => ({ campaignId: row.campaign_id, batchId: row.batch_id,
  chainId: row.chain_id, vault: row.vault, root: row.root, entryCount: row.entry_count,
  createdAt: row.created_at, status: row.status,
  entries: entries.map(item => ({ eventId: item.event_id, recipient: item.wallet, index: item.position })) });

// Call inside the SAME SQLite write transaction as the event or batch mutation.
export function appendJournal(db, kind, ref, payload) {
  if (!TYPES.has(kind) || typeof ref !== 'string' || !ref || !payload || typeof payload !== 'object')
    throw new Error('Invalid local audit journal entry.');
  const last = db.prepare('SELECT seq,digest FROM audit_log ORDER BY seq DESC LIMIT 1').get();
  const seq = last ? last.seq + 1 : 1, previous = last?.digest ?? JOURNAL_GENESIS;
  const json = JSON.stringify(payload), digest = digestFor(seq, previous, kind, ref, json);
  db.prepare('INSERT INTO audit_log(seq,kind,ref,payload_json,previous_digest,digest) VALUES(?,?,?,?,?,?)')
    .run(seq, kind, ref, json, previous, digest);
  return { seq, digest };
}

export function inspectJournal(db, { includeEntries = true } = {}) {
  const issues = [], entries = includeEntries ? [] : null;
  let previous = JOURNAL_GENESIS, seq = 0;
  for (const row of db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
    seq++;
    if (row.seq !== seq) issues.push(`Journal sequence gap at ${seq}.`);
    if (!TYPES.has(row.kind)) issues.push(`Unknown journal entry at ${seq}.`);
    if (row.previous_digest !== previous || row.digest !== digestFor(row.seq,
      row.previous_digest, row.kind, row.ref, row.payload_json)) {
      issues.push(`Journal digest mismatch at ${seq}.`);
    }
    try {
      const parsed = JSON.parse(row.payload_json);
      if (!parsed || typeof parsed !== 'object' || JSON.stringify(parsed) !== row.payload_json)
        issues.push(`Invalid journal payload at ${seq}.`);
    } catch { issues.push(`Invalid journal JSON at ${seq}.`); }
    previous = row.digest;
    if (entries) entries.push(row);
  }
  return { count: seq, head: previous, issues, entries };
}

// Report only: missing preview records are NEVER backfilled or awarded CHOG.
// Older version-one observations may have no journal row; they remain legacy,
// explicitly unaudited/non-eligible, never silently promoted.
export function inspectObservations(db, journal = inspectJournal(db)) {
  const issues = [...journal.issues];
  const source = db.prepare('SELECT * FROM observations ORDER BY event_key').all();
  const logs = new Map(journal.entries.filter(row => row.kind === 'PREVIEW_OBSERVATION')
    .map(row => [row.ref, row]));
  let unattested = 0;
  for (const item of source) {
    const log = logs.get(item.event_key);
    if (!log) { unattested++; issues.push(`Unattested preview observation: ${item.event_key}`); }
    else if (log.payload_json !== JSON.stringify(logObservation(item)))
      issues.push(`Preview observation changed after journaling: ${item.event_key}`);
    logs.delete(item.event_key);
  }
  for (const ref of logs.keys()) issues.push(`Journaled preview observation disappeared: ${ref}`);
  return { observationCount: source.length, unattestedLegacyCount: unattested,
    journalHead: journal.head, issues, claimable: false };
}

export function inspectLocalCampaign(db, campaignId, { complete = false } = {}) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE campaign_id=?').get(campaignId);
  if (!campaign || campaign.category !== 'LOCAL_TEST_ONLY') throw new Error('Unknown LOCAL_TEST campaign.');
  const journal = inspectJournal(db), issues = [...journal.issues];
  const rows = db.prepare('SELECT * FROM claim_events WHERE campaign_id=? ORDER BY opened_at,event_id').all(campaignId);
  const batches = db.prepare('SELECT * FROM batches WHERE campaign_id=? ORDER BY batch_id').all(campaignId);
  const proofs = db.prepare('SELECT p.* FROM proofs p WHERE p.campaign_id=? ORDER BY p.batch_id,p.position').all(campaignId);
  const eventLogs = new Map(journal.entries.filter(row => row.kind === 'LOCAL_EVENT' &&
    row.payload_json.includes(`"campaignId":"${campaignId}"`)).map(row => [row.ref, row]));
  const batchLogs = new Map(journal.entries.filter(row => row.kind === 'LOCAL_BATCH' &&
    row.payload_json.includes(`"campaignId":"${campaignId}"`)).map(row => [row.ref, row]));
  const opened = journal.entries.find(row => row.kind === 'LOCAL_CAMPAIGN_OPENED' && row.ref === campaignId);
  if (!opened || opened.payload_json !== JSON.stringify({ campaignId, createdAt: campaign.created_at,
    category: campaign.category })) issues.push('Campaign creation is not journaled or changed.');
  let pending = 0;
  for (const row of rows) {
    const expected = keccak256(toHex(`CHOGPIT.LOCAL_TEST_ONLY|${campaignId}|staging:${row.run_id}:${row.round}:${row.box_id}`));
    if (row.event_id !== expected || row.provenance !== 'LOCAL_TEST_ONLY')
      issues.push(`Invalid sandbox event origin: ${row.event_id}`);
    const log = eventLogs.get(row.event_id);
    if (!log || log.payload_json !== JSON.stringify(logLocalEvent(row)))
      issues.push(`Local event missing/altered in intake journal: ${row.event_id}`);
    eventLogs.delete(row.event_id);
    if (row.batch_id == null) {
      pending++;
      if (row.position != null) issues.push(`Pending event has a batch position: ${row.event_id}`);
    } else if (!Number.isInteger(row.position) || row.position < 0 || row.position >= 40)
      issues.push(`Batched event has an invalid position: ${row.event_id}`);
  }
  for (const id of eventLogs.keys()) issues.push(`Journaled sandbox event disappeared: ${id}`);
  if (complete && (!rows.length || pending)) issues.push('Campaign cannot be finalized with zero or unbatched events.');
  if (batches.length && !rows.length) issues.push('Batches exist without intake events.');

  const manifestBatches = [], seenProofs = new Set();
  let vault = null, chainId = null;
  for (const batch of batches) {
    if (batch.batch_id !== manifestBatches.length) issues.push(`Noncontiguous batch ID: ${batch.batch_id}`);
    if (vault && (vault.toLowerCase() !== String(batch.vault).toLowerCase() || chainId !== batch.chain_id))
      issues.push(`Campaign changed vault/chain in batch ${batch.batch_id}.`);
    vault = batch.vault; chainId = batch.chain_id;
    const members = rows.filter(row => row.batch_id === batch.batch_id)
      .sort((a, b) => a.position - b.position);
    if (batch.entry_count !== members.length || !members.length || members.length > 40
      || members.some((item, i) => item.position !== i))
      issues.push(`Batch ${batch.batch_id} omits, duplicates or misorders events.`);
    const log = batchLogs.get(`${campaignId}:${batch.batch_id}`);
    if (!log || log.payload_json !== JSON.stringify(logBatch(batch, members)))
      issues.push(`Batch ${batch.batch_id} differs from its journal checkpoint.`);
    batchLogs.delete(`${campaignId}:${batch.batch_id}`);
    try {
      const computed = candidateClaimBatch({ chainId: batch.chain_id, vault: batch.vault,
        batchId: batch.batch_id, entries: members.map(item => ({ eventId: item.event_id,
          recipient: item.wallet })) });
      if (computed.root !== batch.root || batch.status !== 'CANDIDATE_UNPUBLISHED')
        issues.push(`Batch ${batch.batch_id} has an incorrect root/status.`);
      for (let i = 0; i < members.length; i++) {
        const entry = members[i], stored = proofs.find(p => p.event_id === entry.event_id);
        if (!stored || stored.campaign_id !== campaignId || stored.batch_id !== batch.batch_id
          || stored.position !== i || stored.root !== batch.root
          || stored.proof_json !== JSON.stringify(computed.entries[i].proof)) {
          issues.push(`Missing or altered proof: ${entry.event_id}`);
        } else seenProofs.add(stored.event_id);
      }
    } catch (error) { issues.push(`Batch ${batch.batch_id} cannot be reconstructed: ${error.message}`); }
    manifestBatches.push({ batchId: batch.batch_id, chainId: batch.chain_id,
      vault: batch.vault, root: batch.root, status: batch.status,
      entries: members.map(e => ({ index: e.position, eventId: e.event_id, recipient: e.wallet })) });
  }
  for (const key of batchLogs.keys()) issues.push(`Journaled candidate batch disappeared: ${key}`);
  for (const proof of proofs) if (!seenProofs.has(proof.event_id)) issues.push(`Orphaned/altered proof: ${proof.event_id}`);
  for (const row of rows) if (row.batch_id != null && !batches.some(b => b.batch_id === row.batch_id))
    issues.push(`Event points to a missing batch: ${row.event_id}`);
  const manifest = { format: 'CHOGPIT_LOCAL_TEST_MANIFEST_V1', campaignId,
    provenance: 'LOCAL_TEST_ONLY_NOT_MAINNET',
    events: rows.map(e => logLocalEvent(e)), batches: manifestBatches };
  const digest = manifestDigest(manifest);
  const seal = db.prepare('SELECT * FROM campaign_seals WHERE campaign_id=?').get(campaignId);
  const sealLog = journal.entries.find(row => row.kind === 'LOCAL_CAMPAIGN_SEALED' && row.ref === campaignId);
  if (campaign.state === 'sealed') {
    if (!seal || seal.digest !== digest || seal.event_count !== rows.length || seal.batch_count !== batches.length)
      issues.push('Finalized campaign seal differs from its current source/manifest.');
    if (!sealLog || sealLog.payload_json !== JSON.stringify({ campaignId, digest: seal?.digest,
      eventCount: seal?.event_count, batchCount: seal?.batch_count, sealedAt: seal?.sealed_at }))
      issues.push('Finalized campaign seal is absent/altered in the journal.');
    if (pending) issues.push('Finalized campaign contains unbatched events.');
  } else if (seal || sealLog) issues.push('Collecting campaign has an unexpected final seal.');
  return { campaignId, state: campaign.state, eventCount: rows.length, pendingCount: pending,
    batchCount: batches.length, observationEntriesIncluded: 0, issues, digest,
    journalHead: journal.head, manifest, mainnetClaimable: false };
}
