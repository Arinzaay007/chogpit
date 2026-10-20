// Isolated SQLite journal for claim-flow engineering. Public game openings are
// observations only: they never become claim_events, proofs or CHOG entitlements.
// Only an explicitly constructed LOCAL TEST instance may create sandbox claims.
// Future real campaigns require a separately reviewed activation design.
import { chmodSync, mkdirSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { encodeAbiParameters, getAddress, keccak256, toHex, verifyMessage } from 'viem';
import { candidateClaimBatch, pairHash } from './claim-kit.mjs';
import { appendJournal, inspectJournal, inspectObservations, inspectLocalCampaign,
  logObservation, logLocalEvent, logBatch } from './claim-audit.mjs';

const RUN_ID = /^[a-f0-9]{32}$/;
const MODE = new Set(['solo', 'pvp']);
const CAMPAIGN = /^LOCAL_TEST_[A-Z0-9_-]{4,64}$/;
const SPOT = Number.isInteger;
const normalize = address => getAddress(address).toLowerCase();
const observationKey = ({ runId, round, boxId }) => `staging:${runId}:${round}:${boxId}`;

export class ClaimLedger {
  constructor(file, { allowLocalTests = false, mustExist = false, now = () => Date.now() } = {}) {
    if (!file || file === ':memory:') throw new Error('A durable SQLite file is required.');
    this.file = path.resolve(file); this.allowLocalTests = allowLocalTests; this.now = now;
    if (!mustExist) mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file, { timeout: 5000, fileMustExist: mustExist });
    chmodSync(this.file, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_info(version INTEGER NOT NULL CHECK(version = 1));
      INSERT INTO schema_info(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_info);
      CREATE TABLE IF NOT EXISTS observations(
        event_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
        box_id INTEGER NOT NULL, wallet TEXT, mode TEXT NOT NULL,
        arena_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
        provenance TEXT NOT NULL CHECK(provenance = 'NON_ELIGIBLE_PREVIEW'),
        UNIQUE(run_id, round, box_id)
      );
      CREATE TABLE IF NOT EXISTS campaigns(
        campaign_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('collecting','sealed')),
        category TEXT NOT NULL CHECK(category = 'LOCAL_TEST_ONLY'), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_events(
        event_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
        run_id TEXT NOT NULL, round INTEGER NOT NULL, box_id INTEGER NOT NULL,
        wallet TEXT NOT NULL, mode TEXT NOT NULL, arena_id TEXT NOT NULL,
        opened_at INTEGER NOT NULL, batch_id INTEGER, position INTEGER,
        provenance TEXT NOT NULL CHECK(provenance = 'LOCAL_TEST_ONLY'),
        UNIQUE(campaign_id, run_id, round, box_id)
      );
      CREATE TABLE IF NOT EXISTS batches(
        campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id), batch_id INTEGER NOT NULL,
        chain_id INTEGER NOT NULL, vault TEXT NOT NULL, root TEXT NOT NULL,
        entry_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status = 'CANDIDATE_UNPUBLISHED'),
        PRIMARY KEY(campaign_id, batch_id)
      );
      CREATE TABLE IF NOT EXISTS proofs(
        event_id TEXT PRIMARY KEY REFERENCES claim_events(event_id),
        campaign_id TEXT NOT NULL, batch_id INTEGER NOT NULL, position INTEGER NOT NULL,
        root TEXT NOT NULL, proof_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claim_events_available ON claim_events(campaign_id, batch_id, opened_at);
      CREATE INDEX IF NOT EXISTS idx_claim_events_wallet ON claim_events(campaign_id, wallet);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_events_global_opening
        ON claim_events(run_id, round, box_id);
      -- Additive audit extension. Old preview rows are NOT retroactively
      -- authenticated; inspectObservations reports them as unattested legacy.
      CREATE TABLE IF NOT EXISTS audit_log(
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL,
        payload_json TEXT NOT NULL, previous_digest TEXT NOT NULL, digest TEXT NOT NULL,
        UNIQUE(kind, ref)
      );
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'Audit entries are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'Audit entries are append-only'); END;
      CREATE TABLE IF NOT EXISTS campaign_seals(
        campaign_id TEXT PRIMARY KEY REFERENCES campaigns(campaign_id),
        digest TEXT NOT NULL, event_count INTEGER NOT NULL, batch_count INTEGER NOT NULL,
        sealed_at INTEGER NOT NULL
      );
    `);
    const journal = inspectJournal(this.db, { includeEntries: false });
    if (this.db.prepare('SELECT COUNT(*) AS n FROM schema_info WHERE version = 1').get().n !== 1
      || this.db.pragma('quick_check(1)', { simple: true }) !== 'ok' || journal.issues.length) {
      this.db.close(); throw new Error('Claim journal failed integrity/schema check; never reset it silently.');
    }
  }
  close() { this.db.close(); }
  #opening({ runId, round, boxId, wallet, mode, arenaId }) {
    if (!RUN_ID.test(runId) || !SPOT(round) || round < 1 || round > 999999
      || !SPOT(boxId) || boxId < 0 || boxId > 3
      || !MODE.has(mode) || typeof arenaId !== 'string' || !/^(demo|\d{1,7})$/.test(arenaId)) {
      throw new Error('Invalid server-originated box opening.');
    }
    return { runId, round, boxId, wallet: wallet == null ? null : normalize(wallet), mode, arenaId };
  }
  recordObservation(opening) {
    const data = this.#opening(opening), key = observationKey(data);
    const transaction = this.db.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM claim_events WHERE run_id=? AND round=? AND box_id=? LIMIT 1`)
        .get(data.runId, data.round, data.boxId))
        throw new Error('A sandbox claim event cannot be relabeled as a preview observation.');
      const old = this.db.prepare('SELECT * FROM observations WHERE event_key = ?').get(key);
      if (old) {
        if (old.wallet !== data.wallet || old.mode !== data.mode || old.arena_id !== data.arenaId)
          throw new Error('Conflicting duplicate observation.');
        return { eventKey: key, duplicate: true, claimable: false };
      }
      this.db.prepare(`INSERT INTO observations(event_key,run_id,round,box_id,wallet,mode,arena_id,opened_at,provenance)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(key, data.runId, data.round, data.boxId, data.wallet,
        data.mode, data.arenaId, this.now(), 'NON_ELIGIBLE_PREVIEW');
      const row = this.db.prepare('SELECT * FROM observations WHERE event_key=?').get(key);
      appendJournal(this.db, 'PREVIEW_OBSERVATION', key, logObservation(row));
      return { eventKey: key, duplicate: false, claimable: false };
    });
    return transaction();
  }
  observationCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n; }
  claimEventCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM claim_events').get().n; }
  auditObservations() { return inspectObservations(this.db); }
  auditLocalCampaign(campaignId) {
    this.#sandbox();
    if (!CAMPAIGN.test(campaignId)) throw new Error('Invalid LOCAL_TEST campaign.');
    return inspectLocalCampaign(this.db, campaignId);
  }
  // SQLite's online backup API copies a coherent WAL snapshot, unlike copying
  // only the .sqlite file. It never overwrites an existing destination.
  async snapshotTo(destination) {
    if (!destination || typeof destination !== 'string') throw new Error('Choose a snapshot file.');
    const output = path.resolve(destination);
    if (output === this.file || output === ':memory:') throw new Error('Cannot overwrite the live claim journal.');
    mkdirSync(path.dirname(output), { recursive: true });
    const temp = `${output}.${randomBytes(12).toString('hex')}.part`;
    let copy;
    try {
      // Ensure wallet-bearing snapshot bytes are never temporarily world-readable.
      const protectedFile = await open(temp, 'wx', 0o600);
      await protectedFile.close();
      await this.db.backup(temp);
      chmodSync(temp, 0o600);
      copy = new Database(temp, { fileMustExist: true });
      copy.pragma('journal_mode = DELETE'); // checkpoint the snapshot into one portable file
      copy.pragma('foreign_keys = ON');
      const journal = inspectJournal(copy);
      if (copy.pragma('quick_check(1)', { simple: true }) !== 'ok' || journal.issues.length)
        throw new Error('Snapshot failed SQLite/journal integrity verification.');
      const observationReport = inspectObservations(copy, journal);
      const campaigns = copy.prepare('SELECT campaign_id FROM campaigns ORDER BY campaign_id').all();
      const campaignReports = campaigns.map(({ campaign_id }) => inspectLocalCampaign(copy, campaign_id));
      if (campaignReports.some(report => report.issues.length))
        throw new Error('Snapshot contains an unreconciled LOCAL_TEST campaign.');
      copy.close(); copy = null;
      await link(temp, output); // atomic no-overwrite publication on the same filesystem
      return { path: output, journalHead: journal.head, journalEntries: journal.count,
        observationCount: observationReport.observationCount,
        unattestedLegacyCount: observationReport.unattestedLegacyCount,
        localCampaigns: campaignReports.length, mainnetClaimable: false };
    } finally {
      if (copy?.open) copy.close();
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  #sandbox() {
    if (!this.allowLocalTests) throw new Error('Sandbox claim writes are not available in the hosted game.');
  }
  startLocalCampaign(campaignId) {
    this.#sandbox();
    if (!CAMPAIGN.test(campaignId)) throw new Error('Only LOCAL_TEST campaigns are supported.');
    this.db.transaction(() => {
      const createdAt = this.now();
      this.db.prepare(`INSERT INTO campaigns(campaign_id,state,category,created_at) VALUES(?,?,?,?)`)
        .run(campaignId, 'collecting', 'LOCAL_TEST_ONLY', createdAt);
      appendJournal(this.db, 'LOCAL_CAMPAIGN_OPENED', campaignId,
        { campaignId, createdAt, category: 'LOCAL_TEST_ONLY' });
    })();
  }
  recordLocalTestEvent(campaignId, opening) {
    this.#sandbox();
    if (!CAMPAIGN.test(campaignId)) throw new Error('Invalid LOCAL_TEST campaign.');
    const data = this.#opening(opening);
    if (!data.wallet) throw new Error('A verified recipient wallet is required for a local test claim.');
    const eventId = keccak256(toHex(`CHOGPIT.LOCAL_TEST_ONLY|${campaignId}|${observationKey(data)}`));
    const transaction = this.db.transaction(() => {
      const campaign = this.db.prepare('SELECT state FROM campaigns WHERE campaign_id = ?').get(campaignId);
      if (campaign?.state !== 'collecting') throw new Error('Local test campaign is not accepting events.');
      // Never turn a preview opening into a claim, or replay one box under
      // another local test campaign's distinct event-ID domain.
      if (this.db.prepare('SELECT 1 FROM observations WHERE event_key = ?').get(observationKey(data)))
        throw new Error('A preview opening cannot be imported into a claim campaign.');
      const prior = this.db.prepare(`SELECT campaign_id FROM claim_events
        WHERE run_id=? AND round=? AND box_id=?`).get(data.runId, data.round, data.boxId);
      if (prior && prior.campaign_id !== campaignId)
        throw new Error('A box opening cannot be replayed in another campaign.');
      const old = this.db.prepare('SELECT wallet,mode,arena_id FROM claim_events WHERE event_id = ?').get(eventId);
      if (old) {
        if (old.wallet !== data.wallet || old.mode !== data.mode || old.arena_id !== data.arenaId)
          throw new Error('Conflicting duplicate sandbox event.');
        return { eventId, duplicate: true, realClaim: false };
      }
      this.db.prepare(`INSERT INTO claim_events(event_id,campaign_id,run_id,round,box_id,wallet,mode,arena_id,opened_at,provenance)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(eventId, campaignId, data.runId, data.round, data.boxId,
        data.wallet, data.mode, data.arenaId, this.now(), 'LOCAL_TEST_ONLY');
      const row = this.db.prepare('SELECT * FROM claim_events WHERE event_id=?').get(eventId);
      appendJournal(this.db, 'LOCAL_EVENT', eventId, logLocalEvent(row));
      return { eventId, duplicate: false, realClaim: false };
    });
    return transaction();
  }
  sealLocalCandidateBatch({ campaignId, chainId, vault }) {
    this.#sandbox();
    if (!CAMPAIGN.test(campaignId)) throw new Error('Invalid LOCAL_TEST campaign.');
    const transaction = this.db.transaction(() => {
      const campaign = this.db.prepare('SELECT state FROM campaigns WHERE campaign_id = ?').get(campaignId);
      if (campaign?.state !== 'collecting') throw new Error('Local test campaign is not collecting.');
      const before = inspectLocalCampaign(this.db, campaignId);
      if (before.issues.length) throw new Error(`Local campaign reconciliation failed: ${before.issues[0]}`);
      const pending = this.db.prepare(`SELECT event_id,wallet FROM claim_events
        WHERE campaign_id = ? AND batch_id IS NULL ORDER BY opened_at,event_id LIMIT 40`).all(campaignId);
      if (!pending.length) throw new Error('No fresh local-test events are waiting for a batch.');
      const last = this.db.prepare(`SELECT batch_id,chain_id,vault FROM batches
        WHERE campaign_id=? ORDER BY batch_id DESC LIMIT 1`).get(campaignId);
      const batchId = last ? last.batch_id + 1 : 0;
      const batch = candidateClaimBatch({ chainId, vault, batchId,
        entries: pending.map(item => ({ eventId: item.event_id, recipient: item.wallet })) });
      if (last && (last.chain_id !== chainId || last.vault.toLowerCase() !== batch.vault.toLowerCase()))
        throw new Error('A local campaign cannot silently change vault or chain.');
      this.db.prepare(`INSERT INTO batches(campaign_id,batch_id,chain_id,vault,root,entry_count,created_at,status)
        VALUES(?,?,?,?,?,?,?,?)`).run(campaignId, batchId, chainId, batch.vault,
        batch.root, batch.entries.length, this.now(), 'CANDIDATE_UNPUBLISHED');
      const update = this.db.prepare('UPDATE claim_events SET batch_id = ?, position = ? WHERE event_id = ? AND batch_id IS NULL');
      const proof = this.db.prepare(`INSERT INTO proofs(event_id,campaign_id,batch_id,position,root,proof_json)
        VALUES(?,?,?,?,?,?)`);
      for (const entry of batch.entries) {
        if (update.run(batchId, entry.index, entry.eventId).changes !== 1) throw new Error('Event was already batched.');
        proof.run(entry.eventId, campaignId, batchId, entry.index, batch.root, JSON.stringify(entry.proof));
      }
      const stored = this.db.prepare('SELECT * FROM batches WHERE campaign_id=? AND batch_id=?')
        .get(campaignId, batchId);
      const members = this.db.prepare(`SELECT event_id,wallet,position FROM claim_events
        WHERE campaign_id=? AND batch_id=? ORDER BY position`).all(campaignId, batchId);
      appendJournal(this.db, 'LOCAL_BATCH', `${campaignId}:${batchId}`, logBatch(stored, members));
      const after = inspectLocalCampaign(this.db, campaignId);
      if (after.issues.length) throw new Error(`Candidate batch reconciliation failed: ${after.issues[0]}`);
      return { campaignId, batchId, root: batch.root, count: batch.entries.length,
        vault: batch.vault, chainId, status: 'CANDIDATE_UNPUBLISHED' };
    });
    return transaction();
  }
  finalizeLocalCampaign(campaignId) {
    this.#sandbox();
    if (!CAMPAIGN.test(campaignId)) throw new Error('Invalid LOCAL_TEST campaign.');
    return this.db.transaction(() => {
      const before = inspectLocalCampaign(this.db, campaignId, { complete: true });
      if (before.state !== 'collecting' || before.issues.length)
        throw new Error(`Cannot finalize LOCAL_TEST campaign: ${before.issues[0] || 'already finalized'}`);
      const sealedAt = this.now();
      if (this.db.prepare(`UPDATE campaigns SET state='sealed' WHERE campaign_id=? AND state='collecting'`)
        .run(campaignId).changes !== 1) throw new Error('Campaign state changed during finalization.');
      this.db.prepare(`INSERT INTO campaign_seals(campaign_id,digest,event_count,batch_count,sealed_at)
        VALUES(?,?,?,?,?)`).run(campaignId, before.digest, before.eventCount, before.batchCount, sealedAt);
      appendJournal(this.db, 'LOCAL_CAMPAIGN_SEALED', campaignId,
        { campaignId, digest: before.digest, eventCount: before.eventCount,
          batchCount: before.batchCount, sealedAt });
      const after = inspectLocalCampaign(this.db, campaignId, { complete: true });
      if (after.issues.length || after.digest !== before.digest)
        throw new Error(`Campaign seal reconciliation failed: ${after.issues[0] || 'digest changed'}`);
      return { campaignId, manifest: after.manifest, digest: after.digest,
        eventCount: after.eventCount, batchCount: after.batchCount,
        journalHead: after.journalHead, mainnetClaimable: false };
    })();
  }
  getLocalProofsForWallet({ campaignId, wallet, sessionAccount }) {
    this.#sandbox();
    if (!CAMPAIGN.test(campaignId) || !sessionAccount) throw new Error('Signed wallet session required.');
    const inspection = inspectLocalCampaign(this.db, campaignId, { complete: true });
    if (inspection.state !== 'sealed' || inspection.issues.length)
      throw new Error(`Local test proofs require a finalized, reconciled campaign: ${inspection.issues[0] || 'not finalized'}`);
    const address = normalize(wallet);
    if (normalize(sessionAccount) !== address) throw new Error('Cannot read another wallet’s claim proofs.');
    return this.db.prepare(`SELECT e.event_id,p.batch_id,p.position,p.root,p.proof_json,
        b.root AS batch_root,b.vault,b.chain_id
      FROM claim_events e JOIN proofs p ON p.event_id=e.event_id
      JOIN batches b ON b.campaign_id=e.campaign_id AND b.batch_id=p.batch_id
      WHERE e.campaign_id=? AND e.wallet=? ORDER BY p.batch_id,p.position`).all(campaignId, address)
      .map(row => {
        const proof = JSON.parse(row.proof_json);
        const leaf = keccak256(encodeAbiParameters([
          { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
          { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }
        ], [BigInt(row.chain_id), getAddress(row.vault), BigInt(row.batch_id),
          BigInt(row.position), getAddress(address), row.event_id]));
        if (!Array.isArray(proof) || proof.reduce(pairHash, leaf) !== row.root
          || row.root !== row.batch_root) throw new Error('Stored local-test Merkle proof integrity mismatch.');
        return { batchId: row.batch_id, index: row.position, recipient: address,
          eventId: row.event_id, root: row.root, proof,
          vault: row.vault, chainId: row.chain_id, status: 'LOCAL_TEST_ONLY' };
      });
  }
}

