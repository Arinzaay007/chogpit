// Mainnet-shaped claim delivery, kept OUT of the public preview server.
// A signed manifest, a reviewed deployed vault, and an injected sponsor signer
// are mandatory. No preview observation or LOCAL_TEST_ONLY proof is accepted.
// This is implementation work, not a production activation or an audit.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getAddress, keccak256, parseAbi, toHex, verifyMessage } from 'viem';
import { candidateClaimBatch } from './claim-kit.mjs';
import { CLAIM_CHAIN_ID, MAINNET_CHOG } from './public/claim-wallet.js';

const HASH = /^0x[a-fA-F0-9]{64}$/;
const RUN = /^[a-f0-9]{32}$/;
const CAMPAIGN = /^CHOGPIT_[A-Z0-9_-]{5,60}$/;
const SOURCE = 'FRESH_SERVER_VERIFIED';
const MAX_CAMPAIGN_EVENTS = 200; // 1,000 CHOG / the smallest possible 5-CHOG award.
const MAX_GAS = 500_000n;
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const abi = parseAbi([
  'function chog() view returns (address)',
  'function owner() view returns (address)',
  'function creditOf(address) view returns (uint256)',
  'function reservedMaximum() view returns (uint256)',
  'function outstandingCredits() view returns (uint256)',
  'function lifetimeCredited() view returns (uint256)',
  'function redeemed(uint256,uint256) view returns (bool)',
  'function batches(uint256) view returns (bytes32 root, bytes32 seed, uint64 sequence, uint32 entries, uint32 redeemedCount, bool seeded)',
  'function redeem(uint256,uint256,address,bytes32,bytes32[]) returns (uint256)',
  'function withdrawFor(address) returns (uint256)'
]);
const lower = address => getAddress(address).toLowerCase();
const canonical = body => JSON.stringify(body);
const sha = text => `0x${createHash('sha256').update(text).digest('hex')}`;
const requireHash = value => {
  if (!HASH.test(value)) throw new Error('Expected a 32-byte hash.');
  return value.toLowerCase();
};
const requestKey = (runId, round, boxId) => `${runId}:${round}:${boxId}`;

// A fresh campaign identifier is deliberately disjoint from PREVIEW and
// LOCAL_TEST_ONLY domains. The server must derive this ID at the actual opening.
export function freshEventId(campaignId, runId, round, boxId) {
  if (!CAMPAIGN.test(campaignId) || !RUN.test(runId) || !Number.isSafeInteger(round) || round < 1
    || !Number.isSafeInteger(boxId) || boxId < 0 || boxId > 3) throw new Error('Invalid server opening identity.');
  return keccak256(toHex(`CHOGPIT.FRESH_CAMPAIGN_V1|${campaignId}|${requestKey(runId, round, boxId)}`));
}

export function manifestBody(input) {
  if (!input || typeof input !== 'object') throw new Error('A published campaign manifest is required.');
  return { schema: input.schema, campaignId: input.campaignId, chainId: input.chainId,
    vault: input.vault, token: input.token, rulesHash: input.rulesHash,
    journalHead: input.journalHead, batches: input.batches };
}
export const manifestDigest = body => sha(`CHOGPIT.PUBLISHED_CLAIMS_V1\n${canonical(manifestBody(body))}`);
export function manifestSigningMessage(body) {
  return `CHOGPIT published claim manifest\nCampaign: ${body.campaignId}\nChain ID: ${body.chainId}\nVault: ${body.vault}\nToken: ${body.token}\nRules hash: ${body.rulesHash}\nManifest SHA256: ${manifestDigest(body)}\nSigning confirms a fixed list for reviewer inspection; it is not proof of honest gameplay.`;
}

