// Cryptographically verified WebAuthn passkey accounts for the threshold-campaign
// candidate. Shares the same SQLite connection as LateBoundCampaignIntake so
// account/address changes and event sealing use the same database. A passkey
// authenticates an account; it does NOT prove wallet ownership or one-human-one-
// account. There is deliberately no wallet connect, signature or private key.
import { createHash, randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';

const secureToken = () => randomBytes(32).toString('base64url');
const sha = value => createHash('sha256').update(value).digest('hex');
const lifetime = 5 * 60 * 1000;
const sessionLifetime = 60 * 60 * 1000;
const MAX = 10_000;
export class PasskeyAccounts {
  constructor(intake, { rpID, origin, now = () => Date.now() } = {}) {
    if (intake?.accountMethod !== 'passkey' || !intake?.db
      || typeof rpID !== 'string' || typeof origin !== 'string')
      throw new Error('Passkey accounts require a late-bound intake, relying-party ID and origin.');
    const url = new URL(origin);
    if (url.hostname !== rpID || url.origin !== origin ||
      !(url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(rpID))))
      throw new Error('WebAuthn requires an exact HTTPS origin/RP ID (localhost allowed for tests).');
    this.intake = intake; this.db = intake.db; this.rpID = rpID;
    this.origin = origin; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS passkey_credentials(
        credential_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id),
        public_key BLOB NOT NULL, sign_count INTEGER NOT NULL,
        transports TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS passkey_pending(
        request_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        challenge TEXT NOT NULL, account_id TEXT, address TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS passkey_sessions(
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_passkey_pending_ttl ON passkey_pending(expires_at);
      CREATE INDEX IF NOT EXISTS idx_passkey_sessions_ttl ON passkey_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_passkey_credentials_account ON passkey_credentials(account_id);
    `);
  }
  #pending(kind, challenge, accountId = null, address = null) {
    const requestId = secureToken(), expiresAt = this.now() + lifetime;
    this.db.prepare('DELETE FROM passkey_pending WHERE expires_at < ?').run(this.now());
    this.db.prepare('INSERT INTO passkey_pending VALUES(?,?,?,?,?,?)')
      .run(requestId, kind, challenge, accountId, address, expiresAt);
    return requestId;
  }
  #consume(requestId, kind) {
    if (typeof requestId !== 'string' || requestId.length > 100)
      throw new Error('Invalid WebAuthn request ID.');
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM passkey_pending WHERE request_id=? AND kind=?')
        .get(requestId, kind);
      if (!row) throw new Error('WebAuthn challenge is missing or already used.');
      this.db.prepare('DELETE FROM passkey_pending WHERE request_id=?').run(requestId);
      if (row.expires_at <= this.now()) throw new Error('WebAuthn challenge expired.');
      return row;
    })();
  }
  #session(accountId) {
    const session = secureToken();
    this.db.prepare('DELETE FROM passkey_sessions WHERE expires_at < ?').run(this.now());
    this.db.prepare('INSERT INTO passkey_sessions VALUES(?,?,?)')
      .run(sha(session), accountId, this.now() + sessionLifetime);
    return session;
  }
  account(session) {
    if (typeof session !== 'string' || session.length < 20 || session.length > 128)
      throw new Error('Passkey account session is required.');
    const row = this.db.prepare(`SELECT a.* FROM passkey_sessions s
      JOIN accounts a ON a.account_id=s.account_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(sha(session), this.now());
    if (!row) throw new Error('Account session expired. Sign in with your passkey again.');
    return { accountId: row.account_id, payoutAddress: row.payout_address,
      addressLocked: row.address_locked_at !== null };
  }
  signOut(session) {
    if (typeof session === 'string' && session.length >= 20 && session.length <= 128)
      this.db.prepare('DELETE FROM passkey_sessions WHERE token_hash=?').run(sha(session));
  }
  async beginRegistration() {
    if (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n >= MAX)
      throw new Error('Account registration is currently closed.');
    const accountId = randomBytes(16).toString('hex');
    const options = await generateRegistrationOptions({
      rpName: 'CHOGPIT', rpID: this.rpID,
      userID: new Uint8Array(Buffer.from(accountId, 'hex')),
      userName: `CHOGPIT Raider ${accountId.slice(0,8)}`,
      attestationType: 'none', timeout: 60000,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257]
    });
    return { requestId: this.#pending('register', options.challenge, accountId), options };
  }
  async finishRegistration({ requestId, response }) {
    const pending = this.#consume(requestId, 'register');
    const result = await verifyRegistrationResponse({ response,
      expectedChallenge: pending.challenge, expectedOrigin: this.origin,
      expectedRPID: this.rpID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo?.credential)
      throw new Error('Passkey registration did not verify.');
    const credential = result.registrationInfo.credential, time = this.now();
    const accountId = pending.account_id;
    const session = this.db.transaction(() => {
      this.db.prepare('INSERT INTO accounts(account_id,created_at) VALUES(?,?)').run(accountId,time);
      this.db.prepare(`INSERT INTO passkey_credentials
        (credential_id,account_id,public_key,sign_count,transports,created_at)
        VALUES(?,?,?,?,?,?)`).run(credential.id, accountId, Buffer.from(credential.publicKey),
        credential.counter, JSON.stringify(credential.transports || []), time);
      return this.#session(accountId);
    })();
    return { accountId, session, payoutAddress: null, addressLocked: false };
  }
  async beginAuthentication() {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID, userVerification: 'required', timeout: 60000 });
    return { requestId: this.#pending('authenticate', options.challenge), options };
  }
  #credential(response) {
    if (typeof response?.id !== 'string' || response.id.length < 8 || response.id.length > 1024)
      throw new Error('Invalid passkey credential ID.');
    const row = this.db.prepare('SELECT * FROM passkey_credentials WHERE credential_id=?')
      .get(response.id);
    if (!row) throw new Error('Unknown passkey credential.');
    return row;
  }
  async #verify(response, challenge, expectedAccountId = null) {
    const credential = this.#credential(response);
    if (expectedAccountId && credential.account_id !== expectedAccountId)
      throw new Error('The passkey does not belong to this account.');
    const result = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: this.origin,
      expectedRPID: this.rpID, requireUserVerification: true,
      credential: { id: credential.credential_id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.sign_count,
        transports: JSON.parse(credential.transports) }
    });
    if (!result.verified) throw new Error('Passkey assertion did not verify.');
    return { credential, newCounter: result.authenticationInfo.newCounter };
  }
  async finishAuthentication({ requestId, response }) {
    const pending = this.#consume(requestId, 'authenticate');
    const { credential, newCounter } = await this.#verify(response, pending.challenge);
    const session = this.db.transaction(() => {
      if (this.db.prepare(`UPDATE passkey_credentials SET sign_count=?
        WHERE credential_id=? AND sign_count=?`).run(newCounter,
        credential.credential_id, credential.sign_count).changes !== 1)
        throw new Error('Concurrent passkey counter update.');
      return this.#session(credential.account_id);
    })();
    return { ...this.account(session), session };
  }
  #destination(accountId, input) {
    const address = getAddress(input);
    if (/^0x0{40}$/i.test(address) ||
      [this.intake.vault, this.intake.token].some(a => a.toLowerCase() === address.toLowerCase()))
      throw new Error('This is not a valid player payout destination.');
    const current = this.db.prepare('SELECT payout_address,address_locked_at FROM accounts WHERE account_id=?')
      .get(accountId);
    if (!current || current.address_locked_at && current.payout_address?.toLowerCase() !== address.toLowerCase())
      throw new Error('This payout address was locked when the first batch was sealed.');
    if (!this.db.prepare('SELECT 1 FROM openings WHERE account_id=? LIMIT 1').get(accountId))
      throw new Error('Open a real campaign box before entering a payout address.');
    return address;
  }
  async beginAddressConfirmation({ session, address }) {
    const { accountId } = this.account(session), destination = this.#destination(accountId,address);
    const credentials = this.db.prepare('SELECT credential_id,transports FROM passkey_credentials WHERE account_id=?')
      .all(accountId);
    if (!credentials.length) throw new Error('No passkey is registered for this account.');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID, userVerification: 'required', timeout: 60000,
      allowCredentials: credentials.map(c => ({ id: c.credential_id,
        transports: JSON.parse(c.transports) }))
    });
    return { requestId: this.#pending('bind', options.challenge, accountId, destination), options,
      destination, warning: 'A pasted address does not prove that you control it. Check it carefully.' };
  }
  async finishAddressConfirmation({ session, requestId, response }) {
    const accountId = this.account(session).accountId;
    const pending = this.#consume(requestId, 'bind');
    if (pending.account_id !== accountId)
      throw new Error('This address confirmation belongs to a different account.');
    const { credential, newCounter } = await this.#verify(response,pending.challenge,accountId);
    return this.db.transaction(() => {
      const destination = this.#destination(accountId,pending.address);
      if (this.db.prepare(`UPDATE passkey_credentials SET sign_count=?
        WHERE credential_id=? AND sign_count=?`).run(newCounter,
        credential.credential_id, credential.sign_count).changes !== 1)
        throw new Error('Concurrent passkey counter update.');
      // The validated assertion, credential counter, address and hash-linked
      // receipt commit together. A failed receipt rolls back the destination.
      const bound=this.intake.recordVerifiedAddress(accountId,destination);
      return { accountId, payoutAddress: bound.address,
        addressLocked: this.account(session).addressLocked,
        warning: 'This address is not yours unless you control its private keys. It locks permanently when batched.' };
    })();
  }
}
