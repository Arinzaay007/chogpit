import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { LiveRooms } from '../live-rooms.mjs';
import { buildArenaWorld, circleRect } from '../public/arena-world.js';

// Deterministic server simulation: malicious clients can only send controls.
let clock = 1_000_000, clearIndex = 0;
const records = [], scars = [];
const fakeArena = () => ({ id: 'demo', genome: 'demo-training', traps: [], scars: [] });
const hub = new LiveRooms({ resolveArena: async () => fakeArena(), now: () => clock, countdownMs: 100,
  onResult: async (room, player, summary) => {
    records.push({ id: player.id, ...summary });
    return summary.won ? ++clearIndex : null;
  },
  onScar: async (room, player, mark) => {
    scars.push({ id: player.id, mark, clearIndex: player.clearIndex });
    return { ...room.arena, scars: [...room.arena.scars, { type: mark, x: 1450, y: 1300 }] };
  }
});
const fakeSocket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, messages: [],
  inputWindowAt: 0, inputCount: 0, send(payload) { this.messages.push(JSON.parse(payload)); },
  close() { this.readyState = WebSocket.CLOSED; } });
const a = fakeSocket(), b = fakeSocket(), c = fakeSocket(), d = fakeSocket(), extra = fakeSocket();
await hub.create(a, { arenaId: 'demo', name: '  ALICE<script>  ' });
const room = a.player.room;
assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
assert.equal(a.player.name, 'ALICEscript');
for (const [socket, name] of [[b, 'BOB'], [c, 'CAROL'], [d, 'DANA']]) hub.join(socket, { code: room.code, name });
hub.join(extra, { code: room.code, name: 'EXTRA' });
assert.equal(room.players.length, 4);
assert.match(extra.messages.at(-1).message, /four raiders/);
assert.equal(b.messages.find(message => message.type === 'room').arena.id, 'demo');
hub.startCountdown(a);
clock += 101; hub.tickAll();
assert.equal(room.phase, 'playing');
assert.equal(room.world.cacheSpots.length, buildArenaWorld('demo-training').cacheSpots.length);
for (const player of room.players) assert.ok(room.world.obstacles.every(box => !circleRect(player.x, player.y, player.r, box)), 'Spawns must be on walkable terrain.');
const advance = (ms, before = () => {}) => { for (let t = 0; t < ms; t += 33) { clock += 33; before(t); hub.tickAll(); } };
// Forged coordinates, rewards and claimed hit outcomes are ignored.
hub.receiveInput(a, { type: 'input', x: 2320, y: 1470, hp: 999, loot: 99, kills: 99, won: true, score: 99999, dx: 0, dy: 0 }, clock);
advance(66);
assert.equal(a.player.x, 900); assert.equal(a.player.loot, 0); assert.equal(a.player.hp, 100);
// The same visible wall stops server-authoritative movement.
a.player.x = 800; a.player.y = 1000;
advance(330, t => { if (t % 99 === 0) hub.receiveInput(a, { dy: 1, dx: 0 }, clock); });
assert.ok(a.player.y < 1022, `Server let a player pass through solid cover: ${a.player.y}`);
// Shared caches can be opened by only one raider.
a.player.x = 1060; a.player.y = 855;
b.player.x = 1090; b.player.y = 855;
hub.receiveInput(a, { dx: 0, dy: 0, interact: true }, clock);
hub.receiveInput(b, { dx: 0, dy: 0, interact: true }, clock);
advance(33);
assert.equal(a.player.loot, 1); assert.equal(b.player.loot, 0);
assert.ok(hub.snapshot(room).opened.includes(0));
// Dash, aim, weapon hits, shield and health are server properties.
a.player.x = 450; a.player.y = 420; b.player.x = 590; b.player.y = 420;
a.player.spawnShieldUntil = 0; b.player.spawnShieldUntil = 0;
advance(1000, t => { if (t % 99 === 0) hub.receiveInput(a, { dx: 0, dy: 0, aim: 0, fire: true }, clock); });
assert.ok(b.player.shield < 30 || b.player.hp < 100, 'Server projectiles should hurt the rival.');
assert.ok(room.bullets.every(projectile => Number.isFinite(projectile.vx)));
// Escape requires both supplies and a continuous, server-measured exit hold.
a.player.x = room.world.extract.x; a.player.y = room.world.extract.y;
a.player.loot = 1; a.player.input.fire = false;
advance(1750, t => { if (t % 99 === 0) hub.receiveInput(a, { dx: 0, dy: 0, interact: true }, clock); });
assert.equal(a.player.status, 'active', 'One supply must not unlock extraction.');
a.player.loot = 2;
advance(1750, t => { if (t % 99 === 0) hub.receiveInput(a, { dx: 0, dy: 0, interact: true }, clock); });
assert.equal(a.player.status, 'escaped');
assert.ok(a.messages.some(message => message.type === 'result' && message.payout.crates === 1));
await a.player.resultPromise;
assert.equal(records.filter(entry => entry.id === a.player.id).length, 1);
await hub.saveScar(a, { mark: 'acid' });
await hub.saveScar(a, { mark: 'spores' });
assert.deepEqual(scars, [{ id: a.player.id, mark: 'acid', clearIndex: 1 }]);
assert.equal(room.arena.scars.at(-1).type, 'acid');
// A new round resets loot, lives, shared pickups and scores.
for (const player of [b.player, c.player, d.player]) hub.finishPlayer(room, player, false, 100);
hub.endRound(room);
assert.equal(room.phase, 'finished'); assert.equal(room.winnerId, a.player.id);
hub.startCountdown(a); clock += 101; hub.tickAll();
assert.equal(room.phase, 'playing'); assert.equal(a.player.loot, 0); assert.equal(room.scars.length, 1);