// Verifies an externally selected publisher signature, internal root/proofs,
// and the fresh event domain. It cannot prove an omitted game event happened.
export async function verifyPublishedClaims(input, { trustedPublisher, allowMockToken = false } = {}) {
  const body = manifestBody(input);
  if (body.schema !== 'CHOGPIT_PUBLISHED_CLAIMS_V1' || !CAMPAIGN.test(body.campaignId)
    || body.chainId !== CLAIM_CHAIN_ID || !HASH.test(body.rulesHash)
    || /^0x0{64}$/i.test(body.rulesHash) || !HASH.test(body.journalHead)
    || /^0x0{64}$/i.test(body.journalHead)) throw new Error('Invalid campaign, chain, rules or journal checkpoint.');
  const vault = getAddress(body.vault), token = getAddress(body.token);
  if (!allowMockToken && lower(token) !== lower(MAINNET_CHOG)) throw new Error('A real campaign must use the verified mainnet CHOG token.');
  if (!Array.isArray(body.batches) || body.batches.length < 1 || body.batches.length > MAX_CAMPAIGN_EVENTS)
    throw new Error('Invalid published batch list.');
  let total = 0;
  const usedOpenings = new Set(), usedEvents = new Set(), prepared = [], byWallet = new Map(), byEvent = new Map();
  for (const rawBatch of body.batches) {
    if (!rawBatch || !Number.isSafeInteger(rawBatch.batchId) || rawBatch.batchId < 0
      || !HASH.test(rawBatch.root) || !Array.isArray(rawBatch.entries)
      || rawBatch.entries.length < 1 || rawBatch.entries.length > 40
      || prepared.some(item => item.batchId === rawBatch.batchId)) throw new Error('Invalid or duplicate published batch.');
    total += rawBatch.entries.length;
    if (total > MAX_CAMPAIGN_EVENTS) throw new Error('Campaign exceeds the 1,000-CHOG minimum-award cap.');
    const clean = rawBatch.entries.map(entry => {
      if (!entry || entry.source !== SOURCE || !RUN.test(entry.runId) ||
        !Number.isSafeInteger(entry.round) || entry.round < 1 || entry.round > 999999 ||
        !Number.isSafeInteger(entry.boxId) || entry.boxId < 0 || entry.boxId > 3 ||
        !['solo', 'pvp'].includes(entry.mode) ||
        typeof entry.arenaId !== 'string' || !/^(demo|\d{1,7})$/.test(entry.arenaId))
        throw new Error('A preview, local mock or malformed event cannot become a published claim.');
      const eventId = freshEventId(body.campaignId, entry.runId, entry.round, entry.boxId);
      if (!HASH.test(entry.eventId) || eventId.toLowerCase() !== entry.eventId.toLowerCase())
        throw new Error('Published event ID is not in this fresh campaign domain.');
      const key = requestKey(entry.runId, entry.round, entry.boxId);
      if (usedOpenings.has(key) || usedEvents.has(eventId)) throw new Error('Duplicate published box opening.');
      usedOpenings.add(key); usedEvents.add(eventId);
      return { eventId, recipient: getAddress(entry.recipient) };
    });
    const candidate = candidateClaimBatch({ chainId: CLAIM_CHAIN_ID, vault,
      batchId: rawBatch.batchId, entries: clean });
    if (candidate.root.toLowerCase() !== rawBatch.root.toLowerCase())
      throw new Error('Published Merkle root does not match its fresh event list.');
    const claims = candidate.entries.map(entry => ({ batchId: rawBatch.batchId, index: entry.index,
      eventId: entry.eventId, recipient: entry.recipient, root: candidate.root,
      proof: entry.proof, vault, chainId: CLAIM_CHAIN_ID }));
    for (const claim of claims) {
      const account = lower(claim.recipient);
      if (!byWallet.has(account)) byWallet.set(account, []);
      byWallet.get(account).push(claim);
      byEvent.set(claim.eventId.toLowerCase(), claim);
    }
    prepared.push({ batchId: rawBatch.batchId, root: candidate.root, claims });
  }
  const signer = getAddress(trustedPublisher);
  if (!input.attestation || lower(input.attestation.signer) !== lower(signer) ||
      !await verifyMessage({ address: signer, message: manifestSigningMessage(body),
        signature: input.attestation.signature }).catch(() => false)) {
    throw new Error('Manifest lacks a valid signature from the configured publisher.');
  }
  return Object.freeze({ campaignId: body.campaignId, chainId: CLAIM_CHAIN_ID, vault,
    token, rulesHash: requireHash(body.rulesHash), journalHead: requireHash(body.journalHead),
    digest: manifestDigest(body), signer, mockToken: lower(token) !== lower(MAINNET_CHOG),
    batches: prepared, claimsFor: address => [...(byWallet.get(lower(address)) || [])],
    claimFor: eventId => HASH.test(eventId) ? byEvent.get(eventId.toLowerCase()) || null : null });
}

