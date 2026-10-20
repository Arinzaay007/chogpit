import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { PRIVY_ISSUER, createIdentityVerifier } from '../auth.mjs';
import { PreviewRegistry } from '../registry.mjs';
import { createPortalServer, portalConfiguration } from '../server.mjs';

const providerSource = readFileSync(new URL('../src/provider.jsx', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../src/portal.js', import.meta.url), 'utf8');
assert.match(providerSource, /useLogin\(/);
assert.match(providerSource, /loginMethods: \['email'\]/);
assert.match(providerSource, /createOnLogin: 'users-without-wallets'/);
assert.match(providerSource, /getIdentityToken\(\)/);
assert.doesNotMatch(providerSource.replace(/\/\/[^\n]*/g, ''),
  /loginWithCode|useLoginWithEmail|connectWallet\(|linkWallet\(|signMessage\(|signTypedData\(|sendTransaction\(/,
  'Modal auto-creation, never whitelabel, external connection, wallet signature or transaction.');
assert.doesNotMatch(browserSource, /\/api\/pass-portal\/(?:challenge|bind|claim|mint)/,
  'The browser cannot request registration signing or a real mint.');

const appId = 'owner-issued-privy-app-id';
const origin = 'https://owner-preview.example';
const key = Buffer.alloc(32, 0x53); // disposable synthetic-test key
const { privateKey, publicKey } = await generateKeyPair('ES256');
const verificationKey = await exportSPKI(publicKey);
const verifyIdentity = createIdentityVerifier({ appId, verificationKey, hashKey: key });
const wallet = privateKeyToAccount(`0x${'24'.repeat(32)}`);
const anotherWallet = privateKeyToAccount(`0x${'25'.repeat(32)}`);
const emailAccount = address => ({ type: 'email', address });
const walletAccount = address => ({ type: 'wallet', walletClientType: 'privy',
  chainType: 'ethereum', address });
const signedAccounts = [emailAccount('RaiDer@Example.com'), walletAccount(wallet.address)];
const did = 'did:privy:realistic-synthetic-user-01';
const now = Math.floor(Date.now() / 1000);
async function token(overrides = {}) {
  const { issuer = PRIVY_ISSUER, audience = appId, subject = did,
    issuedAt = now, expiration = now + 3600, signingKey = privateKey,
    linkedAccounts = signedAccounts, ...otherClaims } = overrides;
  const claims = { linked_accounts: typeof linkedAccounts === 'string' ? linkedAccounts :
    JSON.stringify(linkedAccounts), ...otherClaims };
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'ES256' })
    .setIssuer(issuer).setAudience(audience).setIssuedAt(issuedAt).setExpirationTime(expiration);
  if (subject !== null) jwt = jwt.setSubject(subject);
  return jwt.sign(signingKey);
}
const credential = await token();
const verified = await verifyIdentity(credential);
assert.equal(verified.email, 'raider@example.com');
assert.deepEqual(verified.embeddedAddresses, [wallet.address], 'Privy-signed embedded wallet only.');
assert.equal((await verifyIdentity(await token({ linkedAccounts: [emailAccount('raider@example.com'),
  walletAccount(wallet.address)] }))).accountId, verified.accountId);
assert.notEqual((await verifyIdentity(await token({ subject: 'did:privy:another-synthetic-user-02' }))).userIdHash,
  verified.userIdHash, 'DID is separately bound to prevent replacement by the same email.');
assert.equal((await verifyIdentity(await token({ linkedAccounts: [emailAccount('raider@example.com'),
  { type: 'wallet', chain_type: 'ethereum', walletClient: 'privy', address: wallet.address }] })))
  .embeddedAddresses[0], wallet.address, 'Privy-linked lightweight/API wallet shape accepted.');
const otherKeyPair = await generateKeyPair('ES256');
const invalidTokens = [
  await token({ issuer: 'https://attacker.example' }),
  await token({ audience: 'attacker-app-id' }),
  await token({ audience: [appId, 'attacker-app-id'] }),
  await token({ expiration: now - 2 }),
  await token({ issuedAt: now + 3600 }),
  await token({ issuedAt: now - 3 * 3600, expiration: now + 3600 }),
  await token({ subject: null }),
  await token({ subject: 'not-a-privy-did' }),
  await token({ linkedAccounts: null }),
  await token({ linkedAccounts: [{ type: 'wallet', address: wallet.address,
    walletClientType: 'privy', chainType: 'ethereum' }] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    emailAccount('farmer@example.com'), walletAccount(wallet.address)] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    { type: 'wallet', address: wallet.address, chainType: 'ethereum', walletClientType: 'metamask' }] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    { type: 'smart_wallet', address: wallet.address, chainType: 'ethereum', walletClientType: 'privy' }] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    { ...walletAccount(wallet.address), wallet_client_type: 'metamask' }] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    { ...walletAccount(wallet.address), chain_type: 'solana' }] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    { type: 'wallet', address: wallet.address, chainType: 'ethereum' }] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    walletAccount('0xinvalid')] }),
  await token({ linkedAccounts: [emailAccount('raider@example.com'),
    walletAccount(wallet.address), walletAccount(anotherWallet.address)] }),
  await token({ signingKey: otherKeyPair.privateKey }),
  await token({ linkedAccounts: '[this is not JSON' })
];
for (const forged of invalidTokens)
  await assert.rejects(() => verifyIdentity(forged), /identity|email|wallet|linked|privy/i,
    'Invalid signature, issuer, audience, age, DID or linked account must fail closed.');