// Both room modes share the extraction objective, but only the host can select
// one after a friend joins. Server-owned life/respawn clocks cannot be spoofed.
const modeResults = [];
const choiceHub = new LiveRooms({ resolveArena: async () => fakeArena(), now: () => clock, countdownMs: 100,
  onResult: async (selectedRoom, player, summary) => {
    modeResults.push({ id: player.id, mode: selectedRoom.mode, ...summary });
    return summary.won ? 1 : null;
  } });
const captain = fakeSocket(), mate = fakeSocket();
await choiceHub.handle(captain, { type: 'create', arenaId: 'demo', name: 'CAPTAIN' });
const selected = captain.player.room;
assert.equal(selected.mode, 'pvp');
await choiceHub.handle(captain, { type: 'set_mode', mode: 'coop' });
assert.match(captain.messages.at(-1).message, /Invite at least one/);
choiceHub.join(mate, { code: selected.code, name: 'MATE' });
await choiceHub.handle(mate, { type: 'set_mode', mode: 'coop' });
assert.match(mate.messages.at(-1).message, /Only the private-room host/);
await choiceHub.handle(captain, { type: 'set_mode', mode: '__fake__' });
assert.match(captain.messages.at(-1).message, /Choose PvP or co-op/);
await choiceHub.handle(captain, { type: 'set_mode', mode: 'coop' });
assert.equal(selected.mode, 'coop');
assert.equal(mate.messages.filter(message => message.type === 'room').at(-1).mode, 'coop');
assert.equal(mate.messages.filter(message => message.type === 'room').at(-1).livesPerPlayer, 5);
choiceHub.startCountdown(captain);
await choiceHub.handle(captain, { type: 'set_mode', mode: 'pvp' });
assert.match(captain.messages.at(-1).message, /cannot change during/);
clock += 101; choiceHub.tickAll();
assert.equal(selected.phase, 'playing'); assert.equal(selected.bots.length, 9);
assert.deepEqual(selected.players.map(player => player.livesLeft), [5, 5]);
const leader = captain.player, teammate = mate.player;
leader.x = 450; leader.y = 420; teammate.x = 500; teammate.y = 420;
leader.spawnShieldUntil = 0; teammate.spawnShieldUntil = 0;
choiceHub.damage(selected, teammate, 150, leader.id, 179, clock);
assert.equal(teammate.hp, 100, 'Co-op friendly fire must be rejected even in the damage method.');
selected.bots[0].x = 550; selected.bots[0].y = 420; selected.bots[0].hp = 20;
choiceHub.fire(selected, leader); choiceHub.updateBullets(selected, .095, clock, 179);
assert.equal(teammate.hp, 100, 'Teammates must not absorb player shots aimed at bots.');
assert.equal(selected.bots.length, 8, 'Player projectiles should eliminate server-owned co-op bots.');
assert.equal(leader.kills, 1);
assert.equal(selected.supplyDrops.length, 1, 'Bots should drop shared supplies.');
selected.bots.length = 0; // Keep the remainder of the timed-life checks deterministic.
selected.bullets = [{ x: teammate.x - 25, y: teammate.y, vx: 500, vy: 0, damage: 10,
  owner: 'bot:1', life: 1, r: 4, color: '#ff9ba9' }];