export class CampaignClaimSessions {
  constructor(book, { now = () => Date.now() } = {}) {
    if (!book?.digest) throw new Error('A verified published claim book is required.');
    this.book = book; this.now = now; this.challenges = new Map(); this.sessions = new Map();
  }
  prune() {
    for (const [key, value] of this.challenges) if (value.expires <= this.now()) this.challenges.delete(key);
    for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
  }
  challenge(wallet, host) {
    const account = lower(wallet);
    if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]{1,180}$/.test(host)) throw new Error('Invalid claim site.');
    if (this.challenges.size >= 4000) this.prune();
    if (this.challenges.size >= 4000) throw new Error('Too many pending claim sign-ins.');
    const nonce = randomBytes(20).toString('hex'), expires = this.now() + 5 * 60_000;
    const message = `CHOGPIT REAL CLAIM WALLET LINK\nSite: ${host}\nCampaign: ${this.book.campaignId}\nMonad chain ID: 143\nVault: ${this.book.vault}\nManifest SHA256: ${this.book.digest}\nWallet: ${account}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nSign in only. No transfer or approval.`;
    this.challenges.set(nonce, { account, message, expires });
    return { nonce, message, expires };
  }
  async create({ wallet, nonce, signature }) {
    const entry = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!entry || entry.expires <= this.now() || lower(wallet) !== entry.account ||
      !await verifyMessage({ address: entry.account, message: entry.message, signature }).catch(() => false))
      throw new Error('Invalid, expired or replayed claim signature.');
    if (this.sessions.size >= 4000) this.prune();
    if (this.sessions.size >= 4000) throw new Error('Too many claim sign-ins.');
    const bearer = randomBytes(32).toString('hex');
    this.sessions.set(bearer, { account: entry.account, expires: this.now() + 60 * 60_000 });
    return { bearer, wallet: entry.account, expires: this.sessions.get(bearer).expires };
  }
  resolve(bearer) {
    if (typeof bearer !== 'string' || !/^[a-f0-9]{64}$/.test(bearer)) return null;
    const entry = this.sessions.get(bearer);
    if (!entry || entry.expires <= this.now()) { this.sessions.delete(bearer); return null; }
    return entry.account;
  }
}

