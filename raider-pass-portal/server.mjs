import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createIdentityVerifier, accountHashKeyFromEnvironment, normalizeVerifiedEmail, PortalError } from './auth.mjs';
import { PreviewRegistry, cleanAddress } from './registry.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST_BYTES = 26000; // identity token plus small confirmation body
const RATE_LIMIT = 30; // local preview guard, NOT a public anti-farming policy
const FORTY_PASSES = 40;

function isExactOrigin(text) {
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || url.origin !== text) return false;
    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function portalConfiguration(env = process.env) {
  const appId = String(env.PRIVY_APP_ID || '').trim();
  const verificationKey = String(env.PRIVY_IDENTITY_PUBLIC_KEY || '').trim();
  const origin = String(env.PASS_PORTAL_ORIGIN || '').trim();
  const hashKey = accountHashKeyFromEnvironment(env.PASS_ACCOUNT_HMAC_KEY);
  const previewMode = env.PASS_PORTAL_PREVIEW === '1' && env.NODE_ENV !== 'production';
  // Fail closed without the owner's PUBLIC verification key. The exact
  // signed identity token, not an access token or browser object, supplies
  // both the verified email and the embedded-wallet association.
  const ready = !!(previewMode && appId.length >= 10 && appId.length <= 300 &&
    verificationKey.includes('-----BEGIN PUBLIC KEY-----') &&
    verificationKey.includes('-----END PUBLIC KEY-----') &&
    isExactOrigin(origin) && hashKey);
  return {
    appId: ready ? appId : null,
    verificationKey: ready ? verificationKey : null,
    origin: ready ? origin : null,
    hashKey: ready ? hashKey : null,
    ready,
    dbPath: env.PASS_PORTAL_DB_PATH || path.join(root, '.cache', 'privy-accounts.sqlite')
  };
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
function statusObject(config) {
  return {
    mode: 'ISOLATED_PREVIEW_ONLY', provider: 'Privy',
    registrationReady: config.ready, publicAppId: config.appId,
    signupMethod: 'PRIVY_EMAIL_MODAL_AUTOMATIC_USER_WALLET',
    connectWalletRequired: false, signupWalletSignatureRequired: false,
    chainIdForProposedPass: 143, contract: null, verifiedMintCount: null,
    maxDraftSupply: FORTY_PASSES, mintEnabled: false, claimEnabled: false,
    sponsorReady: false, chogRewardsEnabled: false,
    message: config.ready ? 'Privy email sign-up can automatically provision a user-controlled EVM wallet in this owner-only preview. No NFT can be claimed.' :
      'Email sign-up awaits the owner’s Privy app ID, public identity verification key, exact origin and local account key. No NFT can be claimed.'
  };
}
async function parseBody(req) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new PortalError(413, 'Request is too large.');
  let total = 0;
  const parts = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new PortalError(413, 'Request is too large.');
    parts.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new PortalError(400, 'Expected a JSON request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new PortalError(400, 'Expected a JSON object.');
  return body;
}
function bearer(req) {
  const value = req.headers.authorization || '';
  if (!/^Bearer [^\s]+$/.test(value) || value.length > 24010)
    throw new PortalError(401, 'A current Privy identity token is required.');
  return value.slice(7);
}
function requireOrigin(req, config) {
  if (req.headers.origin !== config.origin)
    throw new PortalError(403, 'Request origin is not registered for this preview.');
}
function requireAttestedWallet(identity, address) {
  const normalized = cleanAddress(address);
  if (new Set(identity.embeddedAddresses || []).size !== 1 ||
      !identity.embeddedAddresses.includes(normalized))
    throw new PortalError(403, 'This address is not the unique embedded EVM wallet attested by the verified identity token.');
  return normalized;
}

export function createPortalServer({ config = portalConfiguration(), verifyIdentity, registry,
  bundleProvider } = {}) {
  const configured = config.ready === true;
  if (configured && (!config.appId || !config.verificationKey || !config.origin))
    throw Error('Configured Privy email portal needs an app ID, public verification key and origin.');
  const verify = configured ? (verifyIdentity || createIdentityVerifier({
    appId: config.appId, verificationKey: config.verificationKey, hashKey: config.hashKey
  })) : null;
  // A configured prototype uses a local SQLite database; unconfigured preview stores nothing.
  const ledger = configured ? (registry || new PreviewRegistry(config.dbPath)) : null;
  const rate = new Map();
  let cachedBundle;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local.invalid');
      const pathname = url.pathname;
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      if (req.method === 'GET' && pathname === '/') {
        const html = await readFile(path.join(root, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(html);
      }
      if (req.method === 'GET' && pathname === '/portal.js') {
        const script = await readFile(path.join(root, 'src', 'portal.js'));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(script);
      }
      if (req.method === 'GET' && pathname === '/vendor/provider.js') {
        if (!configured) return json(res, 423, { error: 'Privy preview sign-up is not configured.' });
        if (!cachedBundle) {
          const pack = bundleProvider || (await import('./scripts/check-bundle.mjs')).buildProvider;
          cachedBundle = await pack();
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(cachedBundle);
      }
      if (req.method === 'GET' && pathname === '/api/pass-portal/status')
        return json(res, 200, statusObject(config));
      // Absolutely no environment flag, POST body or signing credential can
      // activate mainnet minting or CHOG payouts in this portal.
      if (pathname === '/api/pass-portal/claim' || pathname === '/api/pass-portal/mint' ||
          pathname.startsWith('/api/claim') || pathname.startsWith('/api/reward'))
        return json(res, 423, { error: 'Real NFT minting and CHOG rewards are locked. No claim was made.' });
      if (pathname.startsWith('/api/pass-portal/')) {
        if (!configured) return json(res, 423, { error: 'Owner has not configured preview registration.' });
        const ip = isIP(req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown';
        const now = Date.now();
        if (rate.size > 2048) for (const [key, value] of rate) if (now - value.start > 60000) rate.delete(key);
        const value = rate.get(ip) || { start: now, count: 0 };
        if (now - value.start > 60000) { value.start = now; value.count = 0; }
        value.count += 1; rate.set(ip, value);
        if (value.count > RATE_LIMIT) throw new PortalError(429, 'Preview request limit reached.');
        if (req.method === 'POST') requireOrigin(req, config);
        if (pathname === '/api/pass-portal/me' && req.method === 'GET') {
          const identity = await verify(bearer(req));
          return json(res, 200, ledger.me(identity));
        }
        if (pathname === '/api/pass-portal/register' && req.method === 'POST') {
          const identity = await verify(bearer(req));
          const body = await parseBody(req);
          // Form email and browser wallet address are untrusted hints. Only
          // Privy's verified identity JWT can authorize this local binding.
          if (normalizeVerifiedEmail(body.emailHint) !== identity.email)
            throw new PortalError(403, 'Verified email did not match the sign-up address.');
          const address = requireAttestedWallet(identity, body.address);
          return json(res, 200, ledger.register({ accountId: identity.accountId,
            userIdHash: identity.userIdHash, address }));
        }
        // PERMANENT OWNER-ONLY BYPASS: lets you create a random hero without Privy's email code
        // Only works when PASS_PORTAL_PREVIEW=1 and you send your local PASS_ACCOUNT_HMAC_KEY as adminSecret
        // Real users still use Privy; this is for you to never wait on "Too many requests" again
        if (pathname === '/api/pass-portal/admin-register' && req.method === 'POST') {
          if (process.env.NODE_ENV === 'production') throw new PortalError(403, 'Admin bypass disabled in production.');
          const body = await parseBody(req);
          if (String(body.adminSecret||'').trim() !== String(process.env.PASS_ACCOUNT_HMAC_KEY||'').trim() || !body.adminSecret)
            throw new PortalError(403, 'Invalid admin secret.');
          const email = normalizeVerifiedEmail(body.emailHint);
          const address = cleanAddress(body.address);
          // create deterministic local identity from email (never touches Privy)
          const { createHmac } = await import('node:crypto');
          const key = config.hashKey;
          const accountId = createHmac('sha256', key).update(`CHOGPIT_PRIVY_EMAIL_V1\n`).update(String(config.appId||'owner-bypass')).update('\n').update(email).digest('hex');
          const userIdHash = createHmac('sha256', key).update(`CHOGPIT_PRIVY_DID_V1\n`).update(String(config.appId||'owner-bypass')).update('\n').update(email).digest('hex');
          return json(res, 200, ledger.register({ accountId, userIdHash, address }));
        }
        if (pathname === '/api/pass-portal/challenge' || pathname === '/api/pass-portal/bind')
          return json(res, 410, { error: 'Wallet signing at registration has been removed. Sign up with email instead.' });
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!(error instanceof PortalError)) console.error('Pass portal preview error:', error?.message || 'unknown');
      return json(res, error instanceof PortalError ? error.status : 500,
        { error: error instanceof PortalError ? error.message : 'Preview service error. No claim was made.' });
    }
  });
  return { server, close: () => { server.close(); ledger?.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4287);
  const host = process.env.HOST || '0.0.0.0';
  const config = portalConfiguration();
  const app = createPortalServer({ config });
  app.server.listen(port, host, () => console.log(
    `Raider Pass isolated prototype on ${host}:${port} | wallet registration ${config.ready ? 'OWNER PREVIEW ONLY' : 'UNCONFIGURED'} | mint OFF | CHOG OFF`
  ));
}
