import { randomBytes, randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { buildArenaWorld, circleRect, clamp, WORLD_W, WORLD_H, LIVE_SPAWNS, BOT_STARTS } from './public/arena-world.js';
import { WEAPONS, REQUIRED_SUPPLIES, payoutForRun } from './public/game.js';

const ROUND_SECONDS = 180;
const ROOM_LIVES = 5; // Initial life plus four server-timed respawns in private rooms.
const RESPAWN_DELAY_MS = 3000;
const SPAWN_SHIELD_MS = 2500;
const COLORS = ['#fb799d', '#79dffd', '#ffe07a', '#b9ef78'];
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Server-private candidate sites. Only nearby unopened boxes are revealed to
// a player; opening is checked against the server's own position and state.
const HIDDEN_SITES = [
  [1290, 1470], [1890, 670], [2510, 1730], [2900, 880],
  [700, 1775], [2750, 1950], [1400, 1950], [2130, 1940],
  [440, 1110], [1600, 1790], [960, 1590], [2300, 600]
];
const BOT_NAMES = ['SCOUT', 'GUNK', 'BOLT', 'SNAP', 'JINX'];
const BOT_COLORS = ['#f7c942', '#ee657d', '#5bc9ef', '#ff9658', '#a583ec'];
const clampInput = value => Number.isFinite(value) ? clamp(value, -1, 1) : 0;
const safeName = value => String(value || '').trim().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 16) || 'RAIDER';
const connected = player => player.ws?.readyState === WebSocket.OPEN;
const send = (ws, payload) => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 1_000_000) { ws.close(1013, 'Connection too slow'); return; }
  if (payload.type === 'snapshot' && ws.bufferedAmount > 256_000) return;
  ws.send(JSON.stringify(payload));
};
const within = (a, b, range) => Math.hypot(a.x - b.x, a.y - b.y) < range;

