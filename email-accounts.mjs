// Isolated EMAIL-ACCOUNT candidate, NOT mounted on the hosted game. A single-
// use magic link proves access to one inbox at that moment. It does NOT prove
// age, location, wallet control, or that multiple addresses belong to different
// people. No email sender is built in: inject an actual delivery service before
// considering an operational launch. Never log links, bearer tokens or mail.
import { createHash, randomBytes } from 'node:crypto';
import { getAddress } from 'viem';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha = (domain, value) => createHash('sha256')
  .update(`CHOGPIT_${domain}_V1\n${value}`).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const LINK_TTL = 10 * 60 * 1000;
const SESSION_TTL = 60 * 60 * 1000;
const MIN_INTERVAL = 60 * 1000;
const HOUR_LIMIT = 3;

// Deliberately restricted to ASCII mailbox syntax in this prototype. Treat
// local-part case as equivalent; provider-specific +aliases/dots are NOT
// unified. A person may still use many different addresses.
export function normalizeCampaignEmail(input) {
  if (typeof input !== 'string' || input.length > 320)
    throw new Error('Enter an email address.');
  const email = input.trim().toLowerCase();
  const parts = email.split('@');
  if (email.length > 254 || parts.length !== 2 || parts[0].length > 64
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])
    || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..'))
    throw new Error('Enter a supported email address.');
  const labels = parts[1].split('.');
  if (labels.length < 2 || labels.some(label => label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    || labels.at(-1).length < 2)
    throw new Error('Enter a supported email address.');
  return email;
}