// A durable *maximum gas budget* reserve is written before broadcasting. An
// uncertain transaction is deliberately never re-sent automatically after a
// crash; the operator must reconcile it against chain receipts first.
export class SponsorBudget {
  constructor(file, { maxTotalWei } = {}) {
    if (!file || file === ':memory:' || BigInt(maxTotalWei || 0) <= 0n) throw new Error('A persistent sponsor budget and positive cap are required.');
    this.file = path.resolve(file); this.limit = BigInt(maxTotalWei);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file, { timeout: 5000 });
    chmodSync(this.file, 0o600);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('observations','claim_events') LIMIT 1").get()) {
      this.db.close(); throw new Error('Never reuse the preview or local-test claim database as a sponsor budget.');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS budget_schema(name TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO budget_schema(name) VALUES('CHOGPIT_SPONSOR_BUDGET_V1');
      CREATE TABLE IF NOT EXISTS operations(
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, wallet TEXT NOT NULL,
        max_wei TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','broadcast','success','failed')),
        tx_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );`);
    if (this.db.pragma('quick_check(1)', { simple: true }) !== 'ok' ||
      this.db.prepare('SELECT COUNT(*) AS n FROM budget_schema').get().n !== 1 ||
      !this.db.prepare("SELECT 1 FROM budget_schema WHERE name='CHOGPIT_SPONSOR_BUDGET_V1'").get()) {
      this.db.close(); throw new Error('Invalid sponsor budget journal; do not silently reset.');
    }
  }
  close() { this.db.close(); }
  summary() {
    const records = this.db.prepare('SELECT max_wei,state FROM operations').all();
    const used = records.reduce((n, entry) => n + BigInt(entry.max_wei), 0n);
    return { capWei: this.limit.toString(), reservedOrSpentWei: used.toString(),
      remainingWei: (this.limit - used).toString(), operations: records.length };
  }
  reserve(key, kind, wallet, maximumWei) {
    const amount = BigInt(maximumWei), account = lower(wallet);
    if (!/^(redeem:0x[a-f0-9]{64}|withdraw:0x[a-f0-9]{40}:\d+:\d+)$/.test(key)
      || !['redeem','withdraw'].includes(kind) || amount <= 0n) throw new Error('Invalid sponsor operation.');
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM operations WHERE key=?').get(key))
        throw new Error('This sponsor operation is already reserved or submitted. Reconcile before retrying.');
      if (BigInt(this.summary().remainingWei) < amount) throw new Error('Sponsor total MON budget reached.');
      const now = Date.now();
      this.db.prepare('INSERT INTO operations(key,kind,wallet,max_wei,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(key, kind, account, amount.toString(), 'reserved', now, now);
    })();
  }
  broadcast(key, hash) {
    if (!HASH.test(hash)) throw new Error('Invalid broadcast transaction hash.');
    if (this.db.prepare("UPDATE operations SET state='broadcast',tx_hash=?,updated_at=? WHERE key=? AND state='reserved'")
      .run(hash.toLowerCase(), Date.now(), key).changes !== 1) throw new Error('Sponsor operation is not reserved.');
  }
  complete(key, success) {
    if (this.db.prepare('UPDATE operations SET state=?,updated_at=? WHERE key=? AND state=?')
      .run(success ? 'success' : 'failed', Date.now(), key, 'broadcast').changes !== 1)
      throw new Error('Sponsor operation was not broadcast.');
  }
  operation(key) { return this.db.prepare('SELECT * FROM operations WHERE key=?').get(key) || null; }
  nextWithdrawalKey(wallet, credit) {
    const account = lower(wallet);
    const previous = this.db.prepare("SELECT state FROM operations WHERE kind='withdraw' AND wallet=? ORDER BY created_at,key").all(account);
    // A broadcast with unknown outcome (or a failed transaction) must be
    // reconciled by an operator. Never bypass it by changing the credit value.
    if (previous.some(entry => entry.state !== 'success'))
      throw new Error('An earlier withdrawal needs operator reconciliation before another is sent.');
    return `withdraw:${account}:${previous.length + 1}:${BigInt(credit)}`;
  }
}

export class SponsoredClaims {
  constructor({ book, publicClient, walletClient, budget, expectedCodeHash,
    maxGasPriceWei, maxTxFeeWei, maxGas = MAX_GAS } = {}) {
    if (!book?.digest || !publicClient?.readContract || !walletClient?.writeContract ||
      !(budget instanceof SponsorBudget) || !HASH.test(expectedCodeHash)
      || BigInt(maxGasPriceWei || 0) <= 0n || BigInt(maxTxFeeWei || 0) <= 0n)
      throw new Error('Verified book, vault code hash, trusted signer and explicit gas budgets are required.');
    this.book = book; this.publicClient = publicClient; this.walletClient = walletClient;
    this.budget = budget; this.expectedCodeHash = expectedCodeHash.toLowerCase();
    this.maxGasPriceWei = BigInt(maxGasPriceWei); this.maxTxFeeWei = BigInt(maxTxFeeWei);
    this.maxGas = BigInt(maxGas); this.sponsor = getAddress(walletClient.account?.address || walletClient.account);
    if (this.maxGas <= 0n || this.maxGas > MAX_GAS || publicClient.chain?.id !== CLAIM_CHAIN_ID
      || walletClient.chain?.id !== CLAIM_CHAIN_ID)
      throw new Error('Sponsor and RPC must target the explicitly configured Monad chain ID 143.');
    this.queue = Promise.resolve();
  }
  async verifyVault() {
    if (await this.publicClient.getChainId() !== CLAIM_CHAIN_ID) throw new Error('RPC returned the wrong chain.');
    const code = await this.publicClient.getBytecode({ address: this.book.vault });
    if (!code || keccak256(code).toLowerCase() !== this.expectedCodeHash)
      throw new Error('Vault bytecode is not the independently allowlisted deployment.');
    const token = await this.publicClient.readContract({ address: this.book.vault, abi,
      functionName: 'chog' });
    if (lower(token) !== lower(this.book.token)) throw new Error('Vault token does not match the published campaign.');
    return { vault: this.book.vault, token: this.book.token, chainId: CLAIM_CHAIN_ID,
      sponsor: this.sponsor, mockOnly: this.book.mockToken };
  }
  async status() {
    const verified = await this.verifyVault();
    const read = functionName => this.publicClient.readContract({ address: this.book.vault,
      abi, functionName });
    const [balance, reserved, outstanding, credited, batches] = await Promise.all([
      this.publicClient.readContract({ address: this.book.token, abi: tokenAbi,
        functionName: 'balanceOf', args: [this.book.vault] }),
      read('reservedMaximum'), read('outstandingCredits'), read('lifetimeCredited'),
      Promise.all(this.book.batches.map(batch => this.publicClient.readContract({
        address: this.book.vault, abi, functionName: 'batches', args: [BigInt(batch.batchId)]
      })))
    ]);
    const rootsCommitted = batches.every((onchain, i) =>
      onchain[0]?.toLowerCase() === this.book.batches[i].root.toLowerCase() &&
      BigInt(onchain[3]) === BigInt(this.book.batches[i].claims.length));
    const oracleSeedsReady = rootsCommitted && batches.every(onchain => onchain[5] === true);
    const funded = balance > 0n && balance >= reserved + outstanding;
    const sponsorBudget = this.budget.summary();
    const ready = !this.book.mockToken && rootsCommitted && oracleSeedsReady && funded &&
      BigInt(sponsorBudget.remainingWei) > 0n && credited <= 1_000n * 10n ** 18n;
    return { ...verified, campaignId: this.book.campaignId, manifestDigest: this.book.digest,
      ready, claimsEnabled: ready, rootsCommitted, oracleSeedsReady, funded,
      vaultBalanceWei: balance.toString(), reservedMaximumWei: reserved.toString(),
      outstandingCreditsWei: outstanding.toString(), lifetimeCreditedWei: credited.toString(),
      sponsorBudget };
  }
  async proofState(claim) {
    const batch = await this.publicClient.readContract({ address: this.book.vault, abi,
      functionName: 'batches', args: [BigInt(claim.batchId)] });
    if (batch[0]?.toLowerCase() !== claim.root.toLowerCase() || BigInt(batch[3]) <= BigInt(claim.index))
      throw new Error('Published root or index is not committed on the verified vault.');
    if (!batch[5]) throw new Error('Oracle seed has not arrived for this claim.');
    return Boolean(await this.publicClient.readContract({ address: this.book.vault, abi,
      functionName: 'redeemed', args: [BigInt(claim.batchId), BigInt(claim.index)] }));
  }
  async credits(wallet) {
    await this.verifyVault();
    return this.publicClient.readContract({ address: this.book.vault, abi,
      functionName: 'creditOf', args: [getAddress(wallet)] });
  }
  // All sends are serialized for the sponsor nonce; a persisted reservation
  // remains even if the RPC fails, preventing blind retry after uncertainty.
  async #serialized(action) {
    const task = this.queue.catch(() => {}).then(action);
    this.queue = task;
    return task;
  }
  async #send(key, kind, recipient, functionName, args) {
    await this.verifyVault();
    const [balance, reserved, outstanding] = await Promise.all([
      this.publicClient.readContract({ address: this.book.token, abi: tokenAbi,
        functionName: 'balanceOf', args: [this.book.vault] }),
      this.publicClient.readContract({ address: this.book.vault, abi,
        functionName: 'reservedMaximum' }),
      this.publicClient.readContract({ address: this.book.vault, abi,
        functionName: 'outstandingCredits' })
    ]);
    if (balance < reserved + outstanding)
      throw new Error('Vault funding shortfall; sponsor will not submit a claim.');
    const request = { address: this.book.vault, abi, functionName, args, account: this.sponsor };
    await this.publicClient.simulateContract(request);
    const estimate = await this.publicClient.estimateContractGas(request);
    const gas = estimate * 12n / 10n + 10_000n;
    const price = await this.publicClient.getGasPrice();
    if (gas <= 0n || gas > this.maxGas || price > this.maxGasPriceWei ||
      gas * price > this.maxTxFeeWei) throw new Error('Sponsor gas estimate or price exceeded the approved cap.');
    this.budget.reserve(key, kind, recipient, gas * price);
    const txHash = await this.walletClient.writeContract({ ...request, gas, gasPrice: price });
    this.budget.broadcast(key, txHash);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash,
      confirmations: 1, timeout: 120000 });
    this.budget.complete(key, receipt.status === 'success');
    if (receipt.status !== 'success') throw new Error('Sponsored transaction reverted; operator reconciliation required.');
    return { txHash, recipient: getAddress(recipient), status: 'confirmed',
      explorer: `https://monadscan.com/tx/${txHash}` };
  }
  async redeem(wallet, eventId) {
    return this.#serialized(async () => {
      const account = lower(wallet), claim = this.book.claimFor(eventId);
      if (!claim || lower(claim.recipient) !== account) throw new Error('No published claim for this signed wallet and event.');
      await this.verifyVault();
      if (await this.proofState(claim)) throw new Error('This box has already been redeemed on-chain.');
      return this.#send(`redeem:${claim.eventId.toLowerCase()}`, 'redeem', account, 'redeem',
        [BigInt(claim.batchId), BigInt(claim.index), getAddress(account), claim.eventId, claim.proof]);
    });
  }
  async withdraw(wallet) {
    return this.#serialized(async () => {
      const account = lower(wallet);
      const credit = await this.credits(account);
      if (credit <= 0n) throw new Error('No positive on-chain CHOG credit to withdraw. There is no minimum.');
      // A successful prior withdrawal must not block a later *equal-sized*
      // award. A pending/unknown outcome DOES block until reconciled.
      const key = this.budget.nextWithdrawalKey(account, credit);
      return this.#send(key, 'withdraw', account, 'withdrawFor', [getAddress(account)]);
    });
  }
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};
async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10000) throw new Error('Request too large.');
  }
  return JSON.parse(text || '{}');
}