await assert.rejects(() => verifyIdentity('not.a.token'), /identity/i);

const baseEnv = { PRIVY_APP_ID: appId, PRIVY_IDENTITY_PUBLIC_KEY: verificationKey,
  PASS_PORTAL_ORIGIN: origin, PASS_ACCOUNT_HMAC_KEY: key.toString('base64url'), PASS_PORTAL_PREVIEW: '1' };
assert.equal(portalConfiguration({ ...baseEnv, NODE_ENV: 'production' }).ready, false);
assert.equal(portalConfiguration({ ...baseEnv, PASS_PORTAL_ORIGIN: 'http://untrusted.example' }).ready, false);
assert.equal(portalConfiguration({ ...baseEnv, PRIVY_IDENTITY_PUBLIC_KEY: '' }).ready, false);
assert.equal(portalConfiguration({ ...baseEnv, PRIVY_APP_ID: '' }).ready, false);
assert.equal(portalConfiguration({ ...baseEnv, PASS_ACCOUNT_HMAC_KEY: '' }).ready, false);
assert.equal(portalConfiguration({ WEB3AUTH_CLIENT_ID: 'old-vendor-client-id',
  PASS_EMAIL_CONNECTION_ID: 'old-vendor-connection-id', PASS_PORTAL_PREVIEW: '1' }).ready, false);
assert.equal(portalConfiguration(baseEnv).ready, true);

const dir = mkdtempSync(path.join(os.tmpdir(), 'chogpit-pass-privy-'));
const dbPath = path.join(dir, 'accounts.sqlite');
let registry = new PreviewRegistry(dbPath);
const config = { ready: true, appId, verificationKey, origin, hashKey: key, dbPath };
const app = createPortalServer({ config, registry, verifyIdentity,
  bundleProvider: async () => Buffer.from('export const mockedPrivyBundle = true;') });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
