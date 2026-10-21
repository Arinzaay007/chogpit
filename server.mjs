import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { createPublicClient, formatUnits, getAddress, http as viemHttp, parseAbi, verifyMessage } from 'viem';
import { LiveRooms } from './live-rooms.mjs';
import { payoutForRun } from './public/game.js';
import { LIVE_SPAWNS, nftArenaIdentity, pinnedChogMetadata } from './public/arena-world.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const GAME_ONLY_MODE = process.env.GAME_ONLY_MODE === '1';
const DATA_PATH = process.env.DATA_PATH ? path.resolve(process.env.DATA_PATH) : path.join(ROOT, 'data', 'arenas.json');
const REWARD_DATA_PATH = process.env.REWARD_DATA_PATH ? path.resolve(process.env.REWARD_DATA_PATH) : path.join(ROOT, 'data', 'reward-preview.json');
const CLAIM_STAGING_DB_PATH = process.env.CLAIM_STAGING_DB_PATH ? path.resolve(process.env.CLAIM_STAGING_DB_PATH) : path.join(ROOT, 'data', 'claim-staging.sqlite');
// No setting can make either build pay tokens. Production must instead select
// the smaller game-only build: no reward-wallet ledger or claim journal opens.
if (process.env.REWARD_PAYOUTS && process.env.REWARD_PAYOUTS !== 'disabled') {
  throw new Error('Real CHOG payouts are not implemented or reviewed. REWARD_PAYOUTS must remain disabled.');
}
if (process.env.NODE_ENV === 'production' && !GAME_ONLY_MODE) {
  throw new Error('Public hosting requires GAME_ONLY_MODE=1. Preview-wallet and claim-journal data must not be published.');
}
if (process.env.NODE_ENV === 'production' && GAME_ONLY_MODE && !process.env.DATA_PATH) {
  throw new Error('Set DATA_PATH to a persistent-volume arena file before starting a public game.');
}
let rewardPreview = null, rewardSessions = null, claimStaging = null;
if (!GAME_ONLY_MODE) {
  const [{ RewardPreview, RewardSessions }, { ClaimLedger }] = await Promise.all([
    import('./reward-preview.mjs'), import('./claim-ledger.mjs')
  ]);
  rewardPreview = await RewardPreview.load(REWARD_DATA_PATH);
  rewardSessions = new RewardSessions();
  // Preview-only observation telemetry, never eligible campaign openings.
  claimStaging = new ClaimLedger(CLAIM_STAGING_DB_PATH);
}
const sampleOnly = () => {
  const roll = randomInt(100);
  return { status: 'sample-only', amount: roll < 70 ? 5 : roll < 95 ? 10 : 25,
    previewBalance: null, note: 'A non-redeemable game sample. No CHOG or wallet points were awarded.' };
};
const PORT = Number(process.env.PORT || 4173);
// A reverse proxy on a VM can keep the Node listener private. Managed hosts
// still use 0.0.0.0 by default so their ingress can reach the service.
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const NFT_ADDRESS = getAddress('0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763');
const CHOG_ADDRESS = getAddress('0x350035555E10d9AfAF1566AaebfCeD5BA6C27777');
const ABI_NFT = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);
const ABI_TOKEN_URI = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
const ABI_CHOG = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const chain = {
  id: 143,
  name: 'Monad Mainnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } }
};
const client = createPublicClient({ chain, transport: viemHttp('https://rpc.monad.xyz', { timeout: 12000, retryCount: 1 }) });
const challenges = new Map();
const rate = new Map();
const metadataCache = new Map();
let arenas = {};

const STARTER_TRAPS = [
  { type: 'turret', x: 1888, y: 992 },
  { type: 'mine', x: 2400, y: 1248 },
  { type: 'slime', x: 1632, y: 1440 }
];
const SCAR_SPOTS = [
  { x: 1450, y: 1300 }, { x: 2180, y: 1050 }, { x: 1120, y: 1480 },
  { x: 1910, y: 740 }, { x: 2570, y: 1690 }, { x: 810, y: 1260 }
];
const TRAP_TYPES = new Set(['turret', 'mine', 'slime', 'pulse']);
const MARKS = new Set(['acid', 'static', 'spores']);