// Isolated LOCAL-TEST signing domain. These sessions never reuse the preview
// balance login, and are NOT real-campaign authorization. EOA-only test helper.
export class LocalClaimSessions {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now; this.challenges = new Map(); this.sessions = new Map();
  }
  challenge(wallet, host) {
    const account = normalize(wallet);
    if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]{1,180}$/.test(host)) throw new Error('Invalid test host.');
    const nonce = randomBytes(20).toString('hex'), expires = this.now() + 5 * 60_000;
    const message = `CHOGPIT LOCAL MOCK CLAIM TEST ONLY\nHost: ${host}\nChain ID: 143\nWallet: ${account}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nNo real CHOG or live prize eligibility.`;
    this.challenges.set(nonce, { account, message, expires });
    return { nonce, message, expires };
  }
  async create({ wallet, nonce, signature }) {
    const challenge = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!challenge || challenge.expires < this.now() || normalize(wallet) !== challenge.account
      || !await verifyMessage({ address: challenge.account, message: challenge.message, signature }).catch(() => false)) {
      throw new Error('Invalid or replayed local-test signature.');
    }
    const bearer = randomBytes(32).toString('hex');
    this.sessions.set(bearer, { wallet: challenge.account, expires: this.now() + 60 * 60_000 });
    return { bearer, wallet: challenge.account };
  }
  resolve(bearer) {
    const session = this.sessions.get(bearer);
    if (!session) return null;
    if (session.expires < this.now()) { this.sessions.delete(bearer); return null; }
    return session.wallet;
  }
}

