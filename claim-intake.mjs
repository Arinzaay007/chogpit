// Fresh-campaign opening journal for a separately operated, reviewed campaign.
// NOT mounted in the preview server. Only call recordServerOpening from a
// server-owned proximity/opening hook BEFORE marking the box opened. A signed
// wallet and an explicit, approved admission policy are mandatory. This file
// cannot decide legality, personhood, fairness, or whether the vault has funds.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getAddress, verifyMessage } from 'viem';
import { candidateClaimBatch } from './claim-kit.mjs';
import { freshEventId, manifestBody, manifestDigest } from './claim-delivery.mjs';
import { CLAIM_CHAIN_ID, MAINNET_CHOG } from './public/claim-wallet.js';

const HASH = /^0x[a-fA-F0-9]{64}$/;
const ZERO = `0x${'0'.repeat(64)}`;
const RUN = /^[a-f0-9]{32}$/;
const CAMPAIGN = /^CHOGPIT_[A-Z0-9_-]{5,60}$/;
const SOURCE = 'FRESH_SERVER_VERIFIED';
const digest = text => `0x${createHash('sha256').update(text).digest('hex')}`;
const keyOf = row => `${row.run_id}:${row.round}:${row.box_id}`;
const auditHash = (seq, prior, type, ref, payload) =>
  digest(`CHOGPIT_FRESH_AUDIT_V1\n${seq}\n${prior}\n${type}\n${ref}\n${payload}`);

