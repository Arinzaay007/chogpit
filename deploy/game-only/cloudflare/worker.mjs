// CHOGPIT game-only Cloudflare entry point. No reward ledger, claims, wallet
// balances, sponsors, contracts, or payout code is imported in this build.
// Wrangler serves the exported game's public/ assets directly; HTTP API and
// WebSocket upgrades go to ONE SQLite-backed Durable Object. The single object
// keeps private room codes coherent and persists arena edits across restarts.
import { createPublicClient, formatUnits, getAddress, http, parseAbi, verifyMessage } from 'viem';
import { LiveRooms } from './live-rooms.mjs';
import { payoutForRun } from './public/game.js';
import { LIVE_SPAWNS, nftArenaIdentity, pinnedChogMetadata } from './public/arena-world.js';

const NFT_ADDRESS = getAddress('0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763');
const CHOG_ADDRESS = getAddress('0x350035555E10d9AfAF1566AaebfCeD5BA6C27777');
const NFT_ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);
const URI_ABI = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
const CHOG_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const chain = { id: 143, name: 'Monad Mainnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } };
const rpc = createPublicClient({ chain, transport: http('https://rpc.monad.xyz', { timeout: 12000, retryCount: 1 }) });

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
const SESSION_LIMIT = 240;

const validId = id => id === 'demo' || (/^(0|[1-9]\d{0,6})$/.test(id) && Number(id) < 1_000_000);
const defaultArena = id => ({ id, layoutVersion: 2, traps: STARTER_TRAPS.map(trap => ({ ...trap })),
  raids: 0, clears: 0, scars: [], lastRun: null, recentRuns: [], updatedAt: null });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff' } });
const fail = (status, message) => json(status, { error: message });
const roll100 = () => { // Unbiased secure integer 0..99, no Node-specific RNG.
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= 4294967200);
  return values[0] % 100;
};
const sampleOnly = () => {
  const roll = roll100();
  return { status: 'sample-only', amount: roll < 70 ? 5 : roll < 95 ? 10 : 25,
    previewBalance: null, note: 'A non-redeemable game sample. No CHOG or wallet points were awarded.' };
};
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
const canonicalTraps = traps => traps.map(({ type, x, y }) => ({ type, x, y }));
function messageFor(id, account, nonce, expires, site, layout) {
  return `CHOGPIT arena edit\nSite: ${site}\nMonad chain: 143\nChog Genesis token ID: ${id}\nWallet: ${account}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nExact trap layout: ${JSON.stringify(layout)}\nThis signature only authorizes this exact arena layout update. It does not spend tokens.`;
}
function gatewayUrl(uri) {
  if (typeof uri !== 'string') return null;
  const match = uri.match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9/._-]+)$/);
  return match ? `https://gateway.pinata.cloud/ipfs/${match[1]}` : null;
}
async function bodyJson(request) {
  const text = await request.text();
  if (text.length > 50000) throw new Error('Request too large');
  return JSON.parse(text || '{}');
}

// Node's LiveRooms still owns the authoritative shooter simulation. The small
// shim in wrangler.jsonc replaces only its 'ws' dependency; no game rules,
// physics, crate visibility, scores, or mobile protocol are removed.
class RoomSocket {
  constructor(socket) { this.socket = socket; this.handlers = new Map(); this.player = null;
    this.pending = false; this.lastMessageAt = 0; this.inputWindowAt = 0; this.inputCount = 0;
    this.messageWindowAt = 0; this.messageCount = 0; }
  get readyState() { return this.socket.readyState; }
  get bufferedAmount() { return this.socket.bufferedAmount || 0; }
  on(event, callback) { this.handlers.set(event, callback); }
  emit(event, ...args) { this.handlers.get(event)?.(...args); }
  send(data) { this.socket.send(data); }
  close(code = 1000, reason = '') { try { this.socket.close(code, reason); } catch {} }
  terminate() { this.close(1012, 'Room connection restarted'); }
  // WebSocketPair has no server-side ping() method. The room simulator already
  // bounds clients and prunes expired rooms; Cloudflare handles TCP liveness.
  ping() { this.emit('pong'); }
}