// Local test-only proof service: bearer tokens are resolved server-side, not
// trusted from a caller-supplied address. No public route imports this service.
export class LocalClaimProofService {
  constructor(ledger, resolveSignedSession) {
    if (!ledger?.allowLocalTests || typeof resolveSignedSession !== 'function')
      throw new Error('Proof service requires an explicit local test journal and signed-session verifier.');
    this.ledger = ledger;
    this.resolveSignedSession = resolveSignedSession;
  }
  forSession({ campaignId, bearer, wallet }) {
    const signedWallet = this.resolveSignedSession(bearer);
    if (!signedWallet) throw new Error('Valid signed wallet session required.');
    return this.ledger.getLocalProofsForWallet({ campaignId,
      wallet: wallet || signedWallet, sessionAccount: signedWallet });
  }
}

// Opt-in HTTP adapter for an EPHEMERAL LOOPBACK TEST server only. The hosted
// application never registers this route, so /api/claims/* remains HTTP 423.
export function localProofHttpHandler(proofService) {
  if (!(proofService instanceof LocalClaimProofService)) throw new Error('Local test proof service required.');
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return reply(res, 400, { error: 'Invalid URL.' }); }
    if (url.pathname !== '/local-test/claims/proofs') return reply(res, 404, { error: 'Not found.' });
    if (req.method !== 'GET') return reply(res, 405, { error: 'GET only.' });
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (!bearer || !proofService.resolveSignedSession(bearer))
      return reply(res, 401, { error: 'Signed local-test wallet session required.' });
    try {
      const campaignId = url.searchParams.get('campaignId');
      const wallet = url.searchParams.get('wallet') || undefined;
      const proofs = proofService.forSession({ campaignId, bearer, wallet });
      return reply(res, 200, { campaignId, mockOnly: true, mainnetClaimable: false, proofs });
    } catch (error) {
      return reply(res, /another wallet/.test(error.message) ? 403 : 400,
        { error: 'Invalid local-test campaign or wallet request.' });
    }
  };
}