// Mount only on a separately approved claim service, NEVER on preview server.mjs.
export function sponsoredClaimHttpHandler({ relay, sessions } = {}) {
  if (!(relay instanceof SponsoredClaims) || !(sessions instanceof CampaignClaimSessions)
    || sessions.book !== relay.book) throw new Error('A matched verified book, sessions and sponsor relay are required.');
  const rate = new Map();
  return async (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return json(res, 400, { error: 'Invalid URL.' }); }
    if (!url.pathname.startsWith('/api/claims/')) return json(res, 404, { error: 'Not found.' });
    if (req.headers.origin) {
      try {
        if (!['http:', 'https:'].includes(new URL(req.headers.origin).protocol) ||
          new URL(req.headers.origin).host !== req.headers.host)
          return json(res, 403, { error: 'Cross-origin claims are not available.' });
      } catch { return json(res, 403, { error: 'Invalid origin.' }); }
    }
    const ip = req.socket.remoteAddress || 'unknown', now = Date.now();
    const entry = rate.get(ip) || { start: now, count: 0 };
    if (now - entry.start >= 60000) { entry.start = now; entry.count = 0; }
    rate.set(ip, entry); entry.count++;
    if (entry.count > 60) return json(res, 429, { error: 'Too many claim requests.' });
    try {
      if (url.pathname === '/api/claims/status' && req.method === 'GET') {
        const status = await relay.status();
        return json(res, 200, status);
      }
      if (url.pathname === '/api/claims/challenge' && req.method === 'GET')
        return json(res, 200, sessions.challenge(url.searchParams.get('wallet'), req.headers.host));
      if (url.pathname === '/api/claims/session' && req.method === 'POST')
        return json(res, 200, await sessions.create(await readJson(req)));
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const wallet = sessions.resolve(bearer);
      if (!wallet) return json(res, 401, { error: 'Sign in with your claim wallet first.' });
      if (url.pathname === '/api/claims/proofs' && req.method === 'GET') {
        await relay.verifyVault();
        const proofs = relay.book.claimsFor(wallet);
        const credits = await relay.credits(wallet);
        return json(res, 200, { campaignId: relay.book.campaignId, vault: relay.book.vault,
          recipient: wallet, proofs, onchainCreditWei: credits.toString(),
          notice: 'Proofs require an on-chain committed root and fulfilled oracle seed before sponsorship.' });
      }
      if (url.pathname === '/api/claims/redeem' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, await relay.redeem(wallet, body.eventId));
      }
      if (url.pathname === '/api/claims/withdraw' && req.method === 'POST') {
        const body = await readJson(req);
        if (Object.keys(body).length) throw new Error('Withdrawal sends only to the signed-in wallet.');
        return json(res, 200, await relay.withdraw(wallet));
      }
      return json(res, 404, { error: 'Unknown claim route.' });
    } catch (error) {
      const text = error?.message || 'Claim request failed.';
      const status = /already been redeemed|Oracle seed|not committed|No positive|No published|budget reached|already reserved/.test(text) ? 409
        : /signature|sign-in|signed wallet/i.test(text) ? 401
          : /Vault bytecode|wrong chain|Vault token|RPC/.test(text) ? 503 : 400;
      return json(res, status, { error: String(text).slice(0, 180) });
    }
  };
}
