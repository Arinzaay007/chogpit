// SIMULATION ONLY. This ledger never creates a debt, voucher, token claim, or
// mainnet entitlement. Do not export its entries to a real reward contract.
import { randomBytes, randomInt } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAddress, verifyMessage } from 'viem';

export const PREVIEW_POOL = 1000;
export const PREVIEW_DAILY_BOX_LIMIT = 5; // Anti-spam in this playtest; NOT final prize terms.

// A cryptographic server-side sample is good for testing the UI, but it is NOT
// publicly verifiable randomness for a prize-bearing campaign.
export function previewPrize(roll = randomInt(100)) {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 100) throw new Error('Invalid prize roll.');
  return roll < 70 ? 5 : roll < 95 ? 10 : 25;
}
const emptyState = () => ({ version: 1, spent: 0, accounts: {}, events: {} });
const wallet = address => getAddress(address).toLowerCase();
const validEvent = id => typeof id === 'string' && /^[a-f0-9]{32}:[1-9]\d{0,5}:[0-3]$/.test(id);

export class RewardPreview {
  constructor(file, state = emptyState(), { draw = () => randomInt(100), now = () => Date.now() } = {}) {
    this.file = file; this.state = state; this.draw = draw; this.now = now; this.queue = Promise.resolve();
    if (state.version !== 1 || !Number.isInteger(state.spent) || state.spent < 0 || state.spent > PREVIEW_POOL
      || !state.accounts || !state.events || Array.isArray(state.accounts) || Array.isArray(state.events)) {
      throw new Error('Invalid preview ledger. Do not silently reset existing reward records.');
    }
  }
  static async load(file, options = {}) {
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return new RewardPreview(file, state || emptyState(), options);
  }
  status() {
    return { previewOnly: true, payoutsEnabled: false, funded: false, transferable: false,
      poolExample: PREVIEW_POOL, simulatedSpent: this.state.spent, simulatedRemaining: PREVIEW_POOL - this.state.spent,
      dailyBoxLimit: PREVIEW_DAILY_BOX_LIMIT,
      prizes: [{ amount: 5, percent: 70 }, { amount: 10, percent: 25 }, { amount: 25, percent: 5 }] };
  }
  balance(address) {
    const account = this.state.accounts[wallet(address)] || { total: 0, boxes: 0 };
    return { previewBalance: account.total, previewBoxes: account.boxes,
      withdrawable: false, funded: false };
  }
  sampleOnly() {
    return { status: 'sample-only', amount: previewPrize(this.draw()), previewBalance: null,
      note: 'Wallet not linked. This is a non-redeemable sample, not a token award.' };
  }
  credit({ account, eventId, mode, arenaId }) {
    const address = wallet(account);
    if (!validEvent(eventId) || !['solo', 'pvp'].includes(mode) || typeof arenaId !== 'string' || arenaId.length > 12) {
      throw new Error('Invalid server-generated preview event.');
    }
    // Commit serialized, including the disk write. A failed write leaves the
    // in-memory state unchanged; later requests can still retry safely.
    const task = this.queue.catch(() => {}).then(async () => {
      const old = this.state.events[eventId];
      if (old) return old.account === address ? { status: 'duplicate', ...this.balance(address) } : { status: 'event-used' };
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const previous = this.state.accounts[address] || { total: 0, boxes: 0, days: {} };
      if ((previous.days?.[day] || 0) >= PREVIEW_DAILY_BOX_LIMIT) {
        return { status: 'daily-limit', ...this.balance(address) };
      }
      if (this.state.spent >= PREVIEW_POOL) return { status: 'pool-empty', ...this.balance(address) };
      const amount = previewPrize(this.draw());
      if (this.state.spent + amount > PREVIEW_POOL) {
        return { status: 'pool-empty', ...this.balance(address) }; // No biased reroll or partial prize.
      }
      const next = structuredClone(this.state);
      next.spent += amount;
      next.events[eventId] = { account: address, amount, mode, arenaId, at: new Date(this.now()).toISOString() };
      next.accounts[address] = { total: previous.total + amount, boxes: previous.boxes + 1,
        days: { ...previous.days, [day]: (previous.days?.[day] || 0) + 1 } };
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
      this.state = next;
      return { status: 'preview-credit', account: address, amount,
        ...this.balance(address), simulatedRemaining: PREVIEW_POOL - next.spent };
    });
    this.queue = task;
    return task;
  }
}

export class RewardSessions {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now; this.challenges = new Map(); this.sessions = new Map();
  }
  challenge(address, host) {
    const account = wallet(address);
    if (!/^[a-zA-Z0-9.:-]{1,180}$/.test(host)) throw new Error('Invalid request host.');
    if (this.challenges.size >= 4000) this.prune();
    if (this.challenges.size >= 4000) throw new Error('Preview sign-ins are busy. Try again later.');
    const nonce = randomBytes(20).toString('hex');
    const expires = this.now() + 5 * 60_000;
    const message = `CHOGPIT PREVIEW wallet link\nSite: ${host}\nWallet: ${account}\nMonad chain ID: 143\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nSign in only; no transaction. Preview points are not real or claimable CHOG.`;
    this.challenges.set(nonce, { account, message, expires });
    return { nonce, message, expires };
  }
  async create({ account, nonce, signature }) {
    const entry = this.challenges.get(nonce);
    this.challenges.delete(nonce); // One-time even if a bad signature is supplied.
    if (!entry || entry.expires < this.now() || wallet(account) !== entry.account) throw new Error('Preview signature challenge expired or mismatched.');
    const verified = await verifyMessage({ address: entry.account, message: entry.message, signature }).catch(() => false);
    if (!verified) throw new Error('Preview wallet signature not verified.');
    if (this.sessions.size >= 4000) this.prune();
    if (this.sessions.size >= 4000) throw new Error('Preview sign-ins are busy. Try again later.');
    const session = randomBytes(32).toString('hex');
    const expires = this.now() + 60 * 60_000;
    this.sessions.set(session, { account: entry.account, expires });
    return { session, account: entry.account, expires };
  }
  resolve(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const item = this.sessions.get(token);
    if (!item || item.expires <= this.now()) { this.sessions.delete(token); return null; }
    return item.account;
  }
  prune() {
    for (const [key, value] of this.challenges) if (value.expires < this.now()) this.challenges.delete(key);
    for (const [key, value] of this.sessions) if (value.expires < this.now()) this.sessions.delete(key);
  }
}