async function get(route, auth) {
  const res = await fetch(`${url}${route}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  return { status: res.status, body: await res.json() };
}
async function post(route, body, auth = credential, requestOrigin = origin) {
  const res = await fetch(`${url}${route}`, { method: 'POST',
    headers: { Origin: requestOrigin, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
try {
  const status = await get('/api/pass-portal/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.provider, 'Privy');
  assert.equal(status.body.registrationReady, true);
  assert.equal(status.body.signupMethod, 'PRIVY_EMAIL_MODAL_AUTOMATIC_USER_WALLET');
  assert.equal(status.body.publicAppId, appId);
  assert.equal(status.body.publicEmailConnectionId, undefined);
  assert.equal(status.body.connectWalletRequired, false);
  assert.equal(status.body.signupWalletSignatureRequired, false);
  assert.equal(status.body.maxDraftSupply, 40);
  assert.equal(status.body.verifiedMintCount, null);
  assert.equal(status.body.contract, null);
  assert.equal(status.body.mintEnabled, false);
  assert.equal(status.body.chogRewardsEnabled, false);
  assert.equal((await get('/api/pass-portal/me', credential)).body.state, 'NOT_REGISTERED');
  assert.equal((await get('/api/pass-portal/me', await token({ audience: 'attacker-app-id' }))).status, 401);
  const body = { emailHint: 'raider@example.com', address: wallet.address };
  assert.equal((await post('/api/pass-portal/register', body, credential, 'https://evil.example')).status, 403);
  assert.equal((await post('/api/pass-portal/register', body,
    await token({ audience: 'attacker-app-id' }))).status, 401);
  assert.equal((await post('/api/pass-portal/register', { ...body,
    emailHint: 'another@example.com' })).status, 403, 'Signed email must match entered email.');
  assert.equal((await post('/api/pass-portal/register', { ...body,
    address: anotherWallet.address })).status, 403, 'Wallet substitution must fail.');
  assert.equal((await post('/api/pass-portal/register', { ...body, address: '0xinvalid' })).status, 400);
  const registered = await post('/api/pass-portal/register', body);
  assert.equal(registered.status, 200);
  assert.equal(registered.body.state, 'REGISTERED_NO_NFT');
  assert.equal(registered.body.address, wallet.address);
  assert.equal(registered.body.tokenId, null);
  assert.equal((await post('/api/pass-portal/register', { ...body,
    emailHint: 'RAIDER@EXAMPLE.COM' })).status, 200, 'Retry is idempotent.');
  assert.equal((await post('/api/pass-portal/register', { ...body, address: anotherWallet.address },
    await token({ linkedAccounts: [emailAccount('raider@example.com'), walletAccount(anotherWallet.address)] }))).status,
    409, 'Existing email cannot silently change wallet.');
  assert.equal((await post('/api/pass-portal/register', body,
    await token({ subject: 'did:privy:another-synthetic-user-02' }))).status, 409,
    'Different Privy DID cannot replace email account.');
  assert.equal((await post('/api/pass-portal/register', { emailHint: 'farmer@example.com',
    address: wallet.address }, await token({ linkedAccounts: [emailAccount('farmer@example.com'),
    walletAccount(wallet.address)] }))).status, 409,
    'Same embedded wallet cannot register to a second email.');
  assert.equal((await post('/api/pass-portal/register', { emailHint: 'farmer@example.com',
    address: anotherWallet.address }, await token({ linkedAccounts: [emailAccount('farmer@example.com'),
    walletAccount(anotherWallet.address)] }))).status, 409,
    'Same Privy DID cannot register to a second email.');
  assert.equal((await post('/api/pass-portal/challenge', {})).status, 410);
  assert.equal((await post('/api/pass-portal/bind', {})).status, 410);
  for (const locked of ['/api/pass-portal/claim', '/api/pass-portal/mint', '/api/claim/wallet', '/api/reward/pay'])
    assert.equal((await post(locked, body)).status, 423, `${locked} must stay locked.`);
  assert.equal((await get('/api/pass-portal/me', credential)).body.address, wallet.address);
  // POSIX exposes owner-only file mode. On Windows, stat().mode reflects
  // synthesized permissions, not the NTFS ACL, so compare mode only on POSIX.
  if (process.platform !== 'win32')
    assert.equal((statSync(dbPath).mode & 0o777), 0o600);
} finally {
  await new Promise(resolve => app.server.close(resolve));
  registry.close();
  registry = new PreviewRegistry(dbPath);
  assert.equal(registry.me(verified).state, 'REGISTERED_NO_NFT',
    'Local Privy account survives restart, but is never an NFT.');
  registry.close();
  const oldDb = path.join(dir, 'old-metamask-preview.sqlite');
  const old = new Database(oldDb);
  old.exec('CREATE TABLE accounts(account_id TEXT PRIMARY KEY, address TEXT UNIQUE, bound_at INTEGER)');
  old.close();
  assert.throws(() => new PreviewRegistry(oldDb), /Incompatible old provider preview DB/);
  rmSync(dir, { recursive: true, force: true });
}
const unconfigured = createPortalServer({ config: { ready: false, appId: null } });
await new Promise(resolve => unconfigured.server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${unconfigured.server.address().port}`;
  const result = await fetch(`${base}/api/pass-portal/status`).then(response => response.json());
  assert.equal(result.registrationReady, false);
  assert.equal(result.connectWalletRequired, false);
  assert.equal(result.verifiedMintCount, null);
  assert.equal((await fetch(`${base}/api/pass-portal/claim`, { method: 'POST' })).status, 423);
  assert.equal((await fetch(`${base}/api/pass-portal/register`, { method: 'POST' })).status, 423);
  assert.equal((await fetch(`${base}/vendor/provider.js`)).status, 423);
  const html = await fetch(base).then(response => response.text());
  assert.match(html, /Privy/);
  assert.doesNotMatch(html, /through MetaMask/);
  assert.match(html, /EMAIL SIGN-UP PENDING/);
  assert.match(html, /CLAIM A REAL RAIDER PASS · LOCKED/);
} finally { await new Promise(resolve => unconfigured.server.close(resolve)); }
console.log('PASS: Privy email modal auto-provisioning, signed identity email/DID/embedded EVM binding, no wallet-signature signup, local idempotency and permanent mint/reward lock (synthetic tests).');
