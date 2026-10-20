import { createHmac } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { getAddress } from 'viem';

export const PRIVY_ISSUER = 'privy.io';

export class PortalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function accountHashKeyFromEnvironment(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64url');
  return bytes.length >= 32 ? bytes : null;
}

export function normalizeVerifiedEmail(email) {
  if (typeof email !== 'string' || email.length > 254) throw new PortalError(403, 'A Privy-verified email is required.');
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254)
    throw new PortalError(403, 'A Privy-verified email is required.');
  return normalized;
}

// Identity tokens contain a JSON-STRING claim. Never accept a user-supplied
// account list, an access token, or an unsigned browser user object instead.
function linkedAccounts(payload) {
  if (typeof payload.linked_accounts !== 'string' || payload.linked_accounts.length > 16000)
    throw new PortalError(403, 'The signed Privy identity token must include linked accounts.');
  try {
    const accounts = JSON.parse(payload.linked_accounts);
    if (Array.isArray(accounts) && accounts.length > 0 && accounts.length <= 100 &&
        accounts.every(account => account && typeof account === 'object' && !Array.isArray(account)))
      return accounts;
  } catch { /* fail closed */ }
  throw new PortalError(403, 'The signed Privy linked accounts are malformed.');
}

function embeddedEvmAddresses(accounts) {
  const addresses = [];
  for (const account of accounts) {
    if (account.type !== 'wallet') continue;
    // Privy's user object uses camelCase; API/older lightweight accounts can
    // use snake_case or walletClient. Reject contradictory markers and do NOT
    // infer embedded ownership from a bare address or a smart wallet.
    const client = [account.walletClientType, account.wallet_client_type,
      account.walletClient, account.wallet_client].filter(value => value !== undefined);
    const chain = [account.chainType, account.chain_type].filter(value => value !== undefined);
    if (!client.length || !client.every(value => value === 'privy') ||
        !chain.length || !chain.every(value => value === 'ethereum')) continue;
    if (typeof account.address !== 'string' || !/^0x[\da-fA-F]{40}$/.test(account.address))
      throw new PortalError(403, 'The signed Privy embedded EVM address is malformed.');
    addresses.push(getAddress(account.address));
  }
  if (addresses.length !== 1)
    throw new PortalError(403, 'Exactly one signed Privy embedded EVM wallet is required.');
  return addresses;
}

// verificationKey must come from the owner's Privy app settings; it is a
// PUBLIC ES256 key. Never use a test JWK, attacker-provided key or app secret
// from a request. The jwks override is for synthetically signed local tests.
export function createIdentityVerifier({ appId, hashKey, verificationKey, jwks }) {
  if (typeof appId !== 'string' || appId.length < 10 || appId.length > 300)
    throw Error('An owner-issued public Privy app ID is required.');
  if (!Buffer.isBuffer(hashKey) || hashKey.length < 32)
    throw Error('A 32-byte account HMAC key is required.');
  if (!jwks && (typeof verificationKey !== 'string' ||
      !verificationKey.includes('-----BEGIN PUBLIC KEY-----')))
    throw Error('An owner-issued Privy ES256 public verification key is required.');
  const publicKey = jwks || importSPKI(verificationKey.replace(/\\n/g, '\n'), 'ES256');
  return async idToken => {
    if (typeof idToken !== 'string' || idToken.length > 24000 || idToken.split('.').length !== 3)
      throw new PortalError(401, 'A current signed Privy identity token is required.');
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, await publicKey, {
        issuer: PRIVY_ISSUER, audience: appId, algorithms: ['ES256'],
        clockTolerance: '30s', maxTokenAge: '2h'
      }));
    } catch {
      throw new PortalError(401, 'Privy identity token verification failed.');
    }
    const now = Math.floor(Date.now() / 1000);
    // Do not accept multi-audience tokens, arbitrary subjects, expired tokens
    // or access tokens with no signed linked_accounts claim.
    if (payload.aud !== appId || typeof payload.sub !== 'string' ||
        !/^did:privy:[a-zA-Z0-9_-]{8,128}$/.test(payload.sub) ||
        !Number.isSafeInteger(payload.iat) || payload.iat > now + 30 ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.exp <= payload.iat)
      throw new PortalError(401, 'Privy identity token is expired or malformed.');
    const accounts = linkedAccounts(payload);
    const emails = accounts.filter(account => account.type === 'email');
    if (emails.length !== 1) throw new PortalError(403, 'Exactly one Privy-verified email is required.');
    const email = normalizeVerifiedEmail(emails[0].address);
    const embeddedAddresses = embeddedEvmAddresses(accounts);
    const hash = (purpose, value) => createHmac('sha256', hashKey)
      .update(`CHOGPIT_PRIVY_${purpose}_V1\n`).update(appId).update('\n').update(value).digest('hex');
    return { accountId: hash('EMAIL', email), userIdHash: hash('DID', payload.sub),
      email, embeddedAddresses };
  };
}