export class EmailAccounts {
  constructor(intake, { origin, sendMagicLink, now = () => Date.now() } = {}) {
    if (intake?.accountMethod !== 'email' || !intake?.db
      || typeof origin !== 'string' || typeof sendMagicLink !== 'function')
      throw new Error('Email accounts require a separate email campaign journal, exact origin and injected mail sender.');
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || !(url.protocol === 'https:' ||
        url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      throw new Error('Email magic links require a canonical HTTPS origin (localhost HTTP for tests).');
    this.intake = intake; this.db = intake.db; this.now = now;
    this.origin = origin; this.sendMagicLink = sendMagicLink;
    this.db.exec(`CREATE TABLE IF NOT EXISTS email_magic_links(
        token_hash TEXT PRIMARY KEY, normalized_email TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('login','address')),
        account_id TEXT, address TEXT, issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS email_sessions(
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_link_limits
        ON email_magic_links(normalized_email,purpose,issued_at);
      CREATE INDEX IF NOT EXISTS idx_email_session_expiry ON email_sessions(expires_at);
    `);
    this.intake.audit();
  }
  #time() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time <= 0)
      throw new Error('A trusted server clock is required.');
    return time;
  }
  async #send({ email, purpose, accountId = null, address = null }) {
    const time = this.#time();
    const count = this.db.prepare(`SELECT COUNT(*) AS n,MAX(issued_at) AS latest
      FROM email_magic_links WHERE normalized_email=? AND purpose=? AND issued_at>?`)
      .get(email,purpose,time-60*60*1000);
    if (count.n >= HOUR_LIMIT || count.latest !== null && time-count.latest < MIN_INTERVAL)
      throw new Error('Please wait before requesting another email link.');
    const token = secret(), hash = sha('EMAIL_LINK',token);
    // The fragment is never sent in the HTTP request to the landing page.
    // A human must deliberately POST it; do not auto-consume on GET (mail
    // scanners often prefetch). The sender must not include third-party pixels.
    const url = `${this.origin}/campaign-email-account.html#${purpose}=${token}`;
    const expiresAt = time + LINK_TTL;
    this.db.prepare(`INSERT INTO email_magic_links
      (token_hash,normalized_email,purpose,account_id,address,issued_at,expires_at)
      VALUES(?,?,?,?,?,?,?)`).run(hash,email,purpose,accountId,address,time,expiresAt);
    try {
      await this.sendMagicLink({ to: email, purpose, url, expiresAt });
    } catch {
      this.db.prepare('DELETE FROM email_magic_links WHERE token_hash=?').run(hash);
      throw new Error('Email delivery failed; no login link was issued.');
    }
    // Never return the link/token here. It is delivered to the inbox only.
    return { sent: true, expiresAt, note: 'Check your inbox; only the most recently requested link is needed.' };
  }
  async requestLogin(email) {
    return this.#send({ email: normalizeCampaignEmail(email),purpose:'login' });
  }
  #lookup(token, purpose) {
    if (typeof token !== 'string' || !TOKEN.test(token))
      throw new Error('The email link is invalid or expired.');
    const hash = sha('EMAIL_LINK',token);
    const row = this.db.prepare('SELECT * FROM email_magic_links WHERE token_hash=?').get(hash);
    if (!row || row.purpose !== purpose || row.used_at !== null || row.expires_at <= this.#time())
      throw new Error('The email link is invalid, expired or already used.');
    return row;
  }
  #consume(row) {
    if (this.db.prepare(`UPDATE email_magic_links SET used_at=?
      WHERE token_hash=? AND used_at IS NULL AND expires_at>?`)
      .run(this.#time(),row.token_hash,this.#time()).changes !== 1)
      throw new Error('The email link is invalid, expired or already used.');
  }
  #session(accountId) {
    const session = secret();
    this.db.prepare('INSERT INTO email_sessions VALUES(?,?,?)')
      .run(sha('EMAIL_SESSION',session),accountId,this.#time()+SESSION_TTL);
    return session;
  }
  finishLogin(token) {
    return this.db.transaction(() => {
      const pending = this.#lookup(token,'login');
      this.#consume(pending);
      const accountId = this.intake.registerVerifiedEmailAccount(pending.normalized_email);
      return { accountId, session: this.#session(accountId),
        payoutAddress: this.db.prepare('SELECT payout_address FROM accounts WHERE account_id=?')
          .get(accountId).payout_address, mainnetClaimable: false };
    })();
  }
  account(session) {
    if (typeof session !== 'string' || !TOKEN.test(session))
      throw new Error('Email account session is required.');
    const row = this.db.prepare(`SELECT a.* FROM email_sessions s
      JOIN accounts a ON a.account_id=s.account_id
      JOIN email_identities e ON e.account_id=s.account_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(sha('EMAIL_SESSION',session),this.#time());
    if (!row) throw new Error('Email session expired. Sign in with a new link.');
    return { accountId:row.account_id,payoutAddress:row.payout_address,
      addressLocked:row.address_locked_at !== null };
  }
  signOut(session) {
    if (typeof session === 'string' && TOKEN.test(session))
      this.db.prepare('DELETE FROM email_sessions WHERE token_hash=?')
        .run(sha('EMAIL_SESSION',session));
  }
  async requestAddressConfirmation({ session, address, confirmAddress }) {
    const { accountId, addressLocked } = this.account(session);
    if (address !== confirmAddress || typeof address !== 'string')
      throw new Error('Enter the same destination twice.');
    const destination = getAddress(address);
    if (addressLocked || /^0x0{40}$/i.test(destination)
      || [this.intake.vault,this.intake.token]
        .some(value => value.toLowerCase() === destination.toLowerCase()))
      throw new Error('This address cannot be confirmed for this account.');
    if (!this.db.prepare('SELECT 1 FROM openings WHERE account_id=?').get(accountId))
      throw new Error('Open a server-verified box before confirming a payout address.');
    const identity = this.db.prepare('SELECT normalized_email FROM email_identities WHERE account_id=?')
      .get(accountId);
    if (!identity) throw new Error('The inbox has not been verified.');
    return this.#send({ email:identity.normalized_email,purpose:'address',
      accountId,address:destination.toLowerCase() });
  }
  finishAddressConfirmation({ session, token }) {
    const { accountId } = this.account(session);
    return this.db.transaction(() => {
      const pending = this.#lookup(token,'address');
      const identity = this.db.prepare('SELECT normalized_email FROM email_identities WHERE account_id=?')
        .get(accountId);
      if (pending.account_id !== accountId || !identity
        || pending.normalized_email !== identity.normalized_email)
        throw new Error('This email link belongs to another account.');
      this.#consume(pending);
      // One transaction binds the freshly verified inbox, immutable receipt,
      // and destination. An audit insert failure rolls back token consumption.
      const result = this.intake.recordVerifiedAddress(accountId,pending.address);
      return { accountId,payoutAddress:result.address,
        addressLocked:this.account(session).addressLocked,
        warning:'An email link does not prove wallet ownership. Check the address: it locks when first batched.' };
    })();
  }
}
