// Late-bound fresh-campaign intake: a server-verified box belongs first to a
// signed-in account (passkey OR separately verified email), NOT to a wallet. The player can confirm an address
// after opening, but BEFORE the owner's Merkle root is published. The address
// becomes permanent for this vault once any batch containing it is sealed.
// No preview/local-test data can be imported into this separate database.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getAddress, keccak256, toHex } from 'viem';
import { candidateThresholdBatch } from './claim-kit-threshold.mjs';

const MAINNET_CHOG = '0x350035555e10d9afaf1566aaebfced5ba6c27777';

const HASH = /^0x[a-fA-F0-9]{64}$/;
const RUN = /^[a-f0-9]{32}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const CAMPAIGN = /^CHOGPIT_[A-Z0-9_-]{5,60}$/;
const ACCOUNT_METHODS = Object.freeze({
  passkey: Object.freeze({ source: 'FRESH_PASSKEY_ACCOUNT_V2',
    schemaKind: 'PASSKEY_LATE_BOUND_V5_ADDRESS_AUDIT', tag: 'PASSKEY',
    eventDomain: 'CHOGPIT.PASSKEY_CAMPAIGN_V2' }),
  email: Object.freeze({ source: 'FRESH_EMAIL_ACCOUNT_V1',
    schemaKind: 'EMAIL_LATE_BOUND_V1_ADDRESS_AUDIT', tag: 'EMAIL',
    eventDomain: 'CHOGPIT.EMAIL_CAMPAIGN_V1' })
});
const ZERO = `0x${'0'.repeat(64)}`;
const sha = data => `0x${createHash('sha256').update(data).digest('hex')}`;
const auditHash = (seq, prior, kind, ref, payload) =>
  sha(`CHOGPIT_LATE_BOUND_AUDIT_V2\n${seq}\n${prior}\n${kind}\n${ref}\n${payload}`);
function accountBoundEventId(campaignId, runId, round, boxId, method) {
  if (!ACCOUNT_METHODS[method] || !CAMPAIGN.test(campaignId) || !RUN.test(runId)
    || !Number.isSafeInteger(round) || round < 1
    || !Number.isSafeInteger(boxId) || boxId < 0 || boxId > 3)
    throw new Error('Invalid fresh campaign opening identity.');
  return keccak256(toHex(`${ACCOUNT_METHODS[method].eventDomain}|${campaignId}|${runId}:${round}:${boxId}`));
}
export const lateBoundEventId = (campaignId,runId,round,boxId) =>
  accountBoundEventId(campaignId,runId,round,boxId,'passkey');
export const emailBoundEventId = (campaignId,runId,round,boxId) =>
  accountBoundEventId(campaignId,runId,round,boxId,'email');

