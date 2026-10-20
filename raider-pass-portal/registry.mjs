import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getAddress } from 'viem';
import { PortalError } from './auth.mjs';

export function cleanAddress(value) {
  try {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw Error('address');
    return getAddress(value);
  } catch { throw new PortalError(400, 'A valid EVM address is required.'); }
}

function checkIdentity({ accountId, userIdHash }) {
  if (typeof accountId !== 'string' || !/^[0-9a-f]{64}$/.test(accountId) ||
      typeof userIdHash !== 'string' || !/^[0-9a-f]{64}$/.test(userIdHash))
    throw new PortalError(403, 'Signed Privy account identity is required.');
}

export class PreviewRegistry {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      chmodSync(dbPath, 0o600);
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      user_id_hash TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL UNIQUE,
      hero_json TEXT,
      bound_at INTEGER NOT NULL
    );`);
    // Do not silently reuse the old MetaMask-only DB; provider and wallet
    // identity changed. Owner must back it up and use a fresh preview DB.
    const columns = this.db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name);
    if (!columns.includes('user_id_hash')) {
      this.db.close();
      throw Error('Incompatible old provider preview DB. Back it up and use a new PASS_PORTAL_DB_PATH.');
    }
    if (!columns.includes('hero_json')) {
      this.db.exec('ALTER TABLE accounts ADD COLUMN hero_json TEXT');
    }
  }
  close() { this.db.close(); }
  me(identity) {
    checkIdentity(identity);
    const row = this.db.prepare('SELECT user_id_hash, address, hero_json, bound_at FROM accounts WHERE account_id = ?')
      .get(identity.accountId);
    if (row && row.user_id_hash !== identity.userIdHash)
      throw new PortalError(409, 'This email belongs to a different Privy user. Recovery needs manual review.');
    const hero = row?.hero_json ? JSON.parse(row.hero_json) : null;
    return row ? { state: 'REGISTERED_NO_NFT', address: row.address, hero,
      boundAt: new Date(row.bound_at).toISOString(), tokenId: null, nftContract: null,
      claimEnabled: false } : { state: 'NOT_REGISTERED', address: null, hero: null,
      tokenId: null, nftContract: null, claimEnabled: false };
  }
  register({ accountId, userIdHash, address, now = Date.now() }) {
    const identity = { accountId, userIdHash };
    checkIdentity(identity);
    const wallet = cleanAddress(address);
    try {
      return this.db.transaction(() => {
        const current = this.me(identity);
        if (current.address) {
          if (current.address !== wallet)
            throw new PortalError(409, 'This email is bound to another wallet. Recovery requires manual review.');
          return current;
        }
        // Hackathon fast path: every registration auto-rolls a CHOG-inspired hero face.
        // No mint tx, no gas, purely server-random. Real CHOG payout still gated separately.
        const hero = this.rollHero(accountId, wallet, now);
        this.db.prepare('INSERT INTO accounts(account_id, user_id_hash, address, hero_json, bound_at) VALUES (?, ?, ?, ?, ?)')
          .run(accountId, userIdHash, wallet, JSON.stringify(hero), now);
        return this.me(identity);
      })();
    } catch (error) {
      if (error instanceof PortalError) throw error;
      if (error.code?.startsWith('SQLITE_CONSTRAINT'))
        throw new PortalError(409, 'This Privy user or wallet is already registered to another email.');
      throw error;
    }
  }
  rollHero(accountId, wallet, now) {
    // deterministic-ish for same email but still feels random to user
    const seed = BigInt('0x' + accountId.slice(0, 12)) ^ BigInt(now) ^ BigInt(wallet.slice(2, 10).padStart(12,'0'));
    const backgrounds = ["Aqua Depths","Lime Grid","Sky Blue","Red Sky","Lemon Yellow","Light Purple","Monad Purple","Void Black"];
    const bodies = ["Prisoner Wrap","Zero THOTS Tee","Gangster Coat","Wizard Cape","Banana Suit","Royal Guard","Scrap Armor","Neon Racer"];
    const eyes = ["Closed Crying","Clown Ring","Tired Half","Fire Laser","Dead Flat","Side Eye","Holo Scan","Prism Gaze"];
    const auras = ["None","Royal Blue Aura","Royal Aura","Ember Aura","Frost Aura","Monad Pulse"];
    const hero = {
      background: backgrounds[Number(seed % 8n)],
      body: bodies[Number((seed>>8n) % 8n)],
      eyes: eyes[Number((seed>>16n) % 8n)],
      aura: auras[Number((seed>>24n) % 6n)],
      tier: Number((seed % 3n) + 1n),
      color: ["#0ea5a0","#a3e635","#38bdf8","#f43f5e","#facc15","#c084fc","#6d28d9","#111827"][Number(seed % 8n)],
      mintedAt: new Date(now).toISOString()
    };
    hero.name = `${hero.body} • ${hero.eyes}`;
    return hero;
  }
}