choiceHub.updateBullets(selected, .05, clock, 179);
assert.ok(teammate.shield < 30, 'Bot projectiles can hurt co-op players.');
teammate.weapon = 'SHOTGUN'; teammate.ammo = 2; teammate.loot = 3;
choiceHub.damage(selected, teammate, 999, null, 179, clock);
choiceHub.damage(selected, leader, 999, null, 179, clock);
assert.deepEqual(selected.players.map(player => player.status), ['respawning', 'respawning']);
assert.equal(selected.phase, 'playing', 'Both players down should not end the room.');
assert.deepEqual(selected.players.map(player => player.livesLeft), [4, 4]);
assert.equal(teammate.loot, 0); assert.equal(selected.supplyDrops.length, 4);
assert.ok(choiceHub.snapshot(selected, teammate).players.find(player => player.id === teammate.id).respawnIn > 2.9);
choiceHub.receiveInput(mate, { dx: 1, fire: true, interact: true }, clock);
assert.equal(teammate.input.dx, 0, 'Inputs sent while down must not move or fire.');
assert.equal(modeResults.length, 0, 'A down is not a final raid result.');
clock += 2900; choiceHub.tickAll();
assert.equal(teammate.status, 'respawning');
clock += 100; choiceHub.tickAll();
assert.equal(teammate.status, 'active'); assert.equal(leader.status, 'active');
assert.equal(teammate.hp, 100); assert.equal(teammate.shield, 30);
assert.equal(teammate.weapon, 'PEASHOOTER'); assert.equal(teammate.ammo, Infinity);
assert.ok(selected.world.obstacles.every(box => !circleRect(teammate.x, teammate.y, teammate.r, box)), 'Respawn must be walkable.');
choiceHub.damage(selected, teammate, 999, null, 175, clock);
assert.equal(teammate.status, 'active', 'Respawn grace period protects against spawn camping.');
for (const remaining of [3, 2, 1, 0]) {
  teammate.spawnShieldUntil = 0;
  choiceHub.damage(selected, teammate, 999, null, 175, clock);
  assert.equal(teammate.livesLeft, remaining);
  if (remaining) {
    assert.equal(teammate.status, 'respawning');
    assert.equal(modeResults.length, 0);
    clock += 3001; choiceHub.tickAll();
    assert.equal(teammate.status, 'active');
  } else {
    assert.equal(teammate.status, 'eliminated');
    await teammate.resultPromise;
    assert.equal(modeResults.filter(result => result.id === teammate.id).length, 1);
    assert.equal(mate.messages.filter(message => message.type === 'result').length, 1);
  }
}
assert.equal(selected.phase, 'playing', 'A teammate with lives remaining can still extract.');
leader.x = selected.world.extract.x; leader.y = selected.world.extract.y; leader.loot = 2;
for (let i = 0; i < 55 && leader.status === 'active'; i++) {
  clock += 33; choiceHub.receiveInput(captain, { dx: 0, dy: 0, interact: true }, clock); choiceHub.tickAll();
}
assert.equal(leader.status, 'escaped', 'Co-op still requires two supplies and a server-measured exit hold.');
await leader.resultPromise;
assert.equal(selected.phase, 'finished');
assert.equal(modeResults.filter(result => result.id === leader.id)[0].mode, 'coop');
assert.equal(modeResults.filter(result => result.id === leader.id)[0].won, true);
await choiceHub.handle(mate, { type: 'set_mode', mode: 'pvp' });
assert.equal(selected.mode, 'coop', 'Only the host may switch a rematch mode.');
await choiceHub.handle(captain, { type: 'set_mode', mode: 'pvp' });
assert.equal(selected.mode, 'pvp');
choiceHub.startCountdown(captain); clock += 101; choiceHub.tickAll();
assert.equal(selected.bots.length, 0); assert.deepEqual(selected.players.map(p => p.livesLeft), [5, 5]);
assert.deepEqual(selected.players.map(p => p.deaths), [0, 0]);
leader.spawnShieldUntil = 0; teammate.spawnShieldUntil = 0;
choiceHub.damage(selected, teammate, 40, leader.id, 179, clock);
assert.ok(teammate.hp < 100, 'PvP shots should hurt other players.');
choiceHub.damage(selected, teammate, 999, leader.id, 179, clock);
assert.equal(teammate.status, 'respawning'); assert.equal(leader.kills, 1);
selected.startedAt = clock - 179500; clock += 600; choiceHub.tickAll();
assert.equal(selected.phase, 'finished'); assert.equal(teammate.status, 'eliminated');
assert.equal(leader.status, 'eliminated');
await Promise.all([leader.resultPromise, teammate.resultPromise]);
assert.equal(modeResults.filter(result => result.id === teammate.id).length, 2);
clock += 3100; choiceHub.tickAll();
assert.equal(teammate.status, 'eliminated', 'The clock cannot revive a timed-out player.');
choiceHub.startCountdown(captain); clock += 101; choiceHub.tickAll();
teammate.spawnShieldUntil = 0;
choiceHub.damage(selected, teammate, 999, leader.id, 179, clock);
assert.equal(teammate.status, 'respawning');
mate.readyState = WebSocket.CLOSED; choiceHub.disconnect(mate);
assert.equal(teammate.status, 'eliminated', 'Disconnecting while down is a forfeit, not an idle respawn.');
await teammate.resultPromise;
assert.equal(modeResults.filter(result => result.id === teammate.id).length, 3);
const practice = fakeSocket();
await choiceHub.create(practice, { type: 'solo', arenaId: 'demo', name: 'SOLO' });
assert.equal(practice.player.livesLeft, 1);
practice.player.spawnShieldUntil = 0;
choiceHub.damage(practice.player.room, practice.player, 999, null, 179, clock);
assert.equal(practice.player.status, 'eliminated', 'Solo retains its single-life rule.');
choiceHub.close();