export class LateBoundCampaignIntake {
  constructor(file, { campaignId, vault, token = MAINNET_CHOG, rulesHash,
    admissionPolicy, allowMockToken = false, accountMethod = 'passkey',
    now = () => Date.now() } = {}) {
    if (!ACCOUNT_METHODS[accountMethod] || !file || file === ':memory:'
      || !CAMPAIGN.test(campaignId) || !HASH.test(rulesHash)
      || /^0x0{64}$/i.test(rulesHash) || !admissionPolicy ||
      typeof admissionPolicy.canOpen !== 'function' ||
      typeof admissionPolicy.currentEpochId !== 'function' ||
      typeof admissionPolicy.maxOpeningsForEpoch !== 'function' ||
      admissionPolicy.rulesHash?.toLowerCase() !== rulesHash.toLowerCase())
      throw new Error('A durable late-bound campaign and configured admission policy are required.');
    const address = getAddress(vault), asset = getAddress(token);
    if (!allowMockToken && asset.toLowerCase() !== MAINNET_CHOG.toLowerCase())
      throw new Error('A real campaign must target the verified mainnet CHOG token.');
    this.file = path.resolve(file); this.campaignId = campaignId;
    this.vault = address; this.token = asset; this.rulesHash = rulesHash.toLowerCase();
    this.accountMethod = accountMethod; this.protocol = ACCOUNT_METHODS[accountMethod];
    this.policy = admissionPolicy; this.now = now;
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file, { timeout: 5000 });
    chmodSync(this.file, 0o600);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('observations','claim_events','fresh_schema') LIMIT 1").get()) {
      this.db.close(); throw new Error('Preview and no-minimum draft journals cannot be imported into the new campaign.');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS late_schema(
        campaign_id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, vault TEXT NOT NULL,
        token TEXT NOT NULL, rules_hash TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts(
        account_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        payout_address TEXT, address_locked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS openings(
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
        box_id INTEGER NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(account_id),
        opened_epoch INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('solo','pvp','coop')),
        arena_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
        recipient TEXT, epoch_id INTEGER, batch_id INTEGER, position INTEGER,
        source TEXT NOT NULL CHECK(source='${this.protocol.source}'),
        UNIQUE(run_id,round,box_id), UNIQUE(batch_id,position)
      );
      CREATE TABLE IF NOT EXISTS batches(
        batch_id INTEGER PRIMARY KEY, epoch_id INTEGER NOT NULL, root TEXT NOT NULL,
        entries INTEGER NOT NULL, created_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state='CANDIDATE_UNPUBLISHED')
      );
      CREATE TABLE IF NOT EXISTS audit_log(
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL,
        payload TEXT NOT NULL, prior TEXT NOT NULL, digest TEXT NOT NULL,
        UNIQUE(kind,ref)
      );
      CREATE TRIGGER IF NOT EXISTS late_audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT,'Late-bound audit chain is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS late_audit_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT,'Late-bound audit chain is append-only'); END;
      CREATE INDEX IF NOT EXISTS idx_late_pending ON openings(batch_id,opened_epoch,opened_at,event_id);
      CREATE INDEX IF NOT EXISTS idx_late_account ON openings(account_id,batch_id);
    `);
    if (accountMethod === 'email') {
      this.db.exec(`CREATE TABLE IF NOT EXISTS email_identities(
        account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
        normalized_email TEXT NOT NULL UNIQUE, verified_at INTEGER NOT NULL
      );`);
      const identityDdl = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='email_identities'").get()?.sql?.replace(/\s+/g, '');
      if (!identityDdl?.includes('normalized_emailTEXTNOTNULLUNIQUE')) {
        this.db.close(); throw new Error('Email identity uniqueness is missing; refuse this journal.');
      }
    }
    // CREATE TABLE IF NOT EXISTS preserves an older table's CHECK unchanged.
    // Refuse journals whose declared mode OR account provenance differs from
    // this campaign. In particular, an email is never silently a passkey.
    const openingSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='openings'").get()?.sql?.replace(/\s+/g, '');
    if (!openingSchema?.includes("modeTEXTNOTNULLCHECK(modeIN('solo','pvp','coop'))")
      || !openingSchema.includes(`sourceTEXTNOTNULLCHECK(source='${this.protocol.source}')`)) {
      this.db.close();
      throw new Error('Incompatible openings table or account provenance; start a fresh versioned candidate journal.');
    }
    const rows = this.db.prepare('SELECT * FROM late_schema').all();
    // V4 admitted co-op, but did not journal pre-batch recipient changes;
    // email accounts require a fresh incompatible schema and event domain.
    const schemaKind = this.protocol.schemaKind;
    if (rows.length === 0) this.db.prepare('INSERT INTO late_schema VALUES(?,?,?,?,?,?)')
      .run(campaignId, 143, address, asset, this.rulesHash, schemaKind);
    else if (rows.length !== 1 || rows[0].campaign_id !== campaignId || rows[0].chain_id !== 143
      || rows[0].vault.toLowerCase() !== address.toLowerCase()
      || rows[0].token.toLowerCase() !== asset.toLowerCase()
      || rows[0].rules_hash !== this.rulesHash || rows[0].kind !== schemaKind) {
      this.db.close(); throw new Error('Campaign journal belongs to a different vault or rules version.');
    }
    try { this.audit(); } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  #append(kind, ref, data) {
    const previous = this.db.prepare('SELECT seq,digest FROM audit_log ORDER BY seq DESC LIMIT 1').get();
    const seq = (previous?.seq || 0) + 1, prior = previous?.digest || ZERO;
    const payload = JSON.stringify(data);
    this.db.prepare('INSERT INTO audit_log(seq,kind,ref,payload,prior,digest) VALUES(?,?,?,?,?,?)')
      .run(seq, kind, ref, payload, prior, auditHash(seq, prior, kind, ref, payload));
  }
  // ONLY EmailAccounts calls this from the server after it atomically consumes
  // a delivered, single-use sign-in link. This journal shows account creation,
  // NOT independent proof of mail delivery or unique-human eligibility.
  registerVerifiedEmailAccount(normalizedEmail) {
    if (this.accountMethod !== 'email' || typeof normalizedEmail !== 'string'
      || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]{1,64}@[a-z0-9.-]{3,253}$/.test(normalizedEmail)
      || normalizedEmail.length > 254 || normalizedEmail.includes('..'))
      throw new Error('A normalized email account is required.');
    this.audit();
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT account_id FROM email_identities WHERE normalized_email=?').get(normalizedEmail);
      if (old) return old.account_id;
      const accountId = randomBytes(16).toString('hex'), time = this.now();
      if (!Number.isSafeInteger(time) || time <= 0) throw new Error('Trusted email verification time required.');
      this.db.prepare('INSERT INTO accounts(account_id,created_at) VALUES(?,?)').run(accountId,time);
      this.db.prepare('INSERT INTO email_identities(account_id,normalized_email,verified_at) VALUES(?,?,?)')
        .run(accountId,normalizedEmail,time);
      this.#append('EMAIL_REGISTER',accountId,{accountId,
        emailDigest: sha(`CHOGPIT_EMAIL_ID_V1\n${normalizedEmail}`),verifiedAt:time});
      return accountId;
    })();
  }
  // Called ONLY inside the server's onVerifiedOpening hook, before box.opened.
  recordServerOpening({ runId, round, boxId, accountId, mode, arenaId }) {
    if (!ACCOUNT.test(accountId) || !RUN.test(runId) || !Number.isSafeInteger(round)
      || round < 1 || round > 999999 || !Number.isSafeInteger(boxId)
      || boxId < 0 || boxId > 3 || !['solo','pvp','coop'].includes(mode)
      || typeof arenaId !== 'string' || !/^(demo|\d{1,7})$/.test(arenaId))
      throw new Error('A signed-in account and server-owned opening are required.');
    this.audit();
    const eventId = accountBoundEventId(this.campaignId, runId, round, boxId, this.accountMethod);
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM accounts WHERE account_id=?').get(accountId))
        throw new Error('Account has not been registered.');
      if (this.accountMethod === 'email' &&
        !this.db.prepare(`SELECT 1 FROM email_identities WHERE account_id=? AND verified_at>0`).get(accountId))
        throw new Error('A verified email account is required.');
      const old = this.db.prepare('SELECT * FROM openings WHERE event_id=?').get(eventId);
      if (old) {
        if (old.account_id !== accountId || old.mode !== mode || old.arena_id !== arenaId)
          throw new Error('Conflicting duplicate campaign opening.');
        return { eventId, epochId: old.opened_epoch, duplicate: true, source: this.protocol.source };
      }
      if (this.accountMethod === 'email' && this.db.prepare(`SELECT COUNT(*) AS n FROM openings
        WHERE account_id=?`).get(accountId).n >= 2)
        throw new Error('This email account already used its two campaign openings.');
      const epochId = this.policy.currentEpochId();
      const slots = this.policy.maxOpeningsForEpoch(epochId);
      if (!Number.isSafeInteger(epochId) || epochId < 0 ||
        !Number.isSafeInteger(slots) || slots < 0 || slots > 40)
        throw new Error('No verified, funded opening capacity is configured for this epoch.');
      const priorEpochEvents = this.db.prepare('SELECT COUNT(*) AS n FROM openings WHERE opened_epoch=?')
        .get(epochId).n;
      if (priorEpochEvents >= slots)
        throw new Error('The 25-CHOG worst-case backed opening slots for this epoch are exhausted.');
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM openings').get().n;
      if (this.accountMethod === 'email' && count >= 40)
        throw new Error('This email campaign has exhausted all 40 worst-case backed openings.');
      const openedAt = this.now();
      if (this.policy.canOpen({ accountId, mode, arenaId, runId, round, boxId,
        openedAt, epochId, priorEpochEvents, priorEvents: count }, this.db) !== true)
        throw new Error('Published campaign admission policy rejected this opening.');
      this.db.prepare(`INSERT INTO openings(event_id,run_id,round,box_id,account_id,opened_epoch,
        mode,arena_id,opened_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(eventId, runId, round, boxId, accountId, epochId, mode, arenaId, openedAt, this.protocol.source);
      this.#append(`${this.protocol.tag}_OPENING`, eventId, { eventId, runId, round, boxId,
        accountId, openedEpoch: epochId, mode, arenaId, openedAt, source: this.protocol.source });
      return { eventId, epochId, duplicate: false, source: this.protocol.source };
    })();
  }
  // Internal boundary: PasskeyAccounts calls this AFTER a fresh assertion;
  // EmailAccounts calls this ONLY after one-time inbox re-verification.
  // Never expose it as an unauthenticated HTTP action.
  // Both the address mutation and its hash-linked receipt are one transaction;
  // an audit-write failure must leave the previous destination untouched.
  recordVerifiedAddress(accountId, input) {
    if (!ACCOUNT.test(accountId)) throw new Error('A verified account is required.');
    const destination = getAddress(input);
    if (/^0x0{40}$/i.test(destination) ||
      [this.vault, this.token].some(value => value.toLowerCase() === destination.toLowerCase()))
      throw new Error('This is not a valid player payout destination.');
    const lower = destination.toLowerCase();
    this.audit();
    return this.db.transaction(() => {
      const account = this.db.prepare('SELECT payout_address,address_locked_at FROM accounts WHERE account_id=?')
        .get(accountId);
      if (!account || !this.db.prepare('SELECT 1 FROM openings WHERE account_id=? LIMIT 1').get(accountId))
        throw new Error('The verified account has no eligible opening.');
      if (account.address_locked_at !== null && account.payout_address !== lower)
        throw new Error('The payout address was locked when the first batch was sealed.');
      if (account.payout_address === lower)
        return { accountId, address: destination, changed: false };
      const prior = account.payout_address ?? null, time = this.now();
      if (!Number.isSafeInteger(time) || time <= 0)
        throw new Error('A trusted confirmation timestamp is required.');
      if (this.db.prepare(`UPDATE accounts SET payout_address=?
        WHERE account_id=? AND address_locked_at IS NULL`).run(lower, accountId).changes !== 1)
        throw new Error('The payout address was locked during confirmation.');
      const number = this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log
        WHERE kind=? AND ref LIKE ?`).get(`${this.protocol.tag}_ADDRESS`,`${accountId}:%`).n + 1;
      this.#append(`${this.protocol.tag}_ADDRESS`, `${accountId}:${number}`, {
        accountId, previous: prior, address: lower, confirmedAt: time });
      return { accountId, address: destination, changed: true };
    })();
  }
  // A recipient address must be confirmed by a fresh passkey assertion OR
  // a single-use email link before this method is reached. Never expose as HTTP.
  // The address is locked permanently once a batch for this account is sealed.
  sealNextBatch({ epochId, batchId }) {
    if (!Number.isSafeInteger(epochId) || epochId < 0 || !Number.isSafeInteger(batchId) || batchId < 0)
      throw new Error('Use the reviewed vault’s actual next epoch/batch IDs.');
    this.audit();
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM batches WHERE batch_id=?').get(batchId))
        throw new Error('Batch ID was already sealed.');
      const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM openings
        WHERE batch_id IS NULL AND opened_epoch=?`).get(epochId).n;
      if (!pending) throw new Error('No originally backed openings are pending in this epoch.');
      // Unaddressed openings stay ring-fenced in their ORIGINAL funded epoch,
      // including after that epoch closes and a later epoch opens. They do not
      // delay other players; a complete manifest still discloses all pending.
      const unbound = this.db.prepare(`SELECT COUNT(*) AS n FROM openings o
        JOIN accounts a ON a.account_id=o.account_id
        WHERE o.batch_id IS NULL AND o.opened_epoch=? AND a.payout_address IS NULL`).get(epochId).n;
      const rows = this.db.prepare(`SELECT o.*,a.payout_address FROM openings o
        JOIN accounts a ON a.account_id=o.account_id
        WHERE o.batch_id IS NULL AND o.opened_epoch=? AND a.payout_address IS NOT NULL
        ORDER BY o.opened_at,o.event_id LIMIT 40`).all(epochId);
      if (!rows.length) throw new Error(`${unbound} opening(s) still need confirmed addresses; no eligible batch entries.`);
      const candidate = candidateThresholdBatch({ chainId: 143, vault: this.vault,
        epochId, batchId, entries: rows.map(row => ({ eventId: row.event_id,
          recipient: row.payout_address })) });
      const time = this.now();
      this.db.prepare('INSERT INTO batches(batch_id,epoch_id,root,entries,created_at,state) VALUES(?,?,?,?,?,?)')
        .run(batchId, epochId, candidate.root, rows.length, time, 'CANDIDATE_UNPUBLISHED');
      for (const entry of candidate.entries) {
        const row = rows[entry.index];
        if (this.db.prepare(`UPDATE openings SET recipient=?,epoch_id=?,batch_id=?,position=?
          WHERE event_id=? AND batch_id IS NULL`).run(entry.recipient.toLowerCase(),
          epochId, batchId, entry.index, entry.eventId).changes !== 1)
          throw new Error('Opening was already included elsewhere.');
        this.db.prepare('UPDATE accounts SET address_locked_at=COALESCE(address_locked_at,?) WHERE account_id=?')
          .run(time, row.account_id);
      }
      this.#append(`${this.protocol.tag}_BATCH`, String(batchId), { epochId, batchId,
        root: candidate.root, entries: rows.map(row => ({ eventId: row.event_id,
          recipient: row.payout_address.toLowerCase() })) });
      const stillPending = this.db.prepare('SELECT COUNT(*) AS n FROM openings WHERE batch_id IS NULL').get().n;
      return { epochId, batchId, root: candidate.root, count: rows.length,
        pendingOutsideBatch: stillPending, unaddressedOutsideBatch: unbound,
        state: 'CANDIDATE_UNPUBLISHED', onchainCommitted: false };
    })();
  }
  audit() {
    if (this.db.pragma('quick_check(1)', { simple: true }) !== 'ok')
      throw new Error('Late-bound SQLite integrity check failed.');
    const method = this.accountMethod;
    const protocol = ACCOUNT_METHODS[method];
    if (!protocol) throw new Error('Unknown account audit provenance.');
    if (method === 'email' && this.db.pragma('foreign_key_check').length)
      throw new Error('Email journal foreign-key integrity check failed.');
    let seq = 0, prior = ZERO;
    const events = new Map(), batchLogs = new Map(), addressLogs = new Map();
    const emailRegistrations = new Map();
    const openedAccounts = new Set(), lockedAccounts = new Set();
    for (const row of this.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
      seq++;
      if (row.seq !== seq || row.prior !== prior ||
        row.digest !== auditHash(row.seq, row.prior, row.kind, row.ref, row.payload))
        throw new Error('Late-bound campaign audit chain mismatch.');
      const data = JSON.parse(row.payload);
      if (method === 'email' && row.kind === 'EMAIL_REGISTER' && row.ref === data.accountId) {
        if (!ACCOUNT.test(row.ref) || emailRegistrations.has(row.ref)
          || !HASH.test(data.emailDigest)
          || !Number.isSafeInteger(data.verifiedAt) || data.verifiedAt <= 0)
          throw new Error('Email account registration journal mismatch.');
        emailRegistrations.set(row.ref,data);
      } else if (row.kind === `${protocol.tag}_OPENING` && row.ref === data.eventId) {
        if (method === 'email' && !emailRegistrations.has(data.accountId))
          throw new Error('Opening preceded email account verification.');
        events.set(row.ref, data);
        openedAccounts.add(data.accountId);
      } else if (row.kind === `${protocol.tag}_ADDRESS`) {
        const history = addressLogs.get(data.accountId) || [];
        const previous = history.at(-1)?.address ?? null;
        if (!ACCOUNT.test(data.accountId) || !openedAccounts.has(data.accountId)
          || lockedAccounts.has(data.accountId)
          || row.ref !== `${data.accountId}:${history.length + 1}`
          || data.previous !== previous || data.address === previous
          || !/^0x[a-f0-9]{40}$/.test(data.address)
          || !Number.isSafeInteger(data.confirmedAt) || data.confirmedAt <= 0)
          throw new Error(`${method} address confirmation journal mismatch.`);
        history.push(data); addressLogs.set(data.accountId, history);
      } else if (row.kind === `${protocol.tag}_BATCH` && row.ref === String(data.batchId)) {
        if (!Array.isArray(data.entries) || data.entries.some(entry => {
          const accountId = events.get(entry.eventId)?.accountId;
          if (!accountId || addressLogs.get(accountId)?.at(-1)?.address !== entry.recipient)
            return true;
          lockedAccounts.add(accountId);
          return false;
        })) throw new Error(`A batch recipient lacks a prior ${method} address confirmation.`);
        batchLogs.set(data.batchId, data);
      } else throw new Error('Unexpected campaign journal entry.');
      prior = row.digest;
    }
    for (const account of this.db.prepare('SELECT account_id,created_at,payout_address,address_locked_at FROM accounts').iterate()) {
      const recorded = addressLogs.get(account.account_id)?.at(-1)?.address ?? null;
      if (account.payout_address !== recorded ||
        (account.address_locked_at !== null) !== lockedAccounts.has(account.account_id))
        throw new Error(`Account payout address or batch lock differs from its ${method} audit history.`);
      if (method === 'email' && (emailRegistrations.get(account.account_id)?.verifiedAt !== account.created_at))
        throw new Error('An email account lacks a matching verified registration receipt.');
    }
    if (method === 'email') {
      const identities = this.db.prepare('SELECT * FROM email_identities').all();
      if (identities.length !== emailRegistrations.size ||
        identities.some(identity => {
          const log = emailRegistrations.get(identity.account_id);
          return !log || log.verifiedAt !== identity.verified_at ||
            log.emailDigest !== sha(`CHOGPIT_EMAIL_ID_V1\n${identity.normalized_email}`);
        })) throw new Error('Email identity mapping differs from verified registrations.');
    }
    const openings = this.db.prepare('SELECT * FROM openings ORDER BY event_id').all();
    if (events.size !== openings.length) throw new Error('Recorded openings and audit entries differ.');
    for (const row of openings) {
      const event = events.get(row.event_id);
      if (!event || event.runId !== row.run_id || event.round !== row.round
        || event.boxId !== row.box_id || event.accountId !== row.account_id
        || event.openedEpoch !== row.opened_epoch
        || event.mode !== row.mode || event.arenaId !== row.arena_id
        || event.openedAt !== row.opened_at || event.source !== protocol.source || row.source !== protocol.source
        || accountBoundEventId(this.campaignId,row.run_id,row.round,row.box_id,method) !== row.event_id)
        throw new Error('A late-bound opening differs from its journal entry.');
      if (row.batch_id !== null) {
        const account = this.db.prepare('SELECT payout_address,address_locked_at FROM accounts WHERE account_id=?')
          .get(row.account_id);
        if (!account?.address_locked_at || account.payout_address?.toLowerCase() !== row.recipient)
          throw new Error(`A published recipient differs from the locked ${method} account address.`);
      }
    }
    const batches = this.db.prepare('SELECT * FROM batches ORDER BY batch_id').all();
    if (batchLogs.size !== batches.length) throw new Error('Missing batch journal entry.');
    for (const batch of batches) {
      const rows = this.db.prepare('SELECT * FROM openings WHERE batch_id=? ORDER BY position').all(batch.batch_id);
      const candidate = candidateThresholdBatch({ chainId: 143, vault: this.vault,
        epochId: batch.epoch_id, batchId: batch.batch_id,
        entries: rows.map(row => ({ eventId: row.event_id, recipient: row.recipient })) });
      if (candidate.root !== batch.root || rows.length !== batch.entries ||
        rows.some((row,i) => row.position !== i || row.epoch_id !== batch.epoch_id
          || row.opened_epoch !== batch.epoch_id) ||
        JSON.stringify(batchLogs.get(batch.batch_id)) !== JSON.stringify({
          epochId: batch.epoch_id, batchId: batch.batch_id, root: batch.root,
          entries: rows.map(row => ({ eventId: row.event_id, recipient: row.recipient }))
        })) throw new Error('Late-bound batch root or inclusion journal mismatch.');
    }
    return { campaignId: this.campaignId, journalHead: prior, journalEntries: seq,
      openings: openings.length, batched: openings.filter(row => row.batch_id !== null).length,
      pending: openings.filter(row => row.batch_id === null).length,
      unaddressed: this.db.prepare(`SELECT COUNT(*) AS n FROM openings o
        JOIN accounts a ON a.account_id=o.account_id
        WHERE o.batch_id IS NULL AND a.payout_address IS NULL`).get().n,
      batches: batches.length, mainnetClaimable: false };
  }
  exportUnsignedBatch(batchId) {
    const report = this.audit();
    if (!Number.isSafeInteger(batchId) || batchId < 0) throw new Error('Invalid batch ID.');
    const batch = this.db.prepare('SELECT * FROM batches WHERE batch_id=?').get(batchId);
    if (!batch) throw new Error('No sealed candidate exists for that batch.');
    return { schema: 'CHOGPIT_THRESHOLD_BATCH_V2', campaignId: this.campaignId,
      chainId: 143, vault: this.vault, token: this.token, rulesHash: this.rulesHash,
      journalHead: report.journalHead, epochId: batch.epoch_id,
      batchId, root: batch.root, pendingOutsideBatch: report.pending,
      unaddressedOutsideBatch: report.unaddressed,
      entries: this.db.prepare('SELECT * FROM openings WHERE batch_id=? ORDER BY position').all(batchId)
        .map(row => ({ eventId: row.event_id, recipient: row.recipient,
          runId: row.run_id, round: row.round, boxId: row.box_id,
          mode: row.mode, arenaId: row.arena_id, source: this.protocol.source })),
      attestation: null, onchainCommitted: false,
      warning: 'UNSIGNED CANDIDATE. Pending openings remain and are not forfeited. No mainnet claim exists.' };
  }
  exportUnsignedManifest() {
    const report = this.audit();
    if (!report.batches || report.pending)
      throw new Error('All recorded account openings need confirmed addresses and inclusion before a complete manifest can be exported.');
    return { schema: 'CHOGPIT_THRESHOLD_MANIFEST_V2', campaignId: this.campaignId,
      chainId: 143, vault: this.vault, token: this.token, rulesHash: this.rulesHash,
      journalHead: report.journalHead,
      batches: this.db.prepare('SELECT * FROM batches ORDER BY batch_id').all().map(batch => ({
        epochId: batch.epoch_id, batchId: batch.batch_id, root: batch.root,
        entries: this.db.prepare('SELECT * FROM openings WHERE batch_id=? ORDER BY position').all(batch.batch_id)
          .map(row => ({ eventId: row.event_id, recipient: row.recipient, runId: row.run_id,
            round: row.round, boxId: row.box_id, mode: row.mode, arenaId: row.arena_id,
            source: this.protocol.source }))
      })), attestation: null,
      warning: 'UNSIGNED CANDIDATE. Amounts unknown until on-chain root commit and oracle seed; no mainnet claim exists.' };
  }
}
