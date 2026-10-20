// Separately operated claim website/API. Never imported by server.mjs.
// This service has NO default configuration, signer, deployed vault or funds.
// It will not start without a signed fresh-event manifest, pinned vault runtime
// code hash, external rules/checkpoint files, explicit MON budgets and a
// separately provided signer adapter. No key belongs in this repository.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http as viemHttp, keccak256, toHex } from 'viem';
import { CampaignClaimSessions, SponsorBudget, SponsoredClaims,
  sponsoredClaimHttpHandler, verifyPublishedClaims } from './claim-delivery.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HASH = /^0x[a-fA-F0-9]{64}$/;
const CHAIN = { id: 143, name: 'Monad Mainnet', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } };
const fail = (res, status, text) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: text }));
};
const absolute = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return value;
};
const positive = (value, label) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n)
    throw new Error(`${label} must be a positive decimal-string wei amount.`);
  return BigInt(value);
};

export async function createClaimService(config) {
  if (!config || config.schema !== 'CHOGPIT_REVIEWED_CLAIM_SERVICE_V1')
    throw new Error('Explicit reviewed-campaign service configuration is required.');
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Claim website must have a dedicated HTTPS public origin.');
  const rpcUrl = new URL(config.rpcUrl);
  if (rpcUrl.protocol !== 'https:') throw new Error('A TLS-protected Monad RPC URL is required.');
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Choose a non-privileged loopback claim-service port.');
  if (!HASH.test(config.expectedVaultCodeHash)) throw new Error('Pin the independently checked vault runtime bytecode hash.');
  const publisher = getAddress(config.trustedPublisher), sponsorAddress = getAddress(config.sponsorAddress);
  const rulesFile = absolute(config.rulesFile, 'rulesFile');
  const checkpointFile = absolute(config.externalCheckpointFile, 'externalCheckpointFile');
  const manifest = JSON.parse(await readFile(absolute(config.manifestFile, 'manifestFile'), 'utf8'));
  const book = await verifyPublishedClaims(manifest, { trustedPublisher: publisher });
  const suppliedRulesHash = keccak256(toHex(await readFile(rulesFile)));
  if (suppliedRulesHash.toLowerCase() !== book.rulesHash)
    throw new Error('Published rules file does not match the signed campaign rules hash.');
  const checkpoint = (await readFile(checkpointFile, 'utf8')).trim();
  if (checkpoint.toLowerCase() !== book.journalHead)
    throw new Error('External fresh-event checkpoint does not match the signed manifest.');
  const publicClient = createPublicClient({ chain: CHAIN,
    transport: viemHttp(rpcUrl.toString(), { timeout: 12000, retryCount: 1 }) });
  // A local signer adapter must export a function returning an EIP-1193/viem
  // wallet client backed by an operator-controlled KMS/HSM or managed signer.
  // NEVER put an owner/sponsor private key or mnemonic into config/repository.
  const signerPath = absolute(config.signerModule, 'signerModule');
  if (signerPath.startsWith(PUBLIC + path.sep)) throw new Error('Signer code must never be served as a website asset.');
  const module = await import(pathToFileURL(signerPath).href);
  if (typeof module.createSponsorClient !== 'function')
    throw new Error('Signer adapter must export createSponsorClient({chain,rpcUrl}).');
  const walletClient = await module.createSponsorClient({ chain: CHAIN, rpcUrl: rpcUrl.toString() });
  if (getAddress(walletClient?.account?.address || walletClient?.account) !== sponsorAddress)
    throw new Error('Signer account does not match the explicitly approved sponsor address.');
  const budget = new SponsorBudget(absolute(config.budgetFile, 'budgetFile'),
    { maxTotalWei: positive(config.maxTotalSponsorWei, 'maxTotalSponsorWei') });
  let server;
  try {
    const relay = new SponsoredClaims({ book, publicClient, walletClient, budget,
      expectedCodeHash: config.expectedVaultCodeHash,
      maxGasPriceWei: positive(config.maxGasPriceWei, 'maxGasPriceWei'),
      maxTxFeeWei: positive(config.maxTxFeeWei, 'maxTxFeeWei') });
    await relay.verifyVault(); // Wrong chain, token or code hash: refuse startup.
    const sessions = new CampaignClaimSessions(book);
    const claims = sponsoredClaimHttpHandler({ relay, sessions });
    const staticFiles = new Map([
      ['/claim', ['claim.html', 'text/html; charset=utf-8']],
      ['/claim.html', ['claim.html', 'text/html; charset=utf-8']],
      ['/claim-portal.js', ['claim-portal.js', 'application/javascript; charset=utf-8']],
      ['/claim-style.css', ['claim-style.css', 'text/css; charset=utf-8']]
    ]);
    server = http.createServer(async (req, res) => {
      try {
        if (req.headers.host?.toLowerCase() !== origin.host.toLowerCase())
          return fail(res, 403, 'Unrecognized claim website host.');
        const url = new URL(req.url || '/', origin);
        if (url.pathname.startsWith('/api/claims/')) return claims(req, res);
        const entry = staticFiles.get(url.pathname);
        if (!entry || req.method !== 'GET') return fail(res, 404, 'Not found.');
        const [file, mime] = entry;
        const bytes = await readFile(path.join(PUBLIC, file));
        res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'" });
        res.end(bytes);
      } catch (error) {
        console.error('Claim service request failed:', error.message);
        if (!res.headersSent) fail(res, 500, 'Claim service unavailable.');
        else res.end();
      }
    });
    return { server, relay, sessions, budget, book, origin: origin.origin, port,
      async close() {
        if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        budget.close();
      } };
  } catch (error) { if (server?.listening) server.close(); budget.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const filename = absolute(process.argv[2], 'Configuration file argument');
    const file = await stat(filename);
    if ((file.mode & 0o077) !== 0) throw new Error('Keep the claim-service config owner-readable only (chmod 600).');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    const service = await createClaimService(config);
    service.server.listen(service.port, '127.0.0.1', () =>
      console.log(`CHOGPIT claim service listening privately on 127.0.0.1:${service.port}; TLS reverse proxy required.`));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
      service.close().finally(() => process.exit(0));
    });
  } catch (error) {
    console.error(`Claim service did not start: ${error.message}`);
    process.exitCode = 1;
  }
}