try {
  arenas = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  if (!arenas || typeof arenas !== 'object' || Array.isArray(arenas)) throw new Error('Arena file is not an object.');
} catch (error) {
  // Never overwrite a damaged persistent arena file with an empty map.
  if (error.code !== 'ENOENT') throw new Error(`Arena data could not be loaded: ${error.message}`);
}

function validId(id) { return id === 'demo' || (/^(0|[1-9]\d{0,6})$/.test(id) && Number(id) < 1000000); }
function defaultArena(id) {
  return { id, layoutVersion: 2, traps: STARTER_TRAPS.map(trap => ({ ...trap })),
    raids: 0, clears: 0, scars: [], lastRun: null, recentRuns: [], updatedAt: null };
}
function getArena(id) {
  const stored = arenas[id];
  const arena = { ...defaultArena(id), ...(stored || {}) };
  // The old prototype used a tiny, incompatible grid. Keep its run counts but
  // start its rebuilt arena with meaningful trap locations and clean scars.
  if (stored && (stored.layoutVersion !== 2 || !validTraps(arena.traps))) {
    arena.traps = STARTER_TRAPS.map(trap => ({ ...trap }));
    if (stored.layoutVersion !== 2) arena.scars = [];
    arena.layoutVersion = 2;
  }
  return arena;
}
function gatewayUrl(uri) {
  if (typeof uri !== 'string') return null;
  const match = uri.match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9/._-]+)$/);
  return match ? `https://gateway.pinata.cloud/ipfs/${match[1]}` : null;
}
async function getMetadata(id) {
  const cached = metadataCache.get(id);
  if (cached && cached.until > Date.now()) return cached.result;
  let result = { ...nftArenaIdentity(id, null), imageUrl: null, nftName: `CHOG #${id}` };
  try {
    const uri = await client.readContract({ address: NFT_ADDRESS, abi: ABI_TOKEN_URI, functionName: 'tokenURI', args: [BigInt(id)] });
    // Use a featured NFT's immutable IPFS trait snapshot only if the live
    // tokenURI is still exactly its pinned CID/path. No ownership is inferred.
    let metadata = pinnedChogMetadata(id, uri);
    const pinned = !!metadata;
    const url = gatewayUrl(uri);
    if (!metadata && url) {
      let lastError;
      for (const candidate of [url, url.replace('https://gateway.pinata.cloud/ipfs/', 'https://ipfs.filebase.io/ipfs/')]) {
        try {
          const response = await fetch(candidate, { signal: AbortSignal.timeout(6500) });
          if (!response.ok) throw new Error(`NFT metadata gateway returned ${response.status}`);
          metadata = await response.json();
          if (!Array.isArray(metadata?.attributes)) throw new Error('NFT metadata has no traits');
          break;
        } catch (error) { lastError = error; metadata = null; }
      }
      if (!metadata) throw lastError;
    }
    if (metadata) result = { ...nftArenaIdentity(id, metadata),
      metadataSource: pinned ? 'PINNED IPFS TRAITS + TOKEN ID' : 'NFT TRAITS + TOKEN ID',
      imageUrl: gatewayUrl(metadata.image),
      nftName: typeof metadata.name === 'string' ? metadata.name.slice(0, 80) : `CHOG #${id}` };
  } catch (error) { console.warn(`NFT metadata for #${id}:`, error.shortMessage || error.message); }
  if (metadataCache.size > 500) metadataCache.clear();
  metadataCache.set(id, { result, until: result.metadataSource === 'TOKEN ID FALLBACK'
    ? Date.now() + 300000 : Infinity });
  return result;
}
async function saveArena(id, arena) {
  arenas[id] = arena;
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  const tmp = DATA_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(arenas, null, 2));
  await rename(tmp, DATA_PATH);
}
// Serialize every arena edit through one queue: concurrent PvP finishes and a
// simultaneous owner save must not lose counters or collide on the .tmp file.
let arenaWriteQueue = Promise.resolve();
async function mutateArena(id, change) {
  const task = arenaWriteQueue.catch(() => {}).then(async () => {
    const arena = getArena(id);
    const result = change(arena);
    await saveArena(id, arena);
    return { arena, result };
  });
  arenaWriteQueue = task;
  return task;
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function fail(res, status, message) { json(res, status, { error: message }); }
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 50000) throw new Error('Request too large');
  }
  return JSON.parse(text || '{}');
}
function limited(req) {
  // Forwarded headers are client-controlled unless a particular reverse proxy is
  // explicitly authenticated. This preview does not trust them for rate limits.
  const ip = isIP(req.socket.remoteAddress) ? req.socket.remoteAddress : 'unknown';
  const now = Date.now();
  if (!rate.has(ip) && rate.size >= 4096) {
    for (const [key, entry] of rate) if (now - entry.start >= 60000) rate.delete(key);
    if (rate.size >= 4096) return true;
  }
  const current = rate.get(ip) || { start: now, count: 0 };
  if (now - current.start >= 60000) { current.start = now; current.count = 0; }
  current.count++;
  rate.set(ip, current);
  return current.count > 45;
}
function validTraps(traps) {
  if (!Array.isArray(traps) || traps.length > 8) return false;
  const locations = new Set();
  return traps.every(t => {
    if (!t || !TRAP_TYPES.has(t.type) || !Number.isInteger(t.x) || !Number.isInteger(t.y)) return false;
    if (t.x < 160 || t.x > 3040 || t.y < 160 || t.y > 2080 || t.x % 64 !== 32 || t.y % 64 !== 32) return false;
    if (LIVE_SPAWNS.some(point => Math.hypot(t.x - point.x, t.y - point.y) < 120)
      || Math.hypot(t.x - 2320, t.y - 1470) < 135) return false;
    const key = `${t.x}:${t.y}`;
    if (locations.has(key)) return false;
    locations.add(key);
    return true;
  });
}
function canonicalTraps(traps) {
  return traps.map(({ type, x, y }) => ({ type, x, y }));
}
function messageFor(id, account, nonce, expires, site, layout) {
  return `CHOGPIT arena edit\nSite: ${site}\nMonad chain: 143\nChog Genesis token ID: ${id}\nWallet: ${account}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nExact trap layout: ${JSON.stringify(layout)}\nThis signature only authorizes this exact arena layout update. It does not spend tokens.`;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/api/pass/claims' && req.method === 'GET') {
    const ledgerFile = path.join(path.dirname(DATA_PATH), 'claims.json');
    let ledger={}; try{ ledger=JSON.parse(await readFile(ledgerFile,'utf8'));}catch{}
    const claimedIds=Object.values(ledger).map(v=>v.tokenId);
    return json(res,200,{claimedIds, total: claimedIds.length, max:40});
  }
  if (pathname === '/api/pass/claim' && req.method === 'POST') {
    let body; try{ body=await bodyJson(req);}catch{ return fail(res,400,'Invalid JSON');}
    let wallet; try{ wallet=getAddress(body.wallet);}catch{ return fail(res,400,'Connect wallet first');}
    const key=wallet.toLowerCase();
    const ledgerFile = path.join(path.dirname(DATA_PATH), 'claims.json');
    let ledger={}; try{ ledger=JSON.parse(await readFile(ledgerFile,'utf8'));}catch{}
    if(ledger[key]) return json(res,200,{tokenId: ledger[key].tokenId, wallet, onChain: !!ledger[key].txHash, txHash: ledger[key].txHash || null, claimedAt: ledger[key].claimedAt});
    const claimedIds=new Set(Object.values(ledger).map(v=>v.tokenId));
    if(claimedIds.size>=40) return fail(res,423,'All 40 replicas claimed');
    let heroId=Math.floor(Number(body.heroId))||0; if(heroId<1||heroId>40||claimedIds.has(heroId)){ for(let i=1;i<=40;i++) if(!claimedIds.has(i)){ heroId=i; break;}}
    // If sponsor key present, mint on-chain to wallet (sponsor pays gas) — prevents double-claim on-chain
    const sponsorKey=process.env.SPONSOR_PRIVATE_KEY || process.env.PRIVATE_KEY;
    const passAddr=process.env.RAIDER_PASS_ADDRESS || '0x6655f23193142cC1E323522C363a52CDea8e3ce2';
    let txHash=null, onChain=false;
    if(sponsorKey){
      try{
        const { createWalletClient } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');
        const account=privateKeyToAccount(sponsorKey.startsWith('0x')?sponsorKey:'0x'+sponsorKey);
        const walletClient=createWalletClient({ account, chain, transport: viemHttp('https://rpc.monad.xyz')});
        const abiClaim=parseAbi(['function mintWithConsent(address recipient,uint256 deadline,bytes signature) returns (uint256)','function everClaimed(address) view returns (bool)','function totalSupply() view returns (uint256)','function nonces(address) view returns (uint256)']);
        // Check not already claimed on-chain
        const already=await client.readContract({address: getAddress(passAddr), abi: abiClaim, functionName:'everClaimed', args:[wallet]}).catch(()=>false);
        if(already) return fail(res,409,'This wallet already owns a Pass on-chain');
        // EIP-712 claim: Claim(address recipient,uint256 nonce,uint256 deadline)
        const nonce=await client.readContract({address: getAddress(passAddr), abi: abiClaim, functionName:'nonces', args:[wallet]}).catch(()=>0n);
        const deadline=BigInt(Math.floor(Date.now()/1000)+3600);
        const { signTypedData } = await import('viem/accounts');
        // Use walletClient signing via account
        const domain={name:'CHOGPIT Raider Pass', version:'1', chainId:143, verifyingContract: getAddress(passAddr)};
        const types={ Claim:[{name:'recipient',type:'address'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]};
        const signature=await account.signTypedData({ domain, types, primaryType:'Claim', message:{recipient: wallet, nonce, deadline}});
        txHash=await walletClient.writeContract({ address: getAddress(passAddr), abi: abiClaim, functionName:'mintWithConsent', args:[wallet, deadline, signature]});
        onChain=true;
      }catch(e){ console.error('on-chain mint failed', e); return fail(res, 500, `On-chain mint failed: ${e.shortMessage||e.message}. Check sponsor MON balance.`); }
    }
    ledger[key]={tokenId: heroId, wallet, heroId, claimedAt: new Date().toISOString(), txHash};
    await mkdir(path.dirname(ledgerFile),{recursive:true}); await writeFile(ledgerFile, JSON.stringify(ledger,null,2));
    return json(res,200,{tokenId: heroId, wallet, onChain, txHash, sponsorPaysGas: true, chainId:143, contract: passAddr});
  }
  if (pathname === '/api/pass-portal/status' && req.method === 'GET') {
    const appId = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID || null;
    return json(res, 200, { registrationReady: !!appId, publicAppId: appId, chainId: 143 });
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, mode: GAME_ONLY_MODE ? 'GAME_ONLY' : 'PREVIEW',
      gameOnly: GAME_ONLY_MODE, chainId: 143, nft: NFT_ADDRESS, token: CHOG_ADDRESS,
      spendingEnabled: false, rewardPayoutsEnabled: false });
  }
  if (pathname === '/api/pass/status' && req.method === 'GET') return json(res, 200, {
    chainId: 143, nftContract: null, realClaimEnabled: false, sponsorMintReady: false,
    samplePassLocalOnly: true, rewardPayoutsEnabled: false,
    message: 'The sample Raider Pass is browser-only, not an NFT. No gas-sponsored Monad pass contract or real CHOG payout is live.'
  });
  if (pathname.startsWith('/api/pass/')) return fail(res, 423,
    'Raider Pass mainnet claims are locked. No NFT was minted or queued.');
  if (pathname === '/api/rewards/status' && req.method === 'GET') return json(res, 200,
    GAME_ONLY_MODE ? { previewOnly: true, payoutsEnabled: false, funded: false,
      transferable: false, walletPointsEnabled: false, noWalletLedger: true,
      prizes: [{ amount: 5, percent: 70 }, { amount: 10, percent: 25 }, { amount: 25, percent: 5 }] }
      : rewardPreview.status());
  if (pathname === '/api/campaign/status' && req.method === 'GET') return json(res, 200, {
    ready: false, registrationsOpen: false, claimsEnabled: false,
    vault: null, funded: false, chainId: 143,
    message: GAME_ONLY_MODE
      ? 'This free game has no campaign signup, reward ledger, funded vault or real CHOG payout. Hidden amounts are samples only.'
      : 'The hosted playtest does not register campaign email accounts or pay real CHOG. Preview points never become tokens.'
  });
  if (pathname.startsWith('/api/campaign/')) return fail(res, 423,
    'Email registration and real CHOG payouts are not active on this preview server.');
  if (pathname === '/api/claims/status' && req.method === 'GET') return json(res, 200, {
    ready: false, claimsEnabled: false, vault: null, funded: false, chainId: 143, token: CHOG_ADDRESS,
    message: GAME_ONLY_MODE
      ? 'No CHOG claims or wallet points exist in this game. Hidden-box figures are non-redeemable samples; a future campaign would be separate.'
      : 'No reviewed, funded claim vault or eligibility proofs exist. A proposed email campaign would auto-pay at 50 CHOG if safely funded; preview points are never redeemable.'
  });
  if (pathname.startsWith('/api/claims/')) return fail(res, 423,
    'Real CHOG claims are locked until legal/security review, deployment, funding and verified proofs.');
  if (GAME_ONLY_MODE && pathname.startsWith('/api/rewards/')) return fail(res, 423,
    'This free game has no reward-wallet accounts, credits or CHOG payouts. Hidden amounts are non-redeemable samples.');
  if (pathname === '/api/rewards/challenge' && req.method === 'GET') {
    if (limited(req)) return fail(res, 429, 'Too many requests.');
    try { return json(res, 200, rewardSessions.challenge(url.searchParams.get('address'), req.headers.host || '')); }
    catch { return fail(res, 400, 'Invalid wallet address or request host.'); }
  }
  if (pathname === '/api/rewards/session' && req.method === 'POST') {
    if (limited(req)) return fail(res, 429, 'Too many requests.');
    let body;
    try { body = await bodyJson(req); }
    catch { return fail(res, 400, 'Invalid JSON body.'); }
    try {
      const session = await rewardSessions.create(body);
      return json(res, 200, { ...session, ...rewardPreview.balance(session.account), previewOnly: true });
    } catch { return fail(res, 401, 'Preview wallet signature was rejected or expired.'); }
  }
  if (pathname === '/api/rewards/me' && req.method === 'GET') {
    const account = rewardSessions.resolve(req.headers.authorization?.replace(/^Bearer /, '') || '');
    if (!account) return fail(res, 401, 'Link your wallet to view preview points.');
    return json(res, 200, { account, ...rewardPreview.balance(account), ...rewardPreview.status() });
  }
  if (pathname.startsWith('/api/rewards/')) return fail(res, 423, 'Real CHOG awards and withdrawals are disabled; preview points are never redeemable.');
  const chainMatch = pathname.match(/^\/api\/chain\/([^/]+)\/([^/]+)$/);
  if (chainMatch && req.method === 'GET') {
    if (limited(req)) return fail(res, 429, 'Too many lookups. Try again in a minute.');
    const [, address, id] = chainMatch;
    if (!validId(id) || id === 'demo') return fail(res, 400, 'Enter a numeric Chog Genesis token ID.');
    let account;
    try { account = getAddress(address); } catch { return fail(res, 400, 'Invalid wallet address.'); }
    try {
      const [owner, balance] = await Promise.all([
        client.readContract({ address: NFT_ADDRESS, abi: ABI_NFT, functionName: 'ownerOf', args: [BigInt(id)] }),
        client.readContract({ address: CHOG_ADDRESS, abi: ABI_CHOG, functionName: 'balanceOf', args: [account] })
      ]);
      return json(res, 200, { owner, isOwner: owner.toLowerCase() === account.toLowerCase(), balance: formatUnits(balance, 18), isChogHolder: balance >= 100n * 10n ** 18n });
    } catch (error) { return fail(res, 503, `Monad lookup failed: ${error.shortMessage || error.message}`); }
  }
  const arenaMatch = pathname.match(/^\/api\/arena\/([^/]+)(?:\/(challenge|traps|raid))?$/);
  if (!arenaMatch) return fail(res, 404, 'Not found.');
  const [, id, action] = arenaMatch;
  if (!validId(id)) return fail(res, 400, 'Invalid arena ID.');
  if (!action && req.method === 'GET') {
    if (id === 'demo') return json(res, 200, { ...getArena(id), genome: 'demo-training', traitLabel: 'TRAINING PIT', imageUrl: null });
    if (limited(req)) return fail(res, 429, 'Too many NFT lookups. Try again in a minute.');
    try {
      const owner = await client.readContract({ address: NFT_ADDRESS, abi: ABI_NFT, functionName: 'ownerOf', args: [BigInt(id)] });
      return json(res, 200, { ...getArena(id), ...(await getMetadata(id)), owner });
    } catch (error) {
      const message = error.shortMessage || error.message;
      return fail(res, /revert|nonexistent|invalid token/i.test(message) ? 404 : 503, `Could not load Chog NFT #${id}: ${message}`);
    }
  }
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
  if (limited(req)) return fail(res, 429, 'Too many requests. Try again in a minute.');
  let body;
  try { body = await bodyJson(req); }
  catch { return fail(res, 400, 'Invalid JSON body.'); }
  if (action === 'challenge') {
    if (id === 'demo') return fail(res, 400, 'The demo pit needs no owner signature.');
    if (!validTraps(body.traps)) return fail(res, 400, 'Invalid trap layout (maximum 8 traps on the builder grid).');
    let account;
    try { account = getAddress(body.account); }
    catch { return fail(res, 400, 'Invalid wallet.'); }
    const site = req.headers.host || '';
    if (typeof site !== 'string' || !/^[a-zA-Z0-9.:-]{1,180}$/.test(site)) return fail(res, 400, 'Invalid request host.');
    const now = Date.now();
    if (challenges.size >= 4096) {
      for (const [key, entry] of challenges) if (entry.expires <= now) challenges.delete(key);
      if (challenges.size >= 4096) return fail(res, 429, 'Too many pending signatures. Try again later.');
    }
    const layout = canonicalTraps(body.traps);
    const nonce = randomBytes(16).toString('hex');
    const expires = now + 300000;
    const message = messageFor(id, account, nonce, expires, site, layout);
    challenges.set(nonce, { id, account, message, layout: JSON.stringify(layout), expires });
    return json(res, 200, { message, nonce, expires });
  }
  if (action === 'traps') {
    if (!validTraps(body.traps)) return fail(res, 400, 'Invalid trap layout (maximum 8 traps on the builder grid).');
    const layout = canonicalTraps(body.traps);
    if (id !== 'demo') {
      const challenge = challenges.get(body.nonce);
      challenges.delete(body.nonce);
      if (!challenge || challenge.id !== id || challenge.expires <= Date.now()) return fail(res, 401, 'Signature challenge expired. Try saving again.');
      let account;
      try { account = getAddress(body.account); } catch { return fail(res, 401, 'Invalid wallet.'); }
      if (account.toLowerCase() !== challenge.account.toLowerCase()) return fail(res, 401, 'Wallet mismatch.');
      if (JSON.stringify(layout) !== challenge.layout) return fail(res, 401, 'Signed trap layout changed. Review and sign again.');
      const verified = await verifyMessage({ address: account, message: challenge.message, signature: body.signature }).catch(() => false);
      if (!verified) return fail(res, 401, 'Signature could not be verified.');
      try {
        const owner = await client.readContract({ address: NFT_ADDRESS, abi: ABI_NFT, functionName: 'ownerOf', args: [BigInt(id)] });
        if (owner.toLowerCase() !== account.toLowerCase()) return fail(res, 403, 'Only the current NFT owner can edit this arena.');
        if (body.traps.some(t => t.type === 'pulse')) {
          const balance = await client.readContract({ address: CHOG_ADDRESS, abi: ABI_CHOG, functionName: 'balanceOf', args: [account] });
          if (balance < 100n * 10n ** 18n) return fail(res, 403, 'Pulse traps require holding 100 $CHOG. No token is spent.');
        }
      } catch (error) { return fail(res, 503, `Monad lookup failed: ${error.shortMessage || error.message}`); }
    }
    const { arena } = await mutateArena(id, current => {
      current.traps = layout;
      current.updatedAt = new Date().toISOString();
    });
    return json(res, 200, arena);
  }
  if (action === 'raid') {
    // Browser practice reports are client-controlled. They may update only the
    // open demo pit; NFT raid counters and scars require server-run solo/PvP.
    if (id !== 'demo') return fail(res, 403, 'Unverified browser runs cannot change NFT arenas. Play server-run solo or a private PvP/co-op room.');
    const loot = Math.max(0, Math.min(25, Math.floor(Number(body.loot) || 0)));
    const kills = Math.max(0, Math.min(100, Math.floor(Number(body.kills) || 0)));
    const timeLeft = Math.max(0, Math.min(180, Number(body.timeLeft) || 0));
    const escaped = body.won === true && loot >= 2;
    const tier = !escaped ? 'lost' : loot >= 6 && kills >= 2 ? 'legend' : loot >= 4 || kills >= 2 ? 'heist' : 'safe';
    const score = escaped ? loot * 150 + kills * 100 + Math.round(timeLeft) : 0;
    const { arena } = await mutateArena(id, current => {
      current.raids++;
      if (escaped) {
        current.clears++;
        if (MARKS.has(body.mark)) {
          const spot = SCAR_SPOTS[(current.clears - 1) % SCAR_SPOTS.length];
          current.scars = [...current.scars.slice(-4), { type: body.mark, x: spot.x, y: spot.y,
            at: new Date().toISOString() }];
        }
      }
      current.lastRun = { won: escaped, loot, kills, tier, score, timeLeft: Math.round(timeLeft), mode: 'solo-unverified', at: new Date().toISOString() };
      current.recentRuns = [current.lastRun, ...(Array.isArray(current.recentRuns) ? current.recentRuns.slice(0, 4) : [])];
    });
    return json(res, 200, arena);
  }
  return fail(res, 404, 'Not found.');
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200,
      { ok: true, mode: GAME_ONLY_MODE ? 'GAME_ONLY' : 'PREVIEW', rewardPayoutsEnabled: false });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'Invalid path.'); }
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(PUBLIC, '.' + pathname);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return fail(res, 403, 'Forbidden.');
    const ext = path.extname(file).toLowerCase();
    if (!mime[ext] || !existsSync(file)) return fail(res, 404, 'Not found.');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': mime[ext], 'content-length': data.length, 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) fail(res, 500, 'Server error.');
    else res.end();
  }
});
const liveRooms = new LiveRooms({
  resolveSession: token => GAME_ONLY_MODE ? null : rewardSessions.resolve(token),
  // Game-only rounds never create telemetry, claim events or wallet balances.
  onVerifiedOpening: (room, player, box) => GAME_ONLY_MODE ? null : claimStaging.recordObservation({
    runId: room.instanceId, round: room.roundNumber, boxId: box.id,
    wallet: rewardSessions.resolve(player.rewardSession),
    mode: room.mode, arenaId: room.arena.id
  }),
  onReward: (room, player, box) => {
    if (GAME_ONLY_MODE) return sampleOnly();
    const account = rewardSessions.resolve(player.rewardSession);
    if (!account) return rewardPreview.sampleOnly();
    return rewardPreview.credit({ account, eventId: `${room.instanceId}:${room.roundNumber}:${box.id}`,
      mode: room.mode, arenaId: room.arena.id });
  },
  resolveArena: async id => {
    if (!validId(id)) throw new Error('Invalid Chog token ID.');
    if (id === 'demo') return { ...getArena(id), genome: 'demo-training', traitLabel: 'TRAINING PIT', imageUrl: null };
    try {
      const owner = await client.readContract({ address: NFT_ADDRESS, abi: ABI_NFT, functionName: 'ownerOf', args: [BigInt(id)] });
      return { ...getArena(id), ...(await getMetadata(id)), owner };
    } catch (error) {
      throw new Error(`Could not load a minted Chog NFT #${id}: ${error.shortMessage || error.message}`);
    }
  },
  onResult: async (room, player, summary) => {
    const payout = payoutForRun(summary);
    const { result } = await mutateArena(room.arena.id, arena => {
      arena.raids++;
      if (summary.won) arena.clears++;
      arena.lastRun = { won: summary.won, loot: summary.loot, kills: summary.kills,
        tier: payout.key, score: payout.score, timeLeft: Math.round(summary.timeLeft),
        mode: room.mode === 'solo' ? 'server-solo' : room.mode === 'coop' ? 'live-coop' : 'live-pvp',
        room: room.code, raider: player.name, at: new Date().toISOString() };
      arena.recentRuns = [arena.lastRun, ...(Array.isArray(arena.recentRuns) ? arena.recentRuns.slice(0, 4) : [])];
      return summary.won ? arena.clears : null;
    });
    return result;
  },
  onScar: async (room, player, mark) => {
    const clearIndex = await player.resultPromise;
    if (!Number.isInteger(clearIndex) || clearIndex < 1) throw new Error('The escape record was not saved; scar unavailable.');
    const { arena } = await mutateArena(room.arena.id, current => {
      const spot = SCAR_SPOTS[(clearIndex - 1) % SCAR_SPOTS.length];
      current.scars = [...current.scars.slice(-4), { type: mark, x: spot.x, y: spot.y,
        raider: player.name, at: new Date().toISOString() }];
    });
    return arena;
  }
});
liveRooms.attach(server);
server.listen(PORT, LISTEN_HOST, () => console.log(`CHOGPIT ready on http://${LISTEN_HOST}:${PORT}`));