export class ChogpitGame {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.challenges = new Map(); this.rate = new Map(); this.metadataCache = new Map();
    this.arenaWriteQueue = Promise.resolve(); this.sockets = new Map();
    this.tickTimer = null; this.cleanupTimer = null;
    // Private matches are in memory just as on the Node host. A runtime restart
    // cannot silently resume a match with stale player positions: reconnect.
    for (const stale of ctx.getWebSockets()) try { stale.close(1012, 'Server restarted; rejoin room'); } catch {}
    this.rooms = new LiveRooms({
      resolveSession: () => null,
      onVerifiedOpening: () => null,
      onReward: () => sampleOnly(),
      resolveArena: id => this.resolveArena(id),
      onResult: (room, player, summary) => this.recordResult(room, player, summary),
      onScar: (room, player, mark) => this.recordScar(room, player, mark)
    });
    const handle = this.rooms.handle.bind(this.rooms);
    this.rooms.handle = (socket, message) => {
      const task = handle(socket, message);
      // Owner lookups and post-win scar writes may outlive a single message.
      // Inputs are synchronous and frequent; track only substantive actions.
      if (message.type !== 'input') this.ctx.waitUntil(task.catch(error => console.warn('Room action failed:', error)));
      return task;
    };
  }
  async getArena(id) {
    const stored = await this.ctx.storage.get(`arena:${id}`);
    if (stored !== undefined && (!stored || typeof stored !== 'object' || Array.isArray(stored)))
      throw new Error('Stored arena data is damaged; refusing to reset persistent edits.');
    const arena = { ...defaultArena(id), ...(stored || {}) };
    if (stored && (stored.layoutVersion !== 2 || !validTraps(arena.traps))) {
      arena.traps = STARTER_TRAPS.map(trap => ({ ...trap }));
      if (stored.layoutVersion !== 2) arena.scars = [];
      arena.layoutVersion = 2;
    }
    return arena;
  }
  async mutateArena(id, change) {
    const task = this.arenaWriteQueue.catch(() => {}).then(async () => {
      const arena = await this.getArena(id);
      const result = change(arena);
      await this.ctx.storage.put(`arena:${id}`, arena);
      return { arena, result };
    });
    this.arenaWriteQueue = task;
    return task;
  }
  async getMetadata(id) {
    const cached = this.metadataCache.get(id);
    if (cached && cached.until > Date.now()) return cached.result;
    let result = { ...nftArenaIdentity(id, null), imageUrl: null, nftName: `CHOG #${id}` };
    try {
      const uri = await rpc.readContract({ address: NFT_ADDRESS, abi: URI_ABI, functionName: 'tokenURI', args: [BigInt(id)] });
      // A snapshot is accepted only after checking the LIVE tokenURI against an
      // immutable IPFS CID/path. It cannot assign another token's traits.
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
    if (this.metadataCache.size > 500) this.metadataCache.clear();
    // Gateway outages are transient: retry fallback later, not forever.
    this.metadataCache.set(id, { result, until: result.metadataSource === 'TOKEN ID FALLBACK'
      ? Date.now() + 300000 : Infinity });
    return result;
  }
  async resolveArena(id) {
    if (!validId(id)) throw new Error('Invalid Chog token ID.');
    if (id === 'demo') return { ...(await this.getArena(id)), genome: 'demo-training', traitLabel: 'TRAINING PIT', imageUrl: null };
    try {
      const owner = await rpc.readContract({ address: NFT_ADDRESS, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(id)] });
      return { ...(await this.getArena(id)), ...(await this.getMetadata(id)), owner };
    } catch (error) { throw new Error(`Could not load a minted Chog NFT #${id}: ${error.shortMessage || error.message}`); }
  }
  async recordResult(room, player, summary) {
    const payout = payoutForRun(summary);
    const { result } = await this.mutateArena(room.arena.id, arena => {
      arena.raids++;
      if (summary.won) arena.clears++;
      arena.lastRun = { won: summary.won, loot: summary.loot, kills: summary.kills,
        tier: payout.key, score: payout.score, timeLeft: Math.round(summary.timeLeft),
        mode: room.mode === 'solo' ? 'server-solo' : room.mode === 'coop' ? 'live-coop' : 'live-pvp', room: room.code,
        raider: player.name, at: new Date().toISOString() };
      arena.recentRuns = [arena.lastRun, ...(Array.isArray(arena.recentRuns) ? arena.recentRuns.slice(0, 4) : [])];
      return summary.won ? arena.clears : null;
    });
    return result;
  }
  async recordScar(room, player, mark) {
    const clearIndex = await player.resultPromise;
    if (!Number.isInteger(clearIndex) || clearIndex < 1) throw new Error('The escape record was not saved; scar unavailable.');
    const { arena } = await this.mutateArena(room.arena.id, current => {
      const spot = SCAR_SPOTS[(clearIndex - 1) % SCAR_SPOTS.length];
      current.scars = [...current.scars.slice(-4), { type: mark, x: spot.x, y: spot.y,
        raider: player.name, at: new Date().toISOString() }];
    });
    return arena;
  }
  limited(request) {
    // Cloudflare controls CF-Connecting-IP at its public edge. We do not accept
    // X-Forwarded-For or a browser-provided player identity for rate limits.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    if (!this.rate.has(ip) && this.rate.size >= 4096) {
      for (const [key, entry] of this.rate) if (now - entry.start >= 60000) this.rate.delete(key);
      if (this.rate.size >= 4096) return true;
    }
    const current = this.rate.get(ip) || { start: now, count: 0 };
    if (now - current.start >= 60000) { current.start = now; current.count = 0; }
    current.count++;
    this.rate.set(ip, current);
    return current.count > 45;
  }
  async fetch(request) {
    try {
      const url = new URL(request.url), pathname = url.pathname;
      if (pathname === '/ws') return this.upgrade(request);
      if (pathname === '/healthz' && request.method === 'GET') return json(200,
        { ok: true, mode: 'GAME_ONLY', rewardPayoutsEnabled: false });
      if (pathname.startsWith('/api/')) return await this.api(request, url);
      return fail(404, 'Not found.');
    } catch (error) { console.error('Game-only Worker error:', error); return fail(500, 'Server error.'); }
  }
  upgrade(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return fail(400, 'WebSocket upgrade required.');
    try {
      const origin = request.headers.get('Origin');
      if (origin && (!['https:', 'http:'].includes(new URL(origin).protocol) ||
        new URL(origin).host !== new URL(request.url).host)) return fail(403, 'Origin mismatch.');
    } catch { return fail(403, 'Invalid Origin.'); }
    if (this.sockets.size >= SESSION_LIMIT) return fail(503, 'All sockets are busy.');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const adapter = new RoomSocket(server);
    this.sockets.set(server, adapter);
    this.rooms.wss.clients.add(adapter);
    this.rooms.accept(adapter);
    if (!this.tickTimer) {
      // At most one active simulation object. Timer stops when the last socket
      // leaves, avoiding both unnecessary compute and the free duration cap.
      this.tickTimer = setInterval(() => this.rooms.tickAll(), 33);
      this.cleanupTimer = setInterval(() => this.rooms.cleanup(), 30000);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket, message) {
    const adapter = this.sockets.get(socket);
    if (!adapter) { try { socket.close(1012, 'Server restarted'); } catch {} return; }
    if (typeof message !== 'string') { adapter.close(1009, 'Text messages only'); return; }
    const bytes = new TextEncoder().encode(message);
    if (bytes.length > 2048) { adapter.close(1009, 'Message too large'); return; }
    // LiveRooms validates JSON, message rate, gameplay input and ownership.
    adapter.emit('message', Buffer.from(bytes), false);
  }
  async webSocketClose(socket) { await this.closeAndFlush(socket); }
  async webSocketError(socket) { await this.closeAndFlush(socket); }
  async closeAndFlush(socket) {
    this.dropSocket(socket);
    // LiveRooms schedules its onResult callback on a microtask after a forfeit.
    // Do not let the final socket disconnect abandon the durable raid record.
    await Promise.resolve();
    await this.arenaWriteQueue.catch(error => console.warn('Raid persistence failed:', error));
  }
  dropSocket(socket) {
    const adapter = this.sockets.get(socket);
    if (!adapter) return;
    this.sockets.delete(socket);
    this.rooms.wss.clients.delete(adapter);
    adapter.emit('close');
    if (!this.sockets.size) {
      clearInterval(this.tickTimer); clearInterval(this.cleanupTimer);
      this.tickTimer = null; this.cleanupTimer = null;
      this.rooms.cleanup();
    }
  }
  async api(request, url) {
    const pathname = url.pathname, method = request.method;
    if (pathname === '/api/status' && method === 'GET') return json(200, { ok: true,
      mode: 'GAME_ONLY', gameOnly: true, chainId: 143, nft: NFT_ADDRESS, token: CHOG_ADDRESS,
      spendingEnabled: false, rewardPayoutsEnabled: false });
    if (pathname === '/api/rewards/status' && method === 'GET') return json(200,
      { previewOnly: true, payoutsEnabled: false, funded: false, transferable: false,
        walletPointsEnabled: false, noWalletLedger: true,
        prizes: [{ amount: 5, percent: 70 }, { amount: 10, percent: 25 }, { amount: 25, percent: 5 }] });
    if (pathname === '/api/campaign/status' && method === 'GET') return json(200,
      { ready: false, registrationsOpen: false, claimsEnabled: false, vault: null, funded: false,
        chainId: 143, message: 'This free game has no campaign signup, reward ledger, funded vault or real CHOG payout. Hidden amounts are samples only.' });
    if (pathname.startsWith('/api/campaign/')) return fail(423,
      'Email registration and real CHOG payouts are not active on this preview server.');
    if (pathname === '/api/claims/status' && method === 'GET') return json(200,
      { ready: false, claimsEnabled: false, vault: null, funded: false, chainId: 143, token: CHOG_ADDRESS,
        message: 'No CHOG claims or wallet points exist in this game. Hidden-box figures are non-redeemable samples; a future campaign would be separate.' });
    if (pathname.startsWith('/api/claims/')) return fail(423,
      'Real CHOG claims are locked until legal/security review, deployment, funding and verified proofs.');
    if (pathname.startsWith('/api/rewards/')) return fail(423,
      'This free game has no reward-wallet accounts, credits or CHOG payouts. Hidden amounts are non-redeemable samples.');
    const chainMatch = pathname.match(/^\/api\/chain\/([^/]+)\/([^/]+)$/);
    if (chainMatch && method === 'GET') {
      if (this.limited(request)) return fail(429, 'Too many lookups. Try again in a minute.');
      const [, address, id] = chainMatch;
      if (!validId(id) || id === 'demo') return fail(400, 'Enter a numeric Chog Genesis token ID.');
      let account;
      try { account = getAddress(address); } catch { return fail(400, 'Invalid wallet address.'); }
      try {
        const [owner, balance] = await Promise.all([
          rpc.readContract({ address: NFT_ADDRESS, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(id)] }),
          rpc.readContract({ address: CHOG_ADDRESS, abi: CHOG_ABI, functionName: 'balanceOf', args: [account] })
        ]);
        return json(200, { owner, isOwner: owner.toLowerCase() === account.toLowerCase(),
          balance: formatUnits(balance, 18), isChogHolder: balance >= 100n * 10n ** 18n });
      } catch (error) { return fail(503, `Monad lookup failed: ${error.shortMessage || error.message}`); }
    }
    const arenaMatch = pathname.match(/^\/api\/arena\/([^/]+)(?:\/(challenge|traps|raid))?$/);
    if (!arenaMatch) return fail(404, 'Not found.');
    const [, id, action] = arenaMatch;
    if (!validId(id)) return fail(400, 'Invalid arena ID.');
    if (!action && method === 'GET') {
      if (id === 'demo') return json(200, { ...(await this.getArena(id)), genome: 'demo-training', traitLabel: 'TRAINING PIT', imageUrl: null });
      if (this.limited(request)) return fail(429, 'Too many NFT lookups. Try again in a minute.');
      try {
        const owner = await rpc.readContract({ address: NFT_ADDRESS, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(id)] });
        return json(200, { ...(await this.getArena(id)), ...(await this.getMetadata(id)), owner });
      } catch (error) {
        const message = error.shortMessage || error.message;
        return fail(/revert|nonexistent|invalid token/i.test(message) ? 404 : 503, `Could not load Chog NFT #${id}: ${message}`);
      }
    }
    if (method !== 'POST') return fail(405, 'Method not allowed.');
    if (this.limited(request)) return fail(429, 'Too many requests. Try again in a minute.');
    let body;
    try { body = await bodyJson(request); } catch { return fail(400, 'Invalid JSON body.'); }
    if (action === 'challenge') {
      if (id === 'demo') return fail(400, 'The demo pit needs no owner signature.');
      if (!validTraps(body.traps)) return fail(400, 'Invalid trap layout (maximum 8 traps on the builder grid).');
      let account;
      try { account = getAddress(body.account); } catch { return fail(400, 'Invalid wallet.'); }
      const site = request.headers.get('Host') || new URL(request.url).host;
      if (!/^[a-zA-Z0-9.:-]{1,180}$/.test(site)) return fail(400, 'Invalid request host.');
      const now = Date.now();
      if (this.challenges.size >= 4096) {
        for (const [key, entry] of this.challenges) if (entry.expires <= now) this.challenges.delete(key);
        if (this.challenges.size >= 4096) return fail(429, 'Too many pending signatures. Try again later.');
      }
      const layout = canonicalTraps(body.traps);
      const nonce = crypto.randomUUID().replace(/-/g, '');
      const expires = now + 300000;
      const message = messageFor(id, account, nonce, expires, site, layout);
      this.challenges.set(nonce, { id, account, message, layout: JSON.stringify(layout), expires });
      return json(200, { message, nonce, expires });
    }
    if (action === 'traps') {
      if (!validTraps(body.traps)) return fail(400, 'Invalid trap layout (maximum 8 traps on the builder grid).');
      const layout = canonicalTraps(body.traps);
      if (id !== 'demo') {
        const challenge = this.challenges.get(body.nonce);
        this.challenges.delete(body.nonce);
        if (!challenge || challenge.id !== id || challenge.expires <= Date.now()) return fail(401, 'Signature challenge expired. Try saving again.');
        let account;
        try { account = getAddress(body.account); } catch { return fail(401, 'Invalid wallet.'); }
        if (account.toLowerCase() !== challenge.account.toLowerCase()) return fail(401, 'Wallet mismatch.');
        if (JSON.stringify(layout) !== challenge.layout) return fail(401, 'Signed trap layout changed. Review and sign again.');
        const verified = await verifyMessage({ address: account, message: challenge.message, signature: body.signature }).catch(() => false);
        if (!verified) return fail(401, 'Signature could not be verified.');
        try {
          const owner = await rpc.readContract({ address: NFT_ADDRESS, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(id)] });
          if (owner.toLowerCase() !== account.toLowerCase()) return fail(403, 'Only the current NFT owner can edit this arena.');
          if (body.traps.some(t => t.type === 'pulse')) {
            const balance = await rpc.readContract({ address: CHOG_ADDRESS, abi: CHOG_ABI, functionName: 'balanceOf', args: [account] });
            if (balance < 100n * 10n ** 18n) return fail(403, 'Pulse traps require holding 100 $CHOG. No token is spent.');
          }
        } catch (error) { return fail(503, `Monad lookup failed: ${error.shortMessage || error.message}`); }
      }
      const { arena } = await this.mutateArena(id, current => {
        current.traps = layout; current.updatedAt = new Date().toISOString();
      });
      return json(200, arena);
    }
    if (action === 'raid') {
      if (id !== 'demo') return fail(403, 'Unverified browser runs cannot change NFT arenas. Play server-run solo or a private PvP/co-op room.');
      const loot = Math.max(0, Math.min(25, Math.floor(Number(body.loot) || 0)));
      const kills = Math.max(0, Math.min(100, Math.floor(Number(body.kills) || 0)));
      const timeLeft = Math.max(0, Math.min(180, Number(body.timeLeft) || 0));
      const escaped = body.won === true && loot >= 2;
      const tier = !escaped ? 'lost' : loot >= 6 && kills >= 2 ? 'legend' : loot >= 4 || kills >= 2 ? 'heist' : 'safe';
      const score = escaped ? loot * 150 + kills * 100 + Math.round(timeLeft) : 0;
      const { arena } = await this.mutateArena(id, current => {
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
      return json(200, arena);
    }
    return fail(404, 'Not found.');
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    // Locked pass endpoints need no Durable Object or proxying of a POST body.
    // The status describes a local browser badge, never a chain claim record.
    if (pathname === '/api/pass/status' && request.method === 'GET') return json(200, {
      chainId: 143, nftContract: null, realClaimEnabled: false, sponsorMintReady: false,
      samplePassLocalOnly: true, rewardPayoutsEnabled: false,
      message: 'The sample Raider Pass is browser-only, not an NFT. No gas-sponsored Monad pass contract or real CHOG payout is live.'
    });
    if (pathname.startsWith('/api/pass/')) {
      if (request.body) await request.body.cancel();
      return fail(423, 'Raider Pass mainnet claims are locked. No NFT was minted or queued.');
    }
    if (pathname === '/ws' || pathname === '/healthz' || pathname.startsWith('/api/')) {
      const id = env.GAME.idFromName('chogpit-game-only-single-v1');
      return env.GAME.get(id).fetch(request);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed.');
    return env.ASSETS.fetch(request);
  }
};
