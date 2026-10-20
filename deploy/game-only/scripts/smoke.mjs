import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4173');
if (!['https:', 'http:'].includes(base.protocol) || base.pathname !== '/') {
  throw new Error('Pass a game origin, for example: npm run smoke -- https://your-real-host');
}
const socketUrl = new URL('/ws', base);
socketUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
const get = async route => {
  const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(12000) });
  return { status: response.status, body: await response.json() };
};

const health = await get('/healthz');
assert.equal(health.status, 200);
assert.deepEqual({ mode: health.body.mode, payouts: health.body.rewardPayoutsEnabled },
  { mode: 'GAME_ONLY', payouts: false });
const status = await get('/api/status');
assert.equal(status.body.gameOnly, true);
assert.equal(status.body.rewardPayoutsEnabled, false);
for (const route of ['/api/campaign/status', '/api/claims/status']) {
  const result = await get(route);
  assert.equal(result.status, 200);
  assert.equal(result.body.ready, false);
  assert.equal(result.body.claimsEnabled, false);
}
const pass = await get('/api/pass/status');
assert.equal(pass.status, 200);
assert.equal(pass.body.nftContract, null);
assert.equal(pass.body.realClaimEnabled, false);
assert.equal(pass.body.samplePassLocalOnly, true);
assert.equal((await get('/api/pass/claim')).status, 423);
const preview = await get('/api/rewards/status');
assert.equal(preview.body.walletPointsEnabled, false);
assert.equal(preview.body.payoutsEnabled, false);
assert.equal((await get('/api/rewards/me')).status, 423);
assert.equal((await get('/api/campaign/register/options')).status, 423);
assert.equal((await get('/api/claims/proof')).status, 423);
assert.equal((await get('/api/arena/demo')).status, 200);
const page = await fetch(base, { signal: AbortSignal.timeout(12000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /CHOGPIT/);

function connect(origin = base.origin) {
  const ws = new WebSocket(socketUrl, { origin, handshakeTimeout: 12000 });
  const backlog = [], listeners = [];
  ws.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    const index = listeners.findIndex(item => item.predicate(message));
    if (index < 0) return backlog.push(message);
    const [listener] = listeners.splice(index, 1);
    clearTimeout(listener.timer); listener.resolve(message);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_, response) => {
      response.resume(); reject(new Error(`WebSocket rejected: ${response.statusCode}`));
    });
  });
  const wait = (predicate, ms = 10000) => {
    const index = backlog.findIndex(predicate);
    if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const listener = { predicate, resolve, timer: null };
      listener.timer = setTimeout(() => {
        const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1);
        reject(new Error('Timed out waiting for a WebSocket room message.'));
      }, ms);
      listeners.push(listener);
    });
  };
  return { ws, opened, wait };
}
const liveSockets = [];
try {
  for (const mode of ['pvp', 'coop']) {
    const host = connect(); liveSockets.push(host); await host.opened;
    await host.wait(message => message.type === 'hello');
    host.ws.send(JSON.stringify({ type: 'create', arenaId: 'demo', name: 'SMOKE HOST' }));
    const room = await host.wait(message => message.type === 'room' && /^[A-HJ-NP-Z2-9]{6}$/.test(message.code));
    assert.equal(room.rewardMode, 'preview'); assert.equal(room.mode, 'pvp');
    const guest = connect(); liveSockets.push(guest); await guest.opened;
    await guest.wait(message => message.type === 'hello');
    guest.ws.send(JSON.stringify({ type: 'join', code: room.code, name: 'SMOKE GUEST' }));
    const joined = await guest.wait(message => message.type === 'room' && message.code === room.code);
    assert.equal(joined.standings.length, 2);
    if (mode === 'coop') {
      host.ws.send(JSON.stringify({ type: 'set_mode', mode: 'coop' }));
      assert.equal((await guest.wait(message => message.type === 'room' && message.mode === 'coop')).livesPerPlayer, 5);
    }
    host.ws.send(JSON.stringify({ type: 'start' }));
    await host.wait(message => message.type === 'start', 9000);
    await guest.wait(message => message.type === 'start', 9000);
    const snapshot = await guest.wait(message => message.type === 'snapshot' && message.players.length >= 2, 9000);
    assert.ok(snapshot.timeLeft > 0 && snapshot.timeLeft <= 180);
    assert.equal(snapshot.players.filter(player => player.id.startsWith('bot:')).length, mode === 'coop' ? 9 : 0);
    assert.equal(snapshot.players.find(player => player.id === joined.you).livesLeft, 5);
    host.ws.close(); guest.ws.close();
  }
  console.log('PASS: game-only HTTP, locked CHOG endpoints and two-client private WebSocket round (PvP + co-op, five lives) at', base.origin);
} finally {
  for (const { ws } of liveSockets) { ws.close(); ws.terminate(); }
}
