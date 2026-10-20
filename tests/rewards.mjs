import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { LiveRooms } from '../live-rooms.mjs';
import { ClaimLedger } from '../claim-ledger.mjs';
import { PREVIEW_POOL, previewPrize, RewardPreview, RewardSessions } from '../reward-preview.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-preview-test-'));
const demoWallet = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
const account = demoWallet.address;
const event = (round, box = 0, instance = 'a'.repeat(32)) => `${instance}:${round}:${box}`;
let clock = Date.UTC(2026, 9, 17, 12);
let browser, server, staging;
try {
  assert.deepEqual([0, 69, 70, 94, 95, 99].map(previewPrize), [5, 5, 10, 10, 25, 25]);
  assert.throws(() => previewPrize(100), /Invalid prize roll/);
  const file = path.join(temp, 'preview.json');
  const rolls = [0, 70, 95, 0, 70, 95];
  const ledger = await RewardPreview.load(file, { draw: () => rolls.shift() ?? 0, now: () => clock });
  const concurrent = await Promise.all([1, 2, 3].map(round => ledger.credit({ account, eventId: event(round), mode: 'solo', arenaId: 'demo' })));
  assert.deepEqual(concurrent.map(item => item.amount), [5, 10, 25]);
  assert.equal(ledger.balance(account).previewBalance, 40);
  assert.equal((await ledger.credit({ account, eventId: event(3), mode: 'solo', arenaId: 'demo' })).status, 'duplicate');
  assert.equal((await ledger.credit({ account: privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`).address,
    eventId: event(3), mode: 'pvp', arenaId: 'demo' })).status, 'event-used');
  assert.equal((await ledger.credit({ account, eventId: event(4), mode: 'pvp', arenaId: 'demo' })).amount, 5);
  assert.equal((await ledger.credit({ account, eventId: event(5), mode: 'pvp', arenaId: 'demo' })).amount, 10);
  assert.equal(ledger.balance(account).previewBalance, 55);
  assert.equal('thresholdExample' in ledger.balance(account), false);
  assert.equal('reachedExampleThreshold' in ledger.balance(account), false);
  assert.equal(ledger.balance(account).withdrawable, false, 'Preview balances never enable withdrawals.');
  assert.equal((await ledger.credit({ account, eventId: event(6), mode: 'pvp', arenaId: 'demo' })).status, 'daily-limit');
  assert.equal(ledger.status().simulatedSpent, 55);
  assert.equal((await RewardPreview.load(file)).balance(account).previewBalance, 55, 'Preview points survive a server restart.');
  clock += 24 * 60 * 60_000;
  assert.equal((await ledger.credit({ account, eventId: event(7), mode: 'solo', arenaId: 'demo' })).amount, 25);
  const poolFile = path.join(temp, 'pool.json');
  const pool = await RewardPreview.load(poolFile, { draw: () => 99, now: () => clock });
  for (let i = 0; i < 40; i++) {
    const address = `0x${(i % 8 + 1).toString(16).padStart(40, '0')}`;
    const result = await pool.credit({ account: address, eventId: event(i + 1, 0, 'b'.repeat(32)), mode: 'solo', arenaId: 'demo' });
    assert.equal(result.amount, 25);
  }
  assert.equal(pool.status().simulatedSpent, PREVIEW_POOL);
  assert.equal((await pool.credit({ account, eventId: event(99), mode: 'pvp', arenaId: 'demo' })).status, 'pool-empty');
  assert.equal(pool.balance(account).withdrawable, false);
  await writeFile(path.join(temp, 'corrupt.json'), '{invalid');
  await assert.rejects(() => RewardPreview.load(path.join(temp, 'corrupt.json')), /JSON/);

  const sessions = new RewardSessions({ now: () => clock });
  const challenge = sessions.challenge(account, 'localhost:4173');
  const signature = await demoWallet.signMessage({ message: challenge.message });
  const auth = await sessions.create({ account, nonce: challenge.nonce, signature });
  assert.equal(sessions.resolve(auth.session), account.toLowerCase());
  await assert.rejects(() => sessions.create({ account, nonce: challenge.nonce, signature }), /expired or mismatched/);
  clock += 60 * 60_000 + 1;
  assert.equal(sessions.resolve(auth.session), null);
  assert.throws(() => sessions.challenge(account, 'evil\nsite'), /Invalid request host/);

  const fakeSocket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, messages: [], inputWindowAt: 0, inputCount: 0,
    send(payload) { this.messages.push(JSON.parse(payload)); }, close() {} });
  clock = 1_000_000;
  const playFile = path.join(temp, 'play.json');
  const playLedger = await RewardPreview.load(playFile, { draw: () => 0, now: () => Date.UTC(2026, 9, 17) });
  staging = new ClaimLedger(path.join(temp, 'observations.sqlite'), { now: () => clock });
  const hub = new LiveRooms({ resolveArena: async () => ({ id: 'demo', genome: 'demo-training', traps: [], scars: [] }),
    resolveSession: token => token === 'signed-test-session' ? account : null,
    onVerifiedOpening: (room, identity, box) => staging.recordObservation({
      runId: room.instanceId, round: room.roundNumber, boxId: box.id,
      wallet: identity.rewardSession === 'signed-test-session' ? account : null,
      mode: room.mode, arenaId: room.arena.id
    }),
    onReward: (room, identity, box) => identity.rewardSession === 'signed-test-session'
      ? playLedger.credit({ account, eventId: event(room.roundNumber, box.id, room.instanceId), mode: room.mode, arenaId: 'demo' })
      : playLedger.sampleOnly(), now: () => clock, countdownMs: 100 });
  const soloWs = fakeSocket();
  await hub.create(soloWs, { type: 'solo', arenaId: 'demo', name: 'SOLO TEST', session: 'signed-test-session' });
  const solo = soloWs.player.room, hero = soloWs.player;
  assert.equal(solo.phase, 'playing'); assert.equal(solo.mode, 'solo');
  assert.equal(solo.bots.length, 9); assert.equal(solo.rewardBoxes.length, 4);
  assert.equal(soloWs.messages.find(msg => msg.type === 'room')?.mode, 'solo');
  assert.equal(hub.snapshot(solo, hero).rewardBoxes.length, 0, 'Boxes are absent from snapshots until approached.');
  assert.equal(hub.snapshot(solo).rewardBoxes.length, 0, 'A public broadcast must not expose the secret sites.');
  hub.receiveInput(soloWs, { type: 'input', x: solo.rewardBoxes[0].x, y: solo.rewardBoxes[0].y,
    reward: 999, won: true, loot: 100 }, clock);
  clock += 33; hub.tickAll();
  assert.ok(Math.hypot(hero.x - solo.world.spawn.x, hero.y - solo.world.spawn.y) < 20, 'Fake coordinates never move the avatar.');
  const box = solo.rewardBoxes[0]; hero.x = box.x; hero.y = box.y;
  assert.ok(hub.snapshot(solo, hero).rewardBoxes.some(item => item.id === box.id));
  hub.receiveInput(soloWs, { interact: true }, clock); clock += 33; hub.tickAll();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(box.opened, true);
  assert.equal(staging.observationCount(), 1, 'Server-checked solo opening was durably journaled.');
  assert.equal(staging.claimEventCount(), 0, 'A preview opening must never become a claim event.');
  assert.equal(staging.recordObservation({ runId: solo.instanceId, round: solo.roundNumber,
    boxId: box.id, wallet: account, mode: 'solo', arenaId: 'demo' }).duplicate, true);
  assert.throws(() => staging.recordObservation({ runId: solo.instanceId, round: solo.roundNumber,
    boxId: box.id, wallet: null, mode: 'solo', arenaId: 'demo' }), /Conflicting duplicate/);
  assert.equal(playLedger.balance(account).previewBalance, 5);
  assert.equal(soloWs.messages.filter(msg => msg.type === 'preview_reward').length, 1);
  clock += 33; hub.tickAll();
  assert.equal(soloWs.messages.filter(msg => msg.type === 'preview_reward').length, 1, 'Opened boxes cannot be replayed.');
  assert.ok(!hub.snapshot(solo, hero).rewardBoxes.some(item => item.id === box.id));
  // Client-provided results and payout requests are never supported actions.
  await hub.handle(soloWs, { type: 'withdraw', amount: 1000 });
  assert.equal(playLedger.balance(account).previewBalance, 5);
  const firstBot = solo.bots[0];
  solo.bullets = [{ x: firstBot.x, y: firstBot.y, vx: 0, vy: 0, life: 1, r: 4, damage: 100,
    owner: hero.id, color: '#fff' }];
  hub.updateBullets(solo, .01, clock, 150);
  assert.equal(solo.bots.length, 8, 'A hit against server-owned bots is resolved on the server.');
  assert.equal(hero.kills, 1); assert.ok(solo.supplyDrops.length >= 1);
  hero.x = solo.world.extract.x; hero.y = solo.world.extract.y; hero.loot = 2; hero.input.interact = true;
  for (let i = 0; i < 65 && solo.phase === 'playing'; i++) {
    hub.receiveInput(soloWs, { interact: true }, clock);
    clock += 33; hub.tickAll();
  }
  assert.equal(hero.status, 'escaped');
  assert.equal(solo.phase, 'finished');
  hub.startCountdown(soloWs); clock += 101; hub.tickAll();
  assert.equal(solo.phase, 'playing'); assert.equal(solo.roundNumber, 2);
  assert.equal(hero.rewardBoxesOpened, 0, 'Rematch resets hidden-box counts.');
  const a = fakeSocket(), b = fakeSocket();
  await hub.create(a, { type: 'create', arenaId: 'demo', name: 'ONE', session: 'signed-test-session' });
  hub.join(b, { code: a.player.room.code, name: 'TWO' });
  hub.startCountdown(a); clock += 101; hub.tickAll();
  const pvp = a.player.room, shared = pvp.rewardBoxes[0];
  assert.equal(pvp.mode, 'pvp'); assert.equal(pvp.bots.length, 0);
  assert.equal(hub.snapshot(pvp, b.player).rewardBoxes.length, 0);
  a.player.x = shared.x; a.player.y = shared.y; hub.receiveInput(a, { interact: true }, clock);
  clock += 33; hub.tickAll(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(shared.opened, true); assert.equal(playLedger.balance(account).previewBalance, 10);
  assert.equal(staging.observationCount(), 2, 'PvP opening is independently journaled.');
  b.player.x = shared.x; b.player.y = shared.y; hub.receiveInput(b, { interact: true }, clock);
  clock += 33; hub.tickAll();
  assert.equal(b.messages.filter(msg => msg.type === 'preview_reward').length, 0, 'A shared box only opens once.');
  assert.equal(staging.observationCount(), 2);
  staging.close();
  staging = new ClaimLedger(path.join(temp, 'observations.sqlite'));
  assert.equal(staging.observationCount(), 2, 'Checked openings survive journal close/restart.');
  assert.equal(staging.claimEventCount(), 0);
  staging.db.exec(`CREATE TRIGGER refuse_box_audit BEFORE INSERT ON audit_log
    WHEN NEW.kind='PREVIEW_OBSERVATION' BEGIN SELECT RAISE(ABORT, 'journal write unavailable'); END`);
  const blocked = new LiveRooms({ resolveArena: async () => ({ id: 'demo', traps: [], scars: [] }),
    onVerifiedOpening: (room, identity, box) => staging.recordObservation({
      runId: room.instanceId, round: room.roundNumber, boxId: box.id,
      wallet: null, mode: room.mode, arenaId: room.arena.id
    }),
    onReward: () => { throw new Error('No preview reward should be reached.'); }, now: () => clock });
  const denied = fakeSocket();
  await blocked.create(denied, { type: 'solo', arenaId: 'demo', name: 'BLOCKED' });
  const deniedBox = denied.player.room.rewardBoxes[0];
  denied.player.x = deniedBox.x; denied.player.y = deniedBox.y;
  blocked.receiveInput(denied, { interact: true }, clock); clock += 33; blocked.tickAll();
  assert.equal(deniedBox.opened, false, 'Journal write failure cannot open a hidden box.');
  assert.equal(denied.player.rewardBoxesOpened, 0);
  assert.equal(staging.observationCount(), 2, 'Failed audit insert cannot leave a partial observation.');
  assert.ok(denied.messages.some(msg => msg.type === 'error' && /server could not record/.test(msg.message)));
  blocked.close();
  staging.db.exec('DROP TRIGGER refuse_box_audit');
  hub.close();

  // A misunderstood environment flag must fail closed instead of activating money.
  const refused = spawnSync(process.execPath, ['server.mjs'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, REWARD_PAYOUTS: 'enabled', REWARD_DATA_PATH: path.join(temp, 'refused.json') } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Real CHOG payouts are not implemented or reviewed/);
  // Public API: no token payout endpoints, wallet signature mandatory for private balance.
  const port = 4193, base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), DATA_PATH: path.join(temp, 'arenas.json'),
      REWARD_DATA_PATH: path.join(temp, 'api-preview.json'),
      CLAIM_STAGING_DB_PATH: path.join(temp, 'api-staging.sqlite'), REWARD_PAYOUTS: 'disabled' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Preview test server did not start.')), 10000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('CHOGPIT ready')) { clearTimeout(timeout); resolve(); } });
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exited: ${code}`)); });
  });
  const status = await (await fetch(`${base}/api/rewards/status`)).json();
  assert.equal(status.payoutsEnabled, false); assert.equal(status.funded, false);
  const claims = await (await fetch(`${base}/api/claims/status`)).json();
  assert.equal(claims.ready, false); assert.equal(claims.vault, null);
  assert.equal((await fetch(`${base}/api/claims/proofs?account=${account}`)).status, 423);
  assert.equal((await fetch(`${base}/api/rewards/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/rewards/withdraw`, { method: 'POST' })).status, 423);
  const apiChallenge = await (await fetch(`${base}/api/rewards/challenge?address=${account}`)).json();
  const apiSig = await demoWallet.signMessage({ message: apiChallenge.message });
  const apiAuth = await (await fetch(`${base}/api/rewards/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, nonce: apiChallenge.nonce, signature: apiSig }) })).json();
  assert.equal(apiAuth.previewOnly, true);
  const mine = await (await fetch(`${base}/api/rewards/me`, { headers: { authorization: `Bearer ${apiAuth.session}` } })).json();
  assert.equal(mine.previewBalance, 0); assert.equal(mine.withdrawable, false);
  assert.equal((await fetch(`${base}/api/rewards/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, nonce: apiChallenge.nonce, signature: apiSig }) })).status, 401);
  // Browser paths: the new solo option runs through the same authoritative room
  // transport, while local solo practice and private PvP remain distinct.
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pageErrors = [];
  for (const page of [desktop, phone]) {
    page.on('pageerror', error => pageErrors.push(error.message));
    if (page === desktop) {
      await page.exposeFunction('__signPreviewTest', message => demoWallet.signMessage({ message }));
      await page.addInitScript(address => {
        window.ethereum = { on() {}, request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') return [address];
          if (method === 'eth_chainId') return '0x8f';
          if (method === 'personal_sign') return window.__signPreviewTest(params[0]);
          throw Error(`Unexpected wallet method ${method}`);
        } };
      }, account);
    }
    await page.route('**/app.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ status: response.status(), contentType: 'application/javascript',
        body: `${await response.text()}\nwindow.__testGame = game; window.__testState = state;` });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#rewardGuide').isVisible(), true);
    assert.equal(await page.locator('#claimGuide').isVisible(), true);
    if (page === desktop) {
      await page.locator('#claimGuide summary').click();
      await page.locator('#refreshClaimStatus').click();
      await page.waitForFunction(() => document.querySelector('#claimExplanation').textContent.includes('No reviewed, funded claim vault'));
      assert.equal(await page.locator('#claimBadge').innerText(), 'NOT LIVE');
      await page.locator('#rewardGuide summary').click();
      assert.equal(await page.locator('#linkPreviewWallet').count(), 0,
        'No payout wallet connection should be offered in the playtest.');
      assert.equal(await page.locator('.claim-portal-link').getAttribute('href'), '/claim.html');
      assert.match(await page.locator('#previewBalance').innerText(), /PREVIEW$/);
      assert.doesNotMatch(await page.locator('#previewBalance').innerText(), /\/\s*50/);
    }
    await page.locator('#soloBountyButton').click();
    await page.waitForFunction(() => window.__testGame.mode === 'online' && window.__testState.live?.mode === 'solo', null, { timeout: 8000 });
    await page.waitForFunction(() => window.__testGame.onlinePlayers.length >= 10, null, { timeout: 5000 });
    assert.match(await page.locator('#matchLabel').innerText(), /SERVER SOLO/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (page === phone) {
      await page.locator('#rotateOverlay').waitFor({ state: 'visible' });
      assert.match(await page.locator('#rotateMatchNote').innerText(), /LIVE ROOM CONTINUES/);
      await page.locator('#rotateMenuButton').tap();
    } else await page.keyboard.press('p');
    assert.equal(await page.locator('#roomOverlay').isVisible(), true);
    await page.locator('#roomLeaveButton').click();
  }
  assert.deepEqual(pageErrors, []);
  assert.equal((await (await fetch(`${base}/api/rewards/status`)).json()).simulatedSpent, 0,
    'Browsing alone never awards points.');
  console.log('PASS: solo server bots + private PvP hidden boxes, wallet signatures, 70/25/5 draws, capped persistent test ledger, replay guards, disabled payouts, desktop/mobile UI');
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
  if (staging?.db.open) staging.close();
  await rm(temp, { recursive: true, force: true });
}