export class FreshCampaignIntake {
  constructor(file, { campaignId, vault, token = MAINNET_CHOG, rulesHash,
    admissionPolicy, allowMockToken = false, now = () => Date.now() } = {}) {
    if (!file || file === ':memory:' || !CAMPAIGN.test(campaignId) || !HASH.test(rulesHash)
      || /^0x0{64}$/i.test(rulesHash) || !admissionPolicy ||
      typeof admissionPolicy.canOpen !== 'function' ||
      admissionPolicy.rulesHash?.toLowerCase() !== rulesHash.toLowerCase())
      throw new Error('A durable fresh campaign, published rules hash and explicit admission policy are required.');
    const address = getAddress(vault), asset = getAddress(token);
    if (!allowMockToken && asset.toLowerCase() !== MAINNET_CHOG.toLowerCase())
      throw new Error('Real claim intake must target the verified mainnet CHOG token.');
    this.file = path.resolve(file); this.campaignId = campaignId; this.vault = address;
    this.token = asset; this.rulesHash = rulesHash.toLowerCase();
    this.admissionPolicy = admissionPolicy; this.now = now;
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file, { timeout: 5000 });
    chmodSync(this.file, 0o600);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('observations','claim_events') LIMIT 1").get()) {
      this.db.close(); throw new Error('Never import preview or local-test events into a fresh campaign.');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS fresh_schema(
        campaign_id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, vault TEXT NOT NULL,
        token TEXT NOT NULL, rules_hash TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS openings(
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
        box_id INTEGER NOT NULL, recipient TEXT NOT NULL, mode TEXT NOT NULL,
        arena_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
        batch_id INTEGER, position INTEGER, source TEXT NOT NULL CHECK(source='FRESH_SERVER_VERIFIED'),
        UNIQUE(run_id,round,box_id), UNIQUE(batch_id,position)
      );
      CREATE TABLE IF NOT EXISTS batches(
        batch_id INTEGER PRIMARY KEY, root TEXT NOT NULL, entries INTEGER NOT NULL,
        created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state='CANDIDATE_UNPUBLISHED')
      );
      CREATE TABLE IF NOT EXISTS audit_log(
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL,
        payload TEXT NOT NULL, prior TEXT NOT NULL, digest TEXT NOT NULL,
        UNIQUE(kind,ref)
      );
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT,'Fresh audit log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT,'Fresh audit log is append-only'); END;
      CREATE INDEX IF NOT EXISTS idx_fresh_pending ON openings(batch_id,opened_at,event_id);
    `);
    const row = this.db.prepare('SELECT * FROM fresh_schema').all();
    if (row.length === 0) this.db.prepare('INSERT INTO fresh_schema VALUES(?,?,?,?,?,?)')
      .run(campaignId, CLAIM_CHAIN_ID, address, asset, this.rulesHash, 'FRESH_CAMPAIGN_V1');
    else if (row.length !== 1 || row[0].campaign_id !== campaignId || row[0].chain_id !== CLAIM_CHAIN_ID
      || row[0].vault.toLowerCase() !== address.toLowerCase()
      || row[0].token.toLowerCase() !== asset.toLowerCase() ||
      row[0].rules_hash !== this.rulesHash || row[0].kind !== 'FRESH_CAMPAIGN_V1') {
      this.db.close(); throw new Error('Fresh campaign file belongs to a different campaign or schema.');
    }
    try { this.audit(); }
    catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  #append(kind, ref, item) {
    const last = this.db.prepare('SELECT seq,digest FROM audit_log ORDER BY seq DESC LIMIT 1').get();
    const seq = (last?.seq || 0) + 1, prior = last?.digest || ZERO, payload = JSON.stringify(item);
    this.db.prepare('INSERT INTO audit_log(seq,kind,ref,payload,prior,digest) VALUES(?,?,?,?,?,?)')
      .run(seq, kind, ref, payload, prior, auditHash(seq, prior, kind, ref, payload));
  }
  // Do not expose this method as an HTTP endpoint. The caller must pass fields
  // from the server's room/player/box objects, not from the player's WebSocket.
  recordServerOpening({ runId, round, boxId, recipient, mode, arenaId }) {
    if (!RUN.test(runId) || !Number.isSafeInteger(round) || round < 1 || round > 999999
      || !Number.isSafeInteger(boxId) || boxId < 0 || boxId > 3
      || !['solo', 'pvp'].includes(mode) || typeof arenaId !== 'string' ||
      !/^(demo|\d{1,7})$/.test(arenaId)) throw new Error('Invalid server-owned opening.');
    if (!recipient) throw new Error('Link a campaign wallet before opening a prize-bearing box.');
    const account = getAddress(recipient).toLowerCase();
    const eventId = freshEventId(this.campaignId, runId, round, boxId);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM openings WHERE event_id=?').get(eventId);
      if (existing) {
        if (existing.recipient !== account || existing.mode !== mode || existing.arena_id !== arenaId)
          throw new Error('Conflicting duplicate fresh event.');
        return { eventId, duplicate: true, source: SOURCE };
      }
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM openings').get().n;
      if (total >= 200) throw new Error('The 1,000-CHOG minimum-award event ceiling has been reached.');
      const opening = { runId, round, boxId, recipient: account, mode, arenaId, eventId,
        at: this.now(), totalRecorded: total };
      if (this.admissionPolicy.canOpen(opening, this.db) !== true)
        throw new Error('Published eligibility policy did not admit this opening.');
      this.db.prepare(`INSERT INTO openings(event_id,run_id,round,box_id,recipient,mode,arena_id,opened_at,source)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(eventId, runId, round, boxId, account, mode, arenaId,
        opening.at, SOURCE);
      this.#append('FRESH_OPENING', eventId, { eventId, runId, round, boxId, recipient: account,
        mode, arenaId, openedAt: opening.at, source: SOURCE });
      return { eventId, duplicate: false, source: SOURCE };
    })();
  }
  sealNextBatch() {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM openings WHERE batch_id IS NULL
        ORDER BY opened_at,event_id LIMIT 40`).all();
      if (!rows.length) throw new Error('No fresh eligible openings are pending.');
      const batchId = this.db.prepare('SELECT COALESCE(MAX(batch_id)+1,0) AS n FROM batches').get().n;
      const candidate = candidateClaimBatch({ chainId: CLAIM_CHAIN_ID, vault: this.vault, batchId,
        entries: rows.map(row => ({ eventId: row.event_id, recipient: row.recipient })) });
      this.db.prepare('INSERT INTO batches(batch_id,root,entries,created_at,state) VALUES(?,?,?,?,?)')
        .run(batchId, candidate.root, rows.length, this.now(), 'CANDIDATE_UNPUBLISHED');
      for (const item of candidate.entries) {
        if (this.db.prepare('UPDATE openings SET batch_id=?,position=? WHERE event_id=? AND batch_id IS NULL')
          .run(batchId, item.index, item.eventId).changes !== 1) throw new Error('Opening was already sealed.');
      }
      this.#append('FRESH_BATCH', `${batchId}`, { batchId, root: candidate.root,
        entries: rows.map(row => ({ eventId: row.event_id, recipient: row.recipient })) });
      return { batchId, root: candidate.root, count: rows.length,
        status: 'CANDIDATE_UNPUBLISHED', onchainCommitted: false };
    })();
  }
  audit() {
    if (this.db.pragma('quick_check(1)', { simple: true }) !== 'ok')
      throw new Error('Fresh campaign SQLite integrity check failed.');
    let previous = ZERO, seq = 0;
    const eventAudit = new Map(), batchAudit = new Map();
    for (const row of this.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
      seq++;
      if (row.seq !== seq || row.prior !== previous ||
        row.digest !== auditHash(row.seq, row.prior, row.kind, row.ref, row.payload))
        throw new Error('Fresh campaign audit chain mismatch.');
      const item = JSON.parse(row.payload);
      if (row.kind === 'FRESH_OPENING' && row.ref === item.eventId) eventAudit.set(row.ref, item);
      else if (row.kind === 'FRESH_BATCH' && row.ref === String(item.batchId)) batchAudit.set(item.batchId, item);
      else throw new Error('Unexpected audit entry in fresh campaign.');
      previous = row.digest;
    }
    const openings = this.db.prepare('SELECT * FROM openings ORDER BY event_id').all();
    if (eventAudit.size !== openings.length) throw new Error('Missing or fabricated fresh opening audit entries.');
    for (const row of openings) {
      const logged = eventAudit.get(row.event_id);
      if (!logged || logged.runId !== row.run_id || logged.round !== row.round || logged.boxId !== row.box_id
        || logged.recipient !== row.recipient || logged.mode !== row.mode || logged.arenaId !== row.arena_id
        || logged.openedAt !== row.opened_at || row.source !== SOURCE || logged.source !== SOURCE
        || freshEventId(this.campaignId, row.run_id, row.round, row.box_id) !== row.event_id)
        throw new Error('Fresh opening differs from its journal entry.');
    }
    const batches = this.db.prepare('SELECT * FROM batches ORDER BY batch_id').all();
    if (batchAudit.size !== batches.length) throw new Error('Missing or fabricated batch audit entries.');
    for (const batch of batches) {
      const rows = this.db.prepare('SELECT * FROM openings WHERE batch_id=? ORDER BY position').all(batch.batch_id);
      const recomputed = candidateClaimBatch({ chainId: CLAIM_CHAIN_ID, vault: this.vault,
        batchId: batch.batch_id, entries: rows.map(row => ({ eventId: row.event_id, recipient: row.recipient })) });
      if (rows.length !== batch.entries || batch.root !== recomputed.root ||
        rows.some((row, i) => row.position !== i) ||
        JSON.stringify(batchAudit.get(batch.batch_id)) !== JSON.stringify({
          batchId: batch.batch_id, root: batch.root,
          entries: rows.map(row => ({ eventId: row.event_id, recipient: row.recipient }))
        })) throw new Error('Fresh batch root or inclusion journal mismatch.');
    }
    return { campaignId: this.campaignId, journalHead: previous, auditEntries: seq,
      openings: openings.length, batched: openings.filter(row => row.batch_id !== null).length,
      batches: batches.length, pending: openings.filter(row => row.batch_id === null).length,
      mainnetClaimable: false }; // No root/seed confirmation is performed here.
  }
  exportManifest() {
    const report = this.audit();
    if (!report.batches || report.pending) throw new Error('Publish only after every recorded event has been batched.');
    const batches = this.db.prepare('SELECT * FROM batches ORDER BY batch_id').all().map(batch => ({
      batchId: batch.batch_id, root: batch.root,
      entries: this.db.prepare('SELECT * FROM openings WHERE batch_id=? ORDER BY position').all(batch.batch_id)
        .map(row => ({ eventId: row.event_id, recipient: row.recipient, runId: row.run_id,
          round: row.round, boxId: row.box_id, mode: row.mode, arenaId: row.arena_id, source: SOURCE }))
    }));
    const body = manifestBody({ schema: 'CHOGPIT_PUBLISHED_CLAIMS_V1', campaignId: this.campaignId,
      chainId: CLAIM_CHAIN_ID, vault: this.vault, token: this.token, rulesHash: this.rulesHash,
      journalHead: report.journalHead, batches });
    return { ...body, digest: manifestDigest(body), attestation: null,
      warning: 'UNSIGNED CANDIDATE. Not claimable until separately reviewed, signed and committed on-chain BEFORE oracle randomness.' };
  }
}

// Separate from both preview-wallet login and later published-proof login.
// Bound to a FRESH campaign, its written rules hash and the intended vault.
export class FreshOpeningSessions {
  constructor(intake, { now = () => Date.now() } = {}) {
    if (!(intake instanceof FreshCampaignIntake)) throw new Error('Fresh campaign intake is required.');
    this.intake = intake; this.now = now; this.challenges = new Map(); this.sessions = new Map();
  }
  prune() {
    for (const [nonce, entry] of this.challenges) if (entry.expires <= this.now()) this.challenges.delete(nonce);
    for (const [token, entry] of this.sessions) if (entry.expires <= this.now()) this.sessions.delete(token);
  }
  challenge(wallet, host) {
    const account = getAddress(wallet).toLowerCase();
    if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]{1,180}$/.test(host))
      throw new Error('Invalid campaign website host.');
    if (this.challenges.size >= 4000) this.prune();
    if (this.challenges.size >= 4000) throw new Error('Campaign wallet sign-ins are busy.');
    const nonce = randomBytes(20).toString('hex'), expires = this.now() + 5 * 60_000;
    const message = `CHOGPIT FRESH CAMPAIGN BOX WALLET LINK\nSite: ${host}\nCampaign: ${this.intake.campaignId}\nMonad chain ID: 143\nVault: ${this.intake.vault}\nRules hash: ${this.intake.rulesHash}\nWallet: ${account}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nSigning links your free box openings to this wallet. No transaction, approval, NFT or CHOG holding is required. No award exists until a verified event is accepted and an on-chain batch is seeded.`;
    this.challenges.set(nonce, { account, message, expires });
    return { nonce, message, expires };
  }
  async create({ wallet, nonce, signature }) {
    const entry = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!entry || entry.expires <= this.now() || getAddress(wallet).toLowerCase() !== entry.account ||
      !await verifyMessage({ address: entry.account, message: entry.message, signature }).catch(() => false))
      throw new Error('Campaign wallet signature expired, mismatched or already used.');
    if (this.sessions.size >= 4000) this.prune();
    if (this.sessions.size >= 4000) throw new Error('Campaign wallet sign-ins are busy.');
    const token = randomBytes(32).toString('hex');
    const expires = this.now() + 60 * 60_000;
    this.sessions.set(token, { account: entry.account, expires });
    return { session: token, account: entry.account, expires };
  }
  resolve(session) {
    if (typeof session !== 'string' || !/^[a-f0-9]{64}$/.test(session)) return null;
    const entry = this.sessions.get(session);
    if (!entry || entry.expires <= this.now()) { this.sessions.delete(session); return null; }
    return entry.account;
  }
}

// Inject these callbacks ONLY into a separately configured campaign-mode
// LiveRooms instance. There is deliberately no HTTP endpoint that calls
// recordServerOpening with player-controlled coordinates or result claims.
export function freshCampaignGameHooks(intake, sessions) {
  if (!(intake instanceof FreshCampaignIntake) ||
    !(sessions instanceof FreshOpeningSessions) || sessions.intake !== intake)
    throw new Error('Matched fresh campaign intake and signed sessions are required.');
  return {
    rewardMode: 'campaign',
    resolveSession: token => sessions.resolve(token),
    onVerifiedOpening(room, identity, box) {
      const recipient = sessions.resolve(identity.rewardSession);
      return intake.recordServerOpening({ runId: room.instanceId,
        round: room.roundNumber, boxId: box.id, recipient,
        mode: room.mode, arenaId: room.arena.id });
    },
    onReward(_room, _identity, _box, recorded) {
      if (!recorded?.eventId) throw new Error('Fresh campaign opening was not journaled.');
      return { status: 'campaign-pending', eventId: recorded.eventId,
        amount: null, note: 'Opening recorded. A CHOG amount is not known until the root is published on-chain and the oracle seed arrives.' };
    }
  };
}