export class LiveRooms {
  constructor({ resolveArena, resolveSession = () => null, onReward = async () => ({ status: 'sample-only' }),
    onVerifiedOpening = () => {}, onResult = async () => {}, onScar = async () => {},
    rewardMode = 'preview', accountKind = 'passkey',
    now = () => Date.now(), countdownMs = 3000 } = {}) {
    if (typeof resolveArena !== 'function') throw new Error('LiveRooms requires an arena resolver.');
    if (!['preview', 'campaign'].includes(rewardMode) || !['passkey','email'].includes(accountKind))
      throw new Error('Invalid hidden-box reward mode or account kind.');
    this.rewardMode = rewardMode; this.accountKind = accountKind;
    this.resolveArena = resolveArena; this.resolveSession = resolveSession; this.onReward = onReward;
    this.onVerifiedOpening = onVerifiedOpening; this.onResult = onResult; this.onScar = onScar;
    this.now = now; this.countdownMs = countdownMs; this.rooms = new Map();
    this.pendingCreates = 0;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
    this.timer = null; this.heartbeat = null;
  }
  attach(server) {
    server.on('upgrade', (request, socket, head) => {
      try {
        if (new URL(request.url || '/', 'http://localhost').pathname !== '/ws') return socket.destroy();
        // Browser origins must match the requested host. This limits casual
        // cross-site room abuse; it is NOT player authentication (non-browser
        // clients can omit/forge Origin). Bound idle sockets as well as rooms.
        const origin = request.headers.origin;
        if (origin && (typeof origin !== 'string' ||
          !['http:', 'https:'].includes(new URL(origin).protocol) ||
          new URL(origin).host !== request.headers.host)) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        if (this.wss.clients.size >= 240) {
          socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          return;
        }
        this.wss.handleUpgrade(request, socket, head, ws => this.accept(ws));
      } catch { socket.destroy(); }
    });
    this.timer = setInterval(() => this.tickAll(), 33);
    this.timer.unref?.();
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false; ws.ping();
      }
      this.cleanup();
    }, 30000);
    this.heartbeat.unref?.();
  }
  close() {
    clearInterval(this.timer); clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close(); this.rooms.clear();
  }
  accept(ws) {
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    ws.lastMessageAt = 0; ws.inputWindowAt = 0; ws.inputCount = 0;
    ws.messageWindowAt = 0; ws.messageCount = 0;
    ws.on('message', (data, isBinary) => {
      const now = this.now();
      if (now - ws.messageWindowAt > 1000) { ws.messageWindowAt = now; ws.messageCount = 0; }
      if (++ws.messageCount > 120) return ws.close(1008, 'Too many messages');
      if (isBinary || !Buffer.isBuffer(data) || data.length > 2048) return ws.close(1009, 'Message too large');
      let message;
      try { message = JSON.parse(data.toString('utf8')); }
      catch { return this.error(ws, 'Invalid message.'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.error(ws, 'Invalid message.');
      this.handle(ws, message).catch(error => this.error(ws, error?.message || 'Room request failed.'));
    });
    ws.on('close', () => this.disconnect(ws));
    ws.on('error', () => {});
    send(ws, { type: 'hello', rules: this.rewardMode === 'campaign'
      ? 'Solo or 2–4 live raiders · sign in with a free passkey before play · confirm a payout address after opening, before batching · sponsor-paid CHOG automatically transfers at 50'
      : 'Solo or 2–4 live raiders · hidden boxes are PREVIEW ONLY · no real token payouts' });
  }
  error(ws, text) { send(ws, { type: 'error', message: String(text).slice(0, 150) }); }
  async handle(ws, message) {
    const now = this.now();
    if (message.type === 'input') return this.receiveInput(ws, message, now);
    if (message.type === 'create' || message.type === 'solo' || message.type === 'join') {
      if (now - ws.lastMessageAt < 180) return this.error(ws, 'Wait a moment before making another room request.');
      ws.lastMessageAt = now;
    }
    if (message.type === 'create' || message.type === 'solo') return this.create(ws, message);
    if (message.type === 'join') return this.join(ws, message);
    if (message.type === 'link_wallet') return this.linkWallet(ws, message.session);
    if (message.type === 'link_account') return this.linkAccount(ws, message.session);
    if (message.type === 'set_mode') return this.setRoomMode(ws, message.mode);
    if (message.type === 'start') return this.startCountdown(ws);
    if (message.type === 'scar') return this.saveScar(ws, message);
    if (message.type === 'leave') { ws.close(1000, 'Left room'); return; }
    this.error(ws, 'Unknown room action.');
  }
  roomCode() {
    let code;
    do { code = [...randomBytes(6)].map(byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join(''); }
    while (this.rooms.has(code));
    return code;
  }
  resolveRewardAccount(session) {
    let account;
    try { account = session == null ? null : this.resolveSession(session); } catch { account = null; }
    if (this.rewardMode === 'campaign') {
      if (!account || typeof account.accountId !== 'string' || !/^[a-f0-9]{32}$/.test(account.accountId))
        throw new Error(`Sign in with a ${this.accountKind} account before playing campaign rounds.`);
      return account.accountId;
    }
    if (session != null && !account) throw new Error('Optional preview test link expired.');
    return account;
  }
  addPlayer(room, ws, name, session = null) {
    const accountId = this.resolveRewardAccount(session);
    const player = {
      id: randomBytes(6).toString('hex'), name: safeName(name), color: COLORS[room.players.length],
      hero: null,
      ws, room, status: 'waiting', rewardSession: session,
      rewardAccountId: this.rewardMode === 'campaign' ? accountId : null,
      rewardBoxesOpened: 0,
      input: { dx: 0, dy: 0, aim: 0, fire: false, interact: false },
      joinedAt: this.now(), lastInputAt: 0, scarUsed: false, scarPending: false, resultRecorded: false
    };
    ws.player = player; room.players.push(player); return player;
  }
  async create(ws, message) {
    if (ws.player || ws.pending) return this.error(ws, 'Leave your current room first.');
    if (this.rooms.size + this.pendingCreates >= 60) return this.error(ws, 'All rooms are busy. Try later.');
    try { this.resolveRewardAccount(message.session ?? null); }
    catch (error) { return this.error(ws, error.message); }
    const id = String(message.arenaId || 'demo').trim();
    if (id !== 'demo' && !/^(0|[1-9]\d{0,6})$/.test(id)) return this.error(ws, 'Enter a valid Chog token ID.');
    ws.pending = true;
    this.pendingCreates++;
    try {
      const arena = await this.resolveArena(id); // validates mint for real NFT arenas
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.rooms.size >= 60) return this.error(ws, 'All rooms are busy. Try later.');
      const code = this.roomCode();
      const room = { code, instanceId: randomBytes(16).toString('hex'), roundNumber: 0,
        mode: message.type === 'solo' ? 'solo' : 'pvp', arena,
        world: buildArenaWorld(arena.genome || arena.id), phase: 'waiting',
        players: [], bots: [], rewardBoxes: [], hostId: null, createdAt: this.now(), lastActivity: this.now(),
        startsAt: 0, startedAt: 0, lastTick: this.now(), lastBroadcast: 0,
        caches: [], weaponDrops: [], supplyDrops: [], bullets: [], traps: [], scars: [], winnerId: null, winnerName: null, nextDropId: 0 };
      this.rooms.set(code, room);
      const player = this.addPlayer(room, ws, message.name, message.session ?? null);
      if (message.hero && typeof message.hero.name === 'string') player.hero = { name: String(message.hero.name).slice(0,18), color: String(message.hero.color||'#ffa9b8'), weapon: String(message.hero.weapon||'rifle'), tokenId: Number(message.hero.tokenId)||null };
      room.hostId = player.id; this.broadcastRoom(room);
      if (room.mode === 'solo') this.startRound(room);
    } finally { this.pendingCreates--; ws.pending = false; }
  }
  join(ws, message) {
    if (ws.player || ws.pending) return this.error(ws, 'Leave your current room first.');
    const code = String(message.code || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return this.error(ws, 'That room code was not found.');
    if (room.mode === 'solo') return this.error(ws, 'Solo rounds cannot be joined.');
    if (!['waiting', 'finished', 'countdown'].includes(room.phase)) return this.error(ws, 'Room already fighting — host: LEAVE → CREATE new room for next code.');
    if (room.phase === 'finished') room.players = room.players.filter(connected);
    if (room.players.length >= 4) return this.error(ws, 'This room already has four raiders.');
    const p = this.addPlayer(room, ws, message.name, message.session ?? null);
    if (message.hero && typeof message.hero.name === 'string') p.hero = { name: String(message.hero.name).slice(0,18), color: String(message.hero.color||'#ffa9b8'), weapon: String(message.hero.weapon||'rifle'), tokenId: Number(message.hero.tokenId)||null };
    room.lastActivity = this.now(); this.broadcastRoom(room);
  }
  linkWallet(ws, session) {
    if (this.rewardMode === 'campaign')
      return this.error(ws, `Campaign boxes use ${this.accountKind} accounts; wallet linking is disabled.`);
    const player = ws.player;
    if (!player) return this.error(ws, 'Enter a room before linking a preview test wallet.');
    if (player.rewardBoxesOpened > 0) return this.error(ws, 'Link before your first hidden box next round.');
    const account = this.resolveRewardAccount(session);
    if (!account) return this.error(ws, 'Preview link expired.');
    player.rewardSession = session;
    send(ws, { type: 'reward_linked', account });
  }
  linkAccount(ws, session) {
    if (this.rewardMode !== 'campaign')
      return this.error(ws, 'Passkey accounts do not turn preview boxes into real rewards.');
    const player = ws.player;
    if (!player) return this.error(ws, 'Enter a room before refreshing your passkey session.');
    const accountId = this.resolveRewardAccount(session);
    if (accountId !== player.rewardAccountId)
      return this.error(ws, `This room is bound to a different ${this.accountKind} account.`);
    player.rewardSession = session;
    send(ws, { type: 'reward_linked', accountId });
  }
  setRoomMode(ws, mode) {
    const { player } = ws, room = player?.room;
    if (!room || room.mode === 'solo' || room.hostId !== player.id)
      return this.error(ws, 'Only the private-room host can choose the mode.');
    if (!['waiting', 'finished'].includes(room.phase))
      return this.error(ws, 'The mode cannot change during a round or countdown.');
    if (room.players.filter(connected).length < 2)
      return this.error(ws, 'Invite at least one other player before choosing the mode.');
    if (mode !== 'pvp' && mode !== 'coop')
      return this.error(ws, 'Choose PvP or co-op against bots.');
    if (room.mode === mode) return;
    room.mode = mode;
    room.lastActivity = this.now();
    this.broadcastRoom(room);
    this.broadcast(room, { type: 'event', text: mode === 'coop'
      ? 'Host chose CO-OP · fight bots together · friendly fire off · five lives each'
      : 'Host chose PVP · fight each other · five lives each' });
  }
  startCountdown(ws) {
    const { player } = ws, room = player?.room;
    if (!room || room.hostId !== player.id) return this.error(ws, 'Only the room host can start.');
    if (!['waiting', 'finished'].includes(room.phase)) return this.error(ws, 'A round is already in progress.');
    const participants = room.players.filter(connected);
    if (participants.length < (room.mode === 'solo' ? 1 : 2)) return this.error(ws, 'Invite at least one other player first.');
    // A disconnected participant can remain on a finished scoreboard, but not in a rematch.
    room.players = participants;
    room.hostId = participants.some(p => p.id === room.hostId) ? room.hostId : participants[0].id;
    room.phase = 'countdown'; room.startsAt = this.now() + this.countdownMs;
    room.lastActivity = this.now(); this.broadcastRoom(room);
  }
  startRound(room) {
    room.phase = 'playing'; room.startedAt = this.now(); room.lastTick = room.startedAt;
    room.lastBroadcast = 0; room.winnerId = null; room.winnerName = null; room.nextDropId = 0;
    room.roundNumber++;
    const sites = HIDDEN_SITES.filter(([x, y]) => room.world.obstacles.every(box => !circleRect(x, y, 38, box))
      && room.world.cacheSpots.every(cache => Math.hypot(cache.x - x, cache.y - y) > 115)
      && Math.hypot(x - room.world.spawn.x, y - room.world.spawn.y) > 190
      && Math.hypot(x - room.world.extract.x, y - room.world.extract.y) > 150);
    for (let i = sites.length - 1; i > 0; i--) { const j = randomInt(i + 1); [sites[i], sites[j]] = [sites[j], sites[i]]; }
    room.rewardBoxes = sites.slice(0, 4).map(([x, y], id) => ({ id, x, y, opened: false }));
    room.caches = room.world.cacheSpots.map((spot, id) => ({ ...spot, id, opened: false }));
    room.weaponDrops = room.world.weaponSpots.map((spot, id) => ({ ...spot, id, taken: false }));
    room.supplyDrops = []; room.bullets = [];
    room.bots = room.mode !== 'pvp' ? BOT_STARTS.map(([x, y], index) => {
      const spot = [[0, 0], [100, 90], [-100, -90], [120, -100]].map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
        .find(point => room.world.obstacles.every(box => !circleRect(point.x, point.y, 24, box))) || { x, y };
      return { ...spot, id: `bot:${index}`, name: BOT_NAMES[index % BOT_NAMES.length],
        color: BOT_COLORS[index % BOT_COLORS.length], r: 18, hp: 74, angle: 0, status: 'active',
        speed: 128 + (index % 4) * 10, shotCd: .55 + index * .14, roamCd: 0, roamX: 0, roamY: 0 };
    }) : [];
    room.traps = (room.arena.traps || []).map((trap, i) => ({ ...trap, cd: 1 + i * .2, fired: false }));
    room.scars = (room.arena.scars || []).map((scar, i) => ({ ...scar, cd: 1 + i }));
    const usedSpawns = [];
    room.players.forEach((player, index) => {
      const preferred = LIVE_SPAWNS[index];
      const offsets = [[0, 0], [0, -90], [-90, 0], [90, 0], [0, 90], [-90, -90], [90, 90], [-150, 60], [150, -60]];
      const spot = offsets.map(([dx, dy]) => ({ x: preferred.x + dx, y: preferred.y + dy }))
        .find(point => room.world.obstacles.every(box => !circleRect(point.x, point.y, 30, box))
          && usedSpawns.every(other => Math.hypot(point.x - other.x, point.y - other.y) > 75)) || preferred;
      usedSpawns.push(spot);
      Object.assign(player, { x: spot.x, y: spot.y, r: 19, hp: 100, shield: 30, angle: 0,
        weapon: 'PEASHOOTER', ammo: Infinity, reserve: Infinity, reload: 0, fireCd: 0,
        dashCd: 0, dashTime: 0, dashX: 0, dashY: 0, loot: 0, kills: 0,
        livesLeft: room.mode === 'solo' ? 1 : ROOM_LIVES, deaths: 0, respawnAt: 0,
        hold: 0, status: 'active', won: false, score: 0, scarUsed: false, scarPending: false,
        resultRecorded: false, spawnShieldUntil: this.now() + SPAWN_SHIELD_MS, stormCd: 0, openQueued: false,
        rewardBoxesOpened: 0, previewAmount: 0,
        input: { dx: 0, dy: 0, aim: 0, fire: false, interact: false }, lastInputAt: 0 });
    });
    this.broadcastRoom(room);
    this.broadcast(room, { type: 'start', code: room.code, at: room.startedAt });
    this.broadcastSnapshot(room);
  }
  receiveInput(ws, message, now) {
    const player = ws.player;
    if (!player || player.room.phase !== 'playing' || player.status !== 'active') return;
    if (now - ws.inputWindowAt > 1000) { ws.inputWindowAt = now; ws.inputCount = 0; }
    if (++ws.inputCount > 50) return; // inputs above 50 Hz confer no advantage
    const input = player.input;
    input.dx = clampInput(Number(message.dx)); input.dy = clampInput(Number(message.dy));
    const magnitude = Math.hypot(input.dx, input.dy);
    if (magnitude > 1) { input.dx /= magnitude; input.dy /= magnitude; }
    if (Number.isFinite(message.aim)) input.aim = clamp(message.aim, -Math.PI, Math.PI);
    input.fire = message.fire === true;
    input.interact = message.interact === true;
    if (message.interact === true) player.openQueued = true; // a quick tap still opens one nearby cache
    if (message.dash === true) input.dash = true;
    if (message.reload === true) input.reload = true;
    player.lastInputAt = now;
  }
  tickAll() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.phase === 'countdown' && now >= room.startsAt) this.startRound(room);
      if (room.phase !== 'playing') continue;
      const dt = clamp((now - room.lastTick) / 1000, 0, .05);
      room.lastTick = now;
      this.tickRoom(room, dt, now);
      if (now - room.lastBroadcast >= 67) this.broadcastSnapshot(room);
    }
  }
  tickRoom(room, dt, now) {
    const timeLeft = Math.max(0, ROUND_SECONDS - (now - room.startedAt) / 1000);
    if (timeLeft <= 0) {
      for (const player of room.players)
        if (player.status === 'active' || player.status === 'respawning') this.finishPlayer(room, player, false, 0);
      this.endRound(room); return;
    }
    for (const player of room.players)
      if (player.status === 'respawning' && now >= player.respawnAt) this.respawnPlayer(room, player, now);
    for (const player of room.players) if (player.status === 'active') this.updatePlayer(room, player, dt, now, timeLeft);
    if (room.mode !== 'pvp') this.updateBots(room, dt);
    this.updateTraps(room, dt, now, timeLeft);
    this.updateBullets(room, dt, now, timeLeft);
    for (const player of room.players)
      if (player.status === 'active' && player.hp <= 0) this.defeatPlayer(room, player, null, timeLeft, now);
    if (room.players.every(player => player.status !== 'active' && player.status !== 'respawning')) this.endRound(room);
  }
  respawnPlayer(room, player, now) {
    // Prefer a valid spawn far from active threats, rather than returning to
    // the place of death where another player or bot could camp a respawn.
    const threats = room.mode === 'pvp' ? room.players.filter(p => p !== player && p.status === 'active') : room.bots;
    const candidates = LIVE_SPAWNS.flatMap(({ x, y }) => [[0, 0], [0, -90], [-90, 0], [90, 0], [0, 90]]
      .map(([dx, dy]) => ({ x: x + dx, y: y + dy })))
      .filter(point => point.x > 40 && point.y > 40 && point.x < WORLD_W - 40 && point.y < WORLD_H - 40
        && room.world.obstacles.every(box => !circleRect(point.x, point.y, 30, box))
        && room.players.every(other => other === player || other.status !== 'active' || !within(point, other, 75)));
    candidates.sort((a, b) => {
      const safety = point => threats.length ? Math.min(...threats.map(threat => Math.hypot(point.x - threat.x, point.y - threat.y))) : 0;
      return safety(b) - safety(a);
    });
    const spot = candidates[0] || room.world.spawn;
    Object.assign(player, { x: spot.x, y: spot.y, hp: 100, shield: 30, angle: 0,
      weapon: 'PEASHOOTER', ammo: Infinity, reserve: Infinity, reload: 0, fireCd: 0,
      dashCd: 0, dashTime: 0, dashX: 0, dashY: 0, hold: 0, stormCd: 0,
      status: 'active', respawnAt: 0, spawnShieldUntil: now + SPAWN_SHIELD_MS,
      openQueued: false, input: { dx: 0, dy: 0, aim: 0, fire: false, interact: false }, lastInputAt: 0 });
    this.broadcast(room, { type: 'event', text: `${player.name} respawned · ${player.livesLeft} lives left` });
    this.broadcastRoom(room);
  }
  moveActor(room, actor, dx, dy) {
    actor.x = clamp(actor.x + dx, actor.r + 15, WORLD_W - actor.r - 15);
    if (room.world.obstacles.some(box => circleRect(actor.x, actor.y, actor.r, box))) actor.x -= dx;
    actor.y = clamp(actor.y + dy, actor.r + 15, WORLD_H - actor.r - 15);
    if (room.world.obstacles.some(box => circleRect(actor.x, actor.y, actor.r, box))) actor.y -= dy;
    actor.x = clamp(actor.x, actor.r + 15, WORLD_W - actor.r - 15);
    actor.y = clamp(actor.y, actor.r + 15, WORLD_H - actor.r - 15);
  }
  canSee(room, a, b) {
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const steps = Math.max(1, Math.ceil(distance / 15));
    for (let i = 1; i < steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
      if (room.world.obstacles.some(box => circleRect(x, y, 2, box))) return false;
    }
    return true;
  }
  updateBots(room, dt) {
    for (const bot of room.bots) {
      bot.shotCd -= dt; bot.roamCd -= dt;
      const target = room.players.filter(p => p.status === 'active'
        && within(bot, p, 670 + Math.min(4, Math.max(0, p.loot - REQUIRED_SUPPLIES)) * 85))
        .sort((a, b) => Math.hypot(a.x - bot.x, a.y - bot.y) - Math.hypot(b.x - bot.x, b.y - bot.y))[0];
      let dx = 0, dy = 0;
      if (target) {
        const distance = Math.hypot(target.x - bot.x, target.y - bot.y) || 1;
        const ux = (target.x - bot.x) / distance, uy = (target.y - bot.y) / distance;
        bot.angle = Math.atan2(uy, ux);
        if (distance > 175) { dx = ux; dy = uy; }
        else if (distance < 115) { dx = -ux; dy = -uy; }
        else { dx = -uy; dy = ux; }
        if (distance < 565 && bot.shotCd <= 0 && this.canSee(room, bot, target)) {
          const wobble = (Math.random() - .5) * .19;
          const angle = bot.angle + wobble;
          room.bullets.push({ x: bot.x + Math.cos(angle) * 25, y: bot.y + Math.sin(angle) * 25,
            vx: Math.cos(angle) * 570, vy: Math.sin(angle) * 570, damage: 8,
            owner: bot.id, life: 1.1, r: 4, color: '#ff9ba9' });
          bot.shotCd = .9 + Math.random() * .48;
        }
      } else {
        if (bot.roamCd <= 0) {
          bot.roamCd = 1.5 + Math.random() * 2;
          const angle = Math.random() * Math.PI * 2;
          bot.roamX = Math.cos(angle); bot.roamY = Math.sin(angle);
        }
        dx = bot.roamX; dy = bot.roamY;
        bot.angle = Math.atan2(dy, dx);
      }
      this.moveActor(room, bot, dx * bot.speed * dt, dy * bot.speed * dt);
    }
  }
  updatePlayer(room, player, dt, now, timeLeft) {
    const input = now - player.lastInputAt <= 500 ? player.input : { dx: 0, dy: 0, aim: player.angle, fire: false, interact: false };
    player.angle = input.aim;
    player.fireCd = Math.max(0, player.fireCd - dt);
    player.dashCd = Math.max(0, player.dashCd - dt);
    if (player.reload > 0) {
      player.reload -= dt;
      if (player.reload <= 0) {
        player.reload = 0;
        const gun = WEAPONS[player.weapon];
        const amount = Math.min(gun.mag - player.ammo, player.reserve);
        player.ammo += amount; player.reserve -= amount;
      }
    }
    if (input.reload) this.startReload(player);
    input.reload = false;
    if (input.dash && player.dashCd <= 0) {
      const m = Math.hypot(input.dx, input.dy);
      player.dashX = m ? input.dx / m : Math.cos(player.angle);
      player.dashY = m ? input.dy / m : Math.sin(player.angle);
      player.dashTime = .19; player.dashCd = 3.6;
    }
    input.dash = false;
    let speed = 250;
    if (room.traps.some(trap => trap.type === 'slime' && within(trap, player, 75))) speed *= .62;
    if (room.scars.some(scar => scar.type === 'spores' && within(scar, player, 75))) speed *= .68;
    let dx = input.dx, dy = input.dy;
    if (player.dashTime > 0) { player.dashTime -= dt; dx = player.dashX; dy = player.dashY; speed = 730; }
    this.moveActor(room, player, dx * speed * dt, dy * speed * dt);
    let openedHidden = false;
    for (const box of room.rewardBoxes) if (!box.opened && (input.interact || player.openQueued) && within(box, player, 66)) {
      let identity, recorded;
      try {
        // Recheck the passkey session on the actual server-checked opening.
        // Identity is bound to the account selected at room entry, not to a
        // newly pasted payout address or an unauthenticated WebSocket message.
        const accountId = this.resolveRewardAccount(player.rewardSession);
        if (this.rewardMode === 'campaign' && accountId !== player.rewardAccountId)
          throw new Error('Passkey account changed during the round.');
        identity = { rewardSession: player.rewardSession,
          accountId: this.rewardMode === 'campaign' ? accountId : null };
        // Commit synchronously BEFORE changing world state. The hosted preview
        // records telemetry only; a separately configured fresh campaign may
        // instead journal a new eligible candidate under reviewed rules.
        recorded = this.onVerifiedOpening(room, identity, box);
        if (recorded?.then) throw new Error('Opening journal must commit synchronously.');
      } catch (error) {
        console.warn('Box observation failed; box remains closed:', error.message);
        this.error(player.ws, 'Hidden box unavailable: server could not record the opening. Try again.');
        openedHidden = true; // Do not accidentally open an ordinary cache instead.
        break;
      }
      box.opened = true; openedHidden = true; player.rewardBoxesOpened++;
      this.broadcast(room, { type: 'event', text: this.rewardMode === 'campaign'
        ? `${player.name} opened a campaign box · proof and CHOG outcome pending publication`
        : `${player.name} found a hidden preview box · no real CHOG awarded` });
      Promise.resolve().then(() => this.onReward(room, identity, box, recorded)).then(result => {
        if (this.rewardMode === 'preview' && (result.status === 'preview-credit' || result.status === 'sample-only')
          && Number.isFinite(result.amount)) player.previewAmount += result.amount;
        send(player.ws, { type: this.rewardMode === 'campaign' ? 'claim_pending' : 'preview_reward',
          boxId: box.id, ...result });
      }).catch(error => {
        console.warn('Hidden box follow-up failed:', error.message);
        send(player.ws, { type: this.rewardMode === 'campaign' ? 'claim_pending' : 'preview_reward',
          boxId: box.id, status: 'error', note: this.rewardMode === 'campaign'
            ? 'Opening was journaled but the follow-up failed. Check the campaign claim service.'
            : 'Preview record failed. No tokens were awarded.' });
      });
      break;
    }
    if (!openedHidden) for (const cache of room.caches) if (!cache.opened && (input.interact || player.openQueued) && within(cache, player, 66)) {
      cache.opened = true; player.loot++;
      if (cache.id % 4 === 0) player.shield = Math.min(75, player.shield + 24);
      if (cache.id % 4 === 1) player.hp = Math.min(100, player.hp + 18);
      this.broadcast(room, { type: 'event', text: `${player.name} opened supply #${cache.id + 1} · ${player.loot} carried` });
      break;
    }
    player.openQueued = false;
    for (const drop of room.supplyDrops) if (!drop.taken && within(drop, player, 36)) {
      drop.taken = true; player.loot++;
      this.broadcast(room, { type: 'event', text: `${player.name} grabbed a dropped supply` });
    }
    room.supplyDrops = room.supplyDrops.filter(drop => !drop.taken);
    for (const drop of room.weaponDrops) if (!drop.taken && within(drop, player, 33)) {
      drop.taken = true; const gun = WEAPONS[drop.weapon];
      player.weapon = drop.weapon; player.ammo = gun.mag; player.reserve = gun.reserve; player.reload = 0;
      this.broadcast(room, { type: 'event', text: `${player.name} picked up ${drop.weapon}` });
    }
    if (input.fire) this.fire(room, player);
    const atExit = within(player, room.world.extract, 79);
    const holdTime = 1.5 + Math.min(4, Math.max(0, player.loot - REQUIRED_SUPPLIES)) * .35;
    if (atExit && player.loot >= REQUIRED_SUPPLIES && input.interact) {
      player.hold += dt;
      if (player.hold >= holdTime) this.finishPlayer(room, player, true, timeLeft);
    } else player.hold = Math.max(0, player.hold - dt * 2.4);
    if (now - room.startedAt > 66000) {
      const radius = clamp(1910 - ((now - room.startedAt) / 1000 - 66) * 12.4, 470, 1910);
      player.stormCd -= dt;
      if (Math.hypot(player.x - 1600, player.y - 1110) > radius && player.stormCd <= 0) {
        player.stormCd = .5; this.damage(room, player, 4, null, timeLeft, now);
      }
    }
  }
  startReload(player) {
    if (player.weapon === 'PEASHOOTER' || player.reload > 0 || player.ammo >= WEAPONS[player.weapon].mag || player.reserve <= 0) return;
    player.reload = player.weapon === 'SHOTGUN' ? 1.4 : 1.05;
  }
  fire(room, player) {
    const gun = WEAPONS[player.weapon];
    if (player.fireCd > 0 || player.reload > 0) return;
    if (player.ammo <= 0) { this.startReload(player); return; }
    player.fireCd = gun.rate;
    if (Number.isFinite(player.ammo)) player.ammo--;
    for (let i = 0; i < gun.pellets; i++) {
      const spread = gun.pellets === 1 ? (Math.random() - .5) * gun.spread
        : (i - (gun.pellets - 1) / 2) / (gun.pellets - 1) * gun.spread + (Math.random() - .5) * .04;
      const angle = player.angle + spread;
      room.bullets.push({ x: player.x + Math.cos(angle) * 29, y: player.y + Math.sin(angle) * 29,
        vx: Math.cos(angle) * gun.speed, vy: Math.sin(angle) * gun.speed, damage: gun.damage,
        owner: player.id, life: gun.pellets > 1 ? .65 : 1.1, r: gun.pellets > 1 ? 3 : 4, color: gun.color });
    }
    if (room.bullets.length > 220) room.bullets.splice(0, room.bullets.length - 220);
  }
  damage(room, target, amount, shooterId, timeLeft, now) {
    // A teammate's projectile never harms a player in co-op, even if a caller
    // bypasses the normal bullet collision path.
    if (room.mode === 'coop' && room.players.some(p => p.id === shooterId)) return;
    if (target.status !== 'active' || now < target.spawnShieldUntil) return;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed; target.hp = Math.max(0, target.hp - (amount - absorbed));
    if (target.hp <= 0) this.defeatPlayer(room, target, shooterId, timeLeft, now);
  }
  defeatPlayer(room, target, shooterId, timeLeft, now) {
    if (target.status !== 'active') return;
    const shooter = room.players.find(p => p.id === shooterId);
    if (shooter && shooter !== target) shooter.kills++;
    for (let i = 0; i < Math.min(target.loot, 3); i++) room.supplyDrops.push({
      id: ++room.nextDropId, x: clamp(target.x + (i - 1) * 25, 45, WORLD_W - 45),
      y: clamp(target.y + (i % 2 ? 18 : -13), 45, WORLD_H - 45), taken: false
    });
    target.deaths++;
    target.livesLeft = Math.max(0, target.livesLeft - 1);
    if (room.mode !== 'solo' && target.livesLeft > 0 && timeLeft > 0) {
      target.status = 'respawning'; target.respawnAt = now + RESPAWN_DELAY_MS;
      target.hp = 0; target.shield = 0; target.loot = 0; target.hold = 0;
      target.spawnShieldUntil = 0; target.openQueued = false;
      target.input = { dx: 0, dy: 0, aim: target.angle, fire: false, interact: false };
      target.lastInputAt = 0;
      this.broadcast(room, { type: 'event', text: `${target.name} was downed${shooter ? ` by ${shooter.name}` : ''} · ${target.livesLeft} lives left` });
      this.broadcastRoom(room);
    } else {
      this.broadcast(room, { type: 'event', text: `${target.name} was eliminated${shooter ? ` by ${shooter.name}` : ''} · no lives left` });
      this.finishPlayer(room, target, false, timeLeft);
    }
  }
  updateBullets(room, dt, now, timeLeft) {
    const next = [];
    for (const bullet of room.bullets) {
      const playerBullet = room.players.some(p => p.id === bullet.owner);
      const x0 = bullet.x, y0 = bullet.y;
      bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt; bullet.life -= dt;
      if (bullet.life <= 0 || bullet.x < 0 || bullet.y < 0 || bullet.x > WORLD_W || bullet.y > WORLD_H) continue;
      let hit = false;
      const steps = Math.max(3, Math.ceil(Math.hypot(bullet.vx * dt, bullet.vy * dt) / 10));
      for (let i = 1; i <= steps && !hit; i++) {
        const x = x0 + (bullet.x - x0) * i / steps, y = y0 + (bullet.y - y0) * i / steps;
        if (room.world.obstacles.some(box => circleRect(x, y, bullet.r, box))) { hit = true; break; }
        for (const target of room.players) {
          if (target.id === bullet.owner || target.status !== 'active' || (room.mode === 'coop' && playerBullet)) continue;
          if (Math.hypot(target.x - x, target.y - y) < target.r + bullet.r) {
            this.damage(room, target, bullet.damage, bullet.owner, timeLeft, now);
            hit = true; break;
          }
        }
        if (!hit && room.mode !== 'pvp' && playerBullet) {
          for (let index = room.bots.length - 1; index >= 0; index--) {
            const bot = room.bots[index];
            if (Math.hypot(bot.x - x, bot.y - y) >= bot.r + bullet.r) continue;
            bot.hp -= bullet.damage; hit = true;
            if (bot.hp <= 0) {
              room.bots.splice(index, 1);
              const shooter = room.players.find(p => p.id === bullet.owner);
              if (shooter?.status === 'active') {
                shooter.kills++; shooter.shield = Math.min(75, shooter.shield + 5);
                room.supplyDrops.push({ id: ++room.nextDropId, x: bot.x, y: bot.y, taken: false });
              }
              this.broadcast(room, { type: 'event', text: `${bot.name} was eliminated · supply dropped` });
            }
            break;
          }
        }
      }
      if (!hit) next.push(bullet);
    }
    room.bullets = next;
  }
  updateTraps(room, dt, now, timeLeft) {
    for (const trap of room.traps) {
      trap.cd -= dt;
      if (trap.type === 'mine' && !trap.fired) {
        const target = room.players.find(p => p.status === 'active' && within(trap, p, 45));
        if (target) { trap.fired = true; this.damage(room, target, 22, null, timeLeft, now); }
      }
      if (trap.type === 'pulse' && trap.cd <= 0) {
        const target = room.players.find(p => p.status === 'active' && within(trap, p, 120));
        if (target) { trap.cd = 2.1; this.damage(room, target, 13, null, timeLeft, now); }
      }
      if (trap.type === 'turret' && trap.cd <= 0) {
        const target = room.players.find(p => p.status === 'active' && within(trap, p, 500) && this.canSee(room, trap, p));
        if (target) {
          const angle = Math.atan2(target.y - trap.y, target.x - trap.x);
          room.bullets.push({ x: trap.x, y: trap.y, vx: Math.cos(angle) * 560, vy: Math.sin(angle) * 560,
            damage: 11, owner: 'trap', life: 1.4, r: 4, color: '#fe8ca0' });
          trap.cd = 1.7;
        }
      }
    }
    for (const scar of room.scars) {
      scar.cd -= dt;
      if (scar.type === 'acid' && scar.cd <= 0) {
        const target = room.players.find(p => p.status === 'active' && within(scar, p, 66));
        if (target) { scar.cd = 1.2; this.damage(room, target, 7, null, timeLeft, now); }
      }
      if (scar.type === 'static' && scar.cd <= 0) {
        const target = room.players.find(p => p.status === 'active' && within(scar, p, 180));
        if (target) {
          const angle = Math.atan2(target.y - scar.y, target.x - scar.x);
          room.bullets.push({ x: scar.x, y: scar.y, vx: Math.cos(angle) * 440, vy: Math.sin(angle) * 440,
            damage: 7, owner: 'scar', life: 1.4, r: 4, color: '#e4baff' });
          scar.cd = 2.9;
        }
      }
    }
  }
  finishPlayer(room, player, won, timeLeft) {
    if (player.status !== 'active' && player.status !== 'respawning') return;
    const summary = { won, loot: player.loot, kills: player.kills, timeLeft: Math.max(0, timeLeft), timeUsed: ROUND_SECONDS - Math.max(0, timeLeft) };
    const payout = payoutForRun(summary);
    player.status = won ? 'escaped' : 'eliminated'; player.won = won; player.score = payout.score;
    player.hold = 0; player.respawnAt = 0;
    player.input = { dx: 0, dy: 0, aim: player.angle, fire: false, interact: false };
    player.clearIndex = null;
    if (!player.resultRecorded) {
      player.resultRecorded = true;
      player.resultPromise = Promise.resolve().then(() => this.onResult(room, player, summary))
        .then(index => { player.clearIndex = index; return index; });
      player.resultPromise.catch(error => console.warn('Live raid record failed:', error.message));
    }
    send(player.ws, { type: 'result', summary, payout, code: room.code });
    this.broadcastRoom(room);
  }
  endRound(room) {
    if (room.phase !== 'playing') return;
    room.phase = 'finished'; room.lastActivity = this.now();
    const sorted = room.players.filter(p => p.won).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
    room.winnerId = sorted[0]?.id || null; room.winnerName = sorted[0]?.name || null;
    this.broadcast(room, { type: 'round_end', winnerId: room.winnerId, winnerName: room.winnerName, standings: this.standings(room) });
    this.broadcastRoom(room);
  }
  async saveScar(ws, message) {
    const player = ws.player, room = player?.room;
    if (!room || player.status !== 'escaped' || player.scarUsed || player.scarPending) return this.error(ws, 'Only an escaped raider can leave one scar.');
    const mark = String(message.mark || '');
    if (!['acid', 'static', 'spores'].includes(mark)) return this.error(ws, 'Choose a valid scar.');
    player.scarPending = true;
    try {
      const updatedArena = await this.onScar(room, player, mark);
      if (updatedArena) room.arena = { ...room.arena, ...updatedArena };
      player.scarUsed = true;
      this.broadcast(room, { type: 'event', text: `${player.name} left a ${mark.toUpperCase()} scar on this arena` });
      send(ws, { type: 'scar_saved', mark, arena: room.arena });
    } finally { player.scarPending = false; }
  }
  standings(room) {
    const now = this.now();
    return room.players.map(p => ({ id: p.id, name: p.name, color: p.color, hero: p.hero || null, status: p.status,
      loot: p.loot || 0, kills: p.kills || 0, score: p.score || 0, won: !!p.won,
      livesLeft: p.livesLeft ?? (room.mode === 'solo' ? 1 : ROOM_LIVES), deaths: p.deaths || 0,
      respawnIn: p.status === 'respawning' ? Math.max(0, (p.respawnAt - now) / 1000) : 0,
      connected: connected(p) }));
  }
  roomPayload(room, you) {
    return { type: 'room', code: room.code, mode: room.mode, phase: room.phase, you: you?.id,
      hostId: room.hostId, startsAt: room.startsAt, winnerId: room.winnerId, winnerName: room.winnerName,
      arena: room.arena, standings: this.standings(room), maxPlayers: room.mode === 'solo' ? 1 : 4,
      livesPerPlayer: room.mode === 'solo' ? 1 : ROOM_LIVES, roundSeconds: ROUND_SECONDS,
      rewardMode: this.rewardMode, rewardPreviewOnly: this.rewardMode === 'preview' };
  }
  broadcast(room, data) { for (const player of room.players) send(player.ws, data); }
  broadcastRoom(room) { for (const player of room.players) send(player.ws, this.roomPayload(room, player)); }
  snapshot(room, viewer = null) {
    const now = this.now();
    const timeLeft = Math.max(0, ROUND_SECONDS - (now - room.startedAt) / 1000);
    return { type: 'snapshot', code: room.code, phase: room.phase, timeLeft, winnerId: room.winnerId,
      rewardBoxes: viewer?.status === 'active' ? room.rewardBoxes.filter(b => !b.opened && within(b, viewer, 165))
        .map(({ id, x, y }) => ({ id, x, y })) : [],
      players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, status: p.status,
        x: p.x, y: p.y, hp: Math.ceil(p.hp), shield: Math.ceil(p.shield), angle: p.angle,
        weapon: p.weapon, ammo: Number.isFinite(p.ammo) ? p.ammo : -1,
        reserve: Number.isFinite(p.reserve) ? p.reserve : -1, reload: p.reload,
        dashCd: p.dashCd, loot: p.loot, kills: p.kills, score: p.score, hold: p.hold,
        livesLeft: p.livesLeft, deaths: p.deaths,
        respawnIn: p.status === 'respawning' ? Math.max(0, (p.respawnAt - now) / 1000) : 0,
        spawnShield: Math.max(0, (p.spawnShieldUntil - now) / 1000) })).concat(room.bots.map(bot => ({
          id: bot.id, name: bot.name, color: bot.color, status: 'active', x: bot.x, y: bot.y,
          hp: Math.max(0, Math.ceil(bot.hp)), shield: 0, angle: bot.angle, r: bot.r,
          weapon: 'PEASHOOTER', ammo: -1, reserve: -1, reload: 0, dashCd: 0,
          loot: 0, kills: 0, score: 0, hold: 0, livesLeft: 0, deaths: 0, respawnIn: 0, spawnShield: 0 }))),
      opened: room.caches.filter(c => c.opened).map(c => c.id),
      takenWeapons: room.weaponDrops.filter(w => w.taken).map(w => w.id),
      drops: room.supplyDrops.map(d => ({ id: d.id, x: d.x, y: d.y })),
      bullets: room.bullets.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, color: b.color, r: b.r })),
      traps: room.traps.map(t => ({ type: t.type, x: t.x, y: t.y, fired: t.fired })),
      standings: this.standings(room) };
  }
  broadcastSnapshot(room) {
    // Send each player only the hidden boxes that their own avatar can see.
    for (const player of room.players) send(player.ws, this.snapshot(room, player));
    room.lastBroadcast = this.now();
  }
  disconnect(ws) {
    const player = ws.player;
    if (!player) return;
    const room = player.room; ws.player = null; player.ws = null;
    if (room.phase === 'playing' && (player.status === 'active' || player.status === 'respawning')) {
      const timeLeft = Math.max(0, ROUND_SECONDS - (this.now() - room.startedAt) / 1000);
      this.finishPlayer(room, player, false, timeLeft);
      this.broadcast(room, { type: 'event', text: `${player.name} disconnected and forfeited the run` });
      if (room.players.every(p => p.status !== 'active' && p.status !== 'respawning')) this.endRound(room);
    } else if (room.phase === 'waiting' || room.phase === 'countdown' || room.phase === 'finished') {
      room.players = room.players.filter(p => p !== player);
      if (room.phase === 'countdown' && room.players.length < 2) room.phase = 'waiting';
    }
    const remaining = room.players.filter(connected);
    if (!remaining.length) { this.rooms.delete(room.code); return; }
    if (!remaining.some(p => p.id === room.hostId)) room.hostId = remaining[0].id;
    room.lastActivity = this.now(); this.broadcastRoom(room);
  }
  cleanup() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (!room.players.some(connected) || (room.phase === 'finished' && now - room.lastActivity > 30 * 60 * 1000)
        || (room.phase === 'waiting' && now - room.createdAt > 60 * 60 * 1000)) {
        for (const p of room.players) p.ws?.close(1000, 'Room expired');
        this.rooms.delete(room.code);
      }
    }
  }
}