// Slow NFT lookups must not race past the maximum room count before the
// asynchronously resolved arena is inserted into the rooms map.
let releaseLookup;
const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
const limitedHub = new LiveRooms({ resolveArena: () => lookupGate });
const pendingSockets = Array.from({ length: 61 }, fakeSocket);
const pending = pendingSockets.slice(0, 60).map(socket => limitedHub.create(socket,
  { type: 'create', arenaId: 'demo', name: 'WAITING' }));
assert.equal(limitedHub.pendingCreates, 60);
await limitedHub.create(pendingSockets[60], { type: 'create', arenaId: 'demo', name: 'EXCESS' });
assert.match(pendingSockets[60].messages.at(-1).message, /All rooms are busy/);
releaseLookup(fakeArena());
await Promise.all(pending);
assert.equal(limitedHub.rooms.size, 60);
assert.equal(limitedHub.pendingCreates, 0);
limitedHub.close();

// A real Node server + two independent browser clients exercise the share link,
// waiting room, live round, remote movement and server-side forfeit record.
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-live-test-'));
const port = 4188, base = `http://127.0.0.1:${port}`, dataPath = path.join(temp, 'arenas.json');
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port),
    DATA_PATH: dataPath, REWARD_DATA_PATH: path.join(temp, 'preview.json'),
    CLAIM_STAGING_DB_PATH: path.join(temp, 'claim-staging.sqlite') }, stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Live test server did not start.')), 10000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('CHOGPIT ready')) { clearTimeout(timeout); resolve(); } });
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exited: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const host = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const guest = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const errors = [];
  for (const page of [host, guest]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ status: response.status(), contentType: 'application/javascript', body: `${await response.text()}\nwindow.__testGame = game; window.__testState = state;` });
    });
  }
  await host.goto(base, { waitUntil: 'domcontentloaded' });
  await host.locator('#liveEntry summary').click();
  await host.locator('#liveName').fill('ALICE');
  await host.locator('#createRoomButton').click();
  await host.waitForFunction(() => /^[A-HJ-NP-Z2-9]{6}$/.test(document.querySelector('#roomCode').textContent));
  const code = await host.locator('#roomCode').innerText();
  assert.equal(await host.locator('#roomStartButton').isDisabled(), true);
  assert.equal(await host.locator('#roomModeCoop').isDisabled(), true, 'Host waits for a friend before choosing.');
  await guest.goto(`${base}/?room=${code}`, { waitUntil: 'domcontentloaded' });
  assert.equal(await guest.locator('#joinCodeInput').inputValue(), code);
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Short-phone lobby must not scroll sideways.');
  await guest.locator('#liveName').fill('BOB');
  await guest.locator('#joinRoomButton').click();
  await host.waitForFunction(() => document.querySelectorAll('#roomPlayers .room-player:not(.empty)').length === 2);
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Short-phone room must fit horizontally.');
  await guest.setViewportSize({ width: 844, height: 390 });
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Landscape waiting room must fit horizontally.');
  await guest.setViewportSize({ width: 568, height: 320 });
  await guest.locator('#roomModeCoop').scrollIntoViewIfNeeded();
  const choiceBox = await guest.locator('#roomModeCoop').boundingBox();
  assert.ok(choiceBox.y >= 44 && choiceBox.y + choiceBox.height <= 320,
    'Mode choices remain scrollable inside a short-landscape phone room.');
  await guest.setViewportSize({ width: 390, height: 844 });
  assert.equal(await guest.locator('#roomStartButton').isVisible(), false, 'Only the host can start.');
  assert.equal(await guest.locator('#roomModeCoop').isDisabled(), true, 'Guests can see but not alter mode.');
  assert.match(await host.locator('#roomFineprint').innerText(), /5 lives total \(4 respawns\)/);
  await host.locator('#roomModeCoop').click();
  await guest.waitForFunction(() => document.querySelector('#roomModeCoop').getAttribute('aria-pressed') === 'true');
  assert.match(await guest.locator('#roomModeHint').innerText(), /HOST CHOSE CO-OP VS BOTS/);
  await host.locator('#roomModePvp').click();
  await guest.waitForFunction(() => document.querySelector('#roomModePvp').getAttribute('aria-pressed') === 'true');
  await guest.evaluate(() => window.__testState.live.ws.send(JSON.stringify({ type: 'set_mode', mode: 'coop' })));
  await guest.waitForFunction(() => document.querySelector('#toast').textContent.includes('Only the private-room host'));
  assert.equal(await guest.evaluate(() => window.__testState.live.mode), 'pvp');
  await host.locator('#roomStartButton').click();
  await host.waitForFunction(() => !document.querySelector('#gameHud').hidden && window.__testGame.mode === 'online', null, { timeout: 7000 });
  await guest.waitForFunction(() => !document.querySelector('#gameHud').hidden && window.__testGame.mode === 'online', null, { timeout: 7000 });
  await guest.locator('#rotateOverlay').waitFor({ state: 'visible' });
  assert.match(await guest.locator('#rotateMatchNote').innerText(), /LIVE ROOM CONTINUES/);
  assert.equal(await guest.evaluate(() => window.__testGame.orientationBlocked), true);
  assert.equal(await host.locator('#liveScoreboard').isVisible(), true);
  assert.match(await guest.locator('#matchLabel').innerText(), new RegExp(code));
  await host.evaluate(() => window.__testState.live.ws.send(JSON.stringify({ type: 'set_mode', mode: 'coop' })));
  await host.waitForFunction(() => document.querySelector('#toast').textContent.includes('mode cannot change'));
  assert.equal(await host.evaluate(() => window.__testState.live.mode), 'pvp');
  const startX = await host.evaluate(() => window.__testGame.player.x);
  await host.keyboard.down('d'); await host.waitForTimeout(540); await host.keyboard.up('d');
  await host.waitForFunction(x => window.__testGame.player.x > x + 45, startX);
  const serverSeen = await guest.evaluate(() => window.__testGame.onlinePlayers.find(player => player.name === 'ALICE')?.x);
  assert.ok(serverSeen > startX + 40, 'Other clients receive authoritative remote movement.');
  await host.evaluate(() => { window.__testGame.player.x = 2900; window.__testGame.loot = 99; window.__testState.live.ws.send(JSON.stringify({ type: 'result', won: true, loot: 99, score: 99999 })); });
  await host.waitForFunction(() => window.__testGame.player.x < 1800 && window.__testGame.loot < 99);
  assert.equal(await host.locator('#resultOverlay').isVisible(), false, 'Fake client result must not be accepted.');
  await host.keyboard.press('p');
  assert.equal(await host.locator('#roomOverlay').isVisible(), true);
  assert.match(await host.locator('#roomStatus').innerText(), /never pauses/);
  await host.locator('#roomResumeButton').click();
  assert.equal(await host.locator('#roomOverlay').isVisible(), false);
  // Portrait blocks the guest's controls but not room snapshots. Turning the
  // phone sideways restores real touch movement against the server-owned pit.
  await guest.setViewportSize({ width: 844, height: 390 });
  await guest.locator('#rotateOverlay').waitFor({ state: 'hidden' });
  const cdp = await guest.context().newCDPSession(guest);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 75, y: 255, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 75, y: 188, id: 1 }] });
  await guest.waitForFunction(() => window.__testGame.player.y < 1140, null, { timeout: 3500 });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.locator('#rotateOverlay').waitFor({ state: 'visible' });
  assert.equal(await guest.evaluate(() => window.__testGame.touch.move === null && !window.__testGame.buttonFiring), true);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await guest.setViewportSize({ width: 844, height: 390 });
  await guest.locator('#rotateOverlay').waitFor({ state: 'hidden' });
  // Raid using only keyboard controls; there is no client command to claim a
  // cache, damage a rival, teleport, extract or award cosmetics directly.
  const travel = async (key, axis, target, direction = 1, timeout = 10000) => {
    await host.keyboard.down(key);
    try { await host.waitForFunction(({ axis, target, direction }) => direction * (window.__testGame.player[axis] - target) >= 0,
      { axis, target, direction }, { timeout }); }
    finally { await host.keyboard.up(key); }
  };
  await host.keyboard.press('e');
  try { await host.waitForFunction(() => window.__testGame.loot === 1, null, { timeout: 2500 }); }
  catch (error) { console.error('First-cache state:', await host.evaluate(() => ({ x: window.__testGame.player.x, y: window.__testGame.player.y,
    loot: window.__testGame.loot, near: window.__testGame.nearbyAction(), status: window.__testGame.onlineSelfStatus,
    mode: window.__testState.mode, roomHidden: document.querySelector('#roomOverlay').hidden }))); throw error; }
  await travel('s', 'y', 1155); await travel('d', 'x', 1235);
  await host.keyboard.press('e');
  await host.waitForFunction(() => window.__testGame.loot === 2, null, { timeout: 2500 });
  await travel('s', 'y', 1390); await travel('d', 'x', 2300); await travel('s', 'y', 1470);
  await host.keyboard.down('e');
  try { await host.waitForFunction(() => !document.querySelector('#resultOverlay').hidden, null, { timeout: 5500 }); }
  finally { await host.keyboard.up('e'); }
  assert.equal(await host.locator('#resultTitle').innerText(), 'YOU GOT OUT.');
  assert.equal(await host.locator('#resultLiveStandings').isVisible(), true);
  assert.match(await host.locator('#resultKicker').innerText(), /1 FREE CRATE/);
  await host.locator('#resultButton').click();
  await host.waitForFunction(() => document.querySelector('#toast').textContent.includes('scar now marks'), null, { timeout: 5000 });
  assert.equal(await host.locator('#crateCount').innerText(), '1');
  await host.locator('#resultMenuButton').click();
  assert.equal(await host.locator('#roomOverlay').isVisible(), true);
  await guest.locator('#pauseButton').click();
  await guest.locator('#roomLeaveButton').click();
  await host.waitForFunction(() => document.querySelector('#roomTitle').textContent.includes('ALICE BANKED'), null, { timeout: 4000 });
  assert.equal(await host.locator('#roomStartButton').isEnabled(), false, 'A rematch needs another connected raider.');
  await host.locator('#roomLeaveButton').click();
  const saved = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(saved.demo.raids, 2, 'A banked escape and the rival forfeit should each be recorded once.');
  assert.equal(saved.demo.clears, 1);
  assert.equal(saved.demo.scars.at(-1).type, 'acid');
  assert.equal(saved.demo.lastRun.mode, 'live-pvp');
  // A fresh two-browser co-op room shows the host choice to both clients and
  // renders bot snapshots. Injecting an authoritative-shaped downed snapshot
  // exercises the three-second overlay without a nondeterministic bot kill.
  await host.locator('#liveName').fill('CO-CAPTAIN');
  await host.locator('#createRoomButton').click();
  await host.waitForFunction(oldCode => document.querySelector('#roomCode').textContent !== oldCode
    && /^[A-HJ-NP-Z2-9]{6}$/.test(document.querySelector('#roomCode').textContent), code);
  const coopCode = await host.locator('#roomCode').innerText();
  await guest.locator('#joinCodeInput').fill(coopCode);
  await guest.locator('#liveName').fill('CO-MATE');
  await guest.locator('#joinRoomButton').click();
  await host.waitForFunction(() => document.querySelectorAll('#roomPlayers .room-player:not(.empty)').length === 2);
  await host.locator('#roomModeCoop').click();
  await guest.waitForFunction(() => document.querySelector('#roomModeCoop').getAttribute('aria-pressed') === 'true');
  await host.locator('#roomStartButton').click();
  await host.waitForFunction(() => window.__testState.live?.mode === 'coop'
    && window.__testGame.onlinePlayers.filter(player => player.id.startsWith('bot:')).length === 9, null, { timeout: 7000 });
  await guest.waitForFunction(() => window.__testState.live?.mode === 'coop'
    && window.__testGame.onlinePlayers.filter(player => player.id.startsWith('bot:')).length === 9, null, { timeout: 7000 });
  assert.match(await host.locator('#matchLabel').innerText(), /CO-OP VS BOTS/);
  await host.waitForFunction(() => document.querySelector('#hudRisk').textContent.includes('5/5 LIVES'));
  assert.match(await host.locator('#hudRisk').innerText(), /5\/5 LIVES/);
  const autoAim = await host.evaluate(() => {
    const game = window.__testGame, oldPlayers = game.onlinePlayers, oldPosition = { x: game.player.x, y: game.player.y };
    game.player.x = 450; game.player.y = 420;
    game.onlinePlayers = [
      { id: 'human-friend', x: 450, y: 490, status: 'active' },
      { id: 'bot:preview', x: 600, y: 420, status: 'active' }
    ];
    game.touch.aim = null; game.player.angle = 1;
    game.autoAimAtRival();
    const aimedAt = game.player.angle;
    game.onlinePlayers = oldPlayers; Object.assign(game.player, oldPosition);
    return aimedAt;
  });
  assert.ok(Math.abs(autoAim) < .1, 'Co-op FIRE assist must aim at bots, not the nearer teammate.');
  await host.evaluate(() => {
    const live = window.__testState.live, handler = live.ws.onmessage;
    window.__realRoomMessage = handler;
    live.ws.onmessage = event => { if (JSON.parse(event.data).type !== 'snapshot') handler(event); };
    const snapshot = live.lastSnapshot;
    handler({ data: JSON.stringify({ ...snapshot,
      players: snapshot.players.map(player => player.id === live.you
        ? { ...player, status: 'respawning', hp: 0, shield: 0, livesLeft: 4, respawnIn: 2.5 } : player),
      standings: snapshot.standings.map(player => player.id === live.you
        ? { ...player, status: 'respawning', livesLeft: 4, respawnIn: 2.5 } : player)
    }) });
  });
  assert.equal(await host.locator('#respawnOverlay').isVisible(), true);
  assert.match(await host.locator('#respawnLives').innerText(), /4 OF 5 LIVES LEFT/);
  await host.locator('#respawnRoomButton').click();
  assert.equal(await host.locator('#roomOverlay').isVisible(), true);
  assert.equal(await host.locator('#roomResumeButton').isVisible(), true, 'Downed players can return to the pit.');
  await host.locator('#roomResumeButton').click();
  assert.equal(await host.locator('#respawnOverlay').isVisible(), true);
  await host.evaluate(() => { window.__testState.live.ws.onmessage = window.__realRoomMessage; delete window.__realRoomMessage; });
  await host.locator('#respawnOverlay').waitFor({ state: 'hidden', timeout: 4000 });
  assert.equal(await host.evaluate(() => window.__testGame.onlineSelfStatus), 'active');
  assert.deepEqual(errors, [], 'Both browser clients should have zero page errors.');
  await host.close(); await guest.close();
  console.log('PASS: host-selected PvP/co-op, five lives and timed returns, bot combat, extraction, scars, rematches, two browsers and forfeit records');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
}
