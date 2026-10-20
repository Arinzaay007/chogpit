import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { payoutForRun } from '../public/game.js';
import { runMobilePlaytest } from './mobile.mjs';

assert.deepEqual(payoutForRun({ won: false, loot: 6, kills: 3, timeLeft: 100 }), { key: 'lost', name: 'HAUL LOST', crates: 0, score: 0 });
assert.deepEqual(payoutForRun({ won: true, loot: 2, kills: 0, timeLeft: 170 }), { key: 'safe', name: 'SAFE EXIT', crates: 1, score: 470 });
assert.equal(payoutForRun({ won: true, loot: 4, kills: 0, timeLeft: 150 }).crates, 2);
assert.equal(payoutForRun({ won: true, loot: 2, kills: 2, timeLeft: 170 }).crates, 2);
assert.equal(payoutForRun({ won: true, loot: 6, kills: 1, timeLeft: 120 }).crates, 2);
assert.deepEqual(payoutForRun({ won: true, loot: 6, kills: 2, timeLeft: 100 }), { key: 'legend', name: 'PIT LEGEND', crates: 3, score: 1200 });

const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-test-'));
const port = 4179;
const base = `http://127.0.0.1:${port}`;
const dataPath = path.join(temp, 'arenas.json');
// The previous prototype's small-grid save should migrate cleanly.
await writeFile(dataPath, JSON.stringify({ demo: { id: 'demo', traps: [{ type: 'turret', x: 740, y: 140 }], raids: 1, scars: [{ type: 'acid', x: 450, y: 265 }] } }));
const server = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DATA_PATH: dataPath }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start.')), 10000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('CHOGPIT ready')) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited early: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  assert.match(await page.title(), /CHOGPIT/);
  assert.equal(await page.locator('#lobbyOverlay').isVisible(), true);
  assert.match(await page.locator('.controls-strip').innerText(), /LEFT CLICK\s+SHOOT/);
  assert.equal(await page.locator('#shootButton').count(), 1);
  assert.doesNotMatch(await readFile(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8'), /YOU GOT REKT/);

  const arena = await (await fetch(`${base}/api/arena/demo`)).json();
  assert.equal(arena.layoutVersion, 2);
  assert.equal(arena.traps.length, 3);
  assert.equal(arena.scars.length, 0);
  assert.equal(arena.raids, 1);
  const walls = await page.evaluate(async () => {
    const { PitGame } = await import('/game.js');
    const game = new PitGame(document.createElement('canvas'));
    const segments = game.obstacles.filter(o => o.type === 'wall');
    const wall = segments.find(o => o.x === 690 && o.y === 1040);
    const fighter = { x: 800, y: wall.y - 20, r: 19 };
    game.moveActor(fighter, 0, 48);
    game.bullets = [{ x: 800, y: wall.y - 28, vx: 0, vy: 920, damage: 23, owner: 'player', life: 1, r: 4, color: '#fff' }];
    game.updateBullets(.05);
    const blockedBullet = game.bullets.length === 0;
    const bot = { id: 'probe', x: 1600, y: 1350, r: 18, hp: 74, maxHp: 74, speed: 100, shotCd: 100, roamCd: 5, roamX: 0, roamY: 1, hurt: 0, angle: 0 };
    game.bots = [{ ...bot }]; game.loot = 2; game.updateBots(.1);
    const quiet = { x: game.bots[0].x, y: game.bots[0].y };
    game.bots = [{ ...bot }]; game.loot = 4; game.updateBots(.1);
    const hunted = { x: game.bots[0].x, y: game.bots[0].y };
    game.bots = []; game.loot = 2;
    game.openCache({ id: 0, x: 1070, y: 855, opened: false });
    const hunterSpawned = game.bots.some(b => b.hunter);
    game.bots = []; game.traps = []; game.scars = []; game.respawnTimers = [];
    game.loot = 4; game.timeLeft = 100;
    game.player.x = game.extract.x; game.player.y = game.extract.y;
    game.keys.add('e'); game.mode = 'play';
    game.update(1.5);
    const longerHold = game.mode === 'play';
    game.update(.71);
    return { count: segments.length, blockedMovement: fighter.y < wall.y - 18, blockedBullet,
      heatPullsRivals: quiet.y > 1350 && hunted.x < 1600, hunterSpawned,
      longerHold: longerHold && game.mode === 'result' };
  });
  assert.ok(walls.count >= 12, 'Large map should have real cover walls.');
  assert.ok(walls.blockedMovement && walls.blockedBullet, 'Walls block movement and gunfire.');
  assert.ok(walls.heatPullsRivals && walls.hunterSpawned, 'Extra loot raises enemy pressure and calls in a hunter.');
  assert.ok(walls.longerHold, 'A four-supply escape takes longer than the minimum-loot exit.');

  await runMobilePlaytest(browser, base);

  await page.locator('#buildButton').click();
  assert.equal(await page.locator('#builderPanel').isVisible(), true);
  await page.locator('#gameCanvas').click({ position: { x: 300, y: 350 } });
  assert.match(await page.locator('#trapCount').innerText(), /4 \/ 8/);
  await page.locator('#saveArenaButton').click();
  await page.waitForFunction(() => document.querySelector('#builderNote').textContent.includes('Saved'), null, { timeout: 5000 });
  const saved = await (await fetch(`${base}/api/arena/demo`)).json();
  assert.equal(saved.traps.length, 4);
  const unauthorized = await fetch(`${base}/api/arena/1103/traps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ traps: [] }) });
  assert.equal(unauthorized.status, 401, 'Real NFT edits require an owner signature.');

  const move = async (keys, ms) => { for (const key of keys) await page.keyboard.down(key); await page.waitForTimeout(ms); for (const key of keys) await page.keyboard.up(key); };
  await page.locator('#closeBuilder').click();
  await page.locator('#playButton').click();
  assert.equal(await page.locator('#shootButton').isVisible(), true);
  await move(['d'], 460); await move(['s'], 330);
  await page.waitForFunction(() => document.querySelector('#hudWeapon').textContent === 'SMG', null, { timeout: 1500 });
  const fire = await page.locator('#shootButton').boundingBox();
  await page.mouse.move(fire.x + fire.width / 2, fire.y + fire.height / 2);
  await page.mouse.down(); await page.waitForTimeout(400);
  assert.match(await page.locator('#shootButton').getAttribute('class'), /active/);
  const ammoAfterButton = Number((await page.locator('#hudAmmo').innerText()).split(' ')[0]);
  assert.ok(ammoAfterButton < 42, 'Holding FIRE consumes ammo and creates real shots.');
  await page.mouse.up();
  assert.doesNotMatch(await page.locator('#shootButton').getAttribute('class'), /active/);
  await move(['f'], 300);
  const ammoAfterKeyboard = Number((await page.locator('#hudAmmo').innerText()).split(' ')[0]);
  assert.ok(ammoAfterKeyboard < ammoAfterButton, 'F is an alternative fire key.');

  // Two supplies, not one, unlock the exit. Extract through the open west side.
  await page.locator('#homeButton').click(); await page.locator('#playButton').click();
  await move(['d'], 660); await page.keyboard.press('e');
  await page.waitForFunction(() => document.querySelector('#hudLoot').textContent === '1', null, { timeout: 1800 });
  await move(['s'], 680); await move(['d', 's', ' '], 2100); await move(['d'], 3000); await move(['w'], 230);
  await page.waitForFunction(() => document.querySelector('#interactText').textContent.includes('OPEN'), null, { timeout: 1500 });
  await page.keyboard.press('e');
  await page.waitForFunction(() => document.querySelector('#hudLoot').textContent === '2', null, { timeout: 1800 });
  assert.match(await page.locator('#hudRisk').innerText(), /SAFE EXIT · 1 CRATE · HEAT 0/);
  await move(['d'], 510);
  await page.keyboard.down('e'); await page.waitForTimeout(1750); await page.keyboard.up('e');
  assert.equal(await page.locator('#resultOverlay').isVisible(), true, 'The new walls must leave a navigable extraction route.');
  assert.equal(await page.locator('#resultTitle').innerText(), 'YOU GOT OUT.');
  assert.match(await page.locator('#resultKicker').innerText(), /SAFE EXIT \/ 1 FREE CRATE/);
  const score = Number((await page.locator('#resultScore').innerText()).replace(/,/g, ''));
  assert.ok(score >= 300 && score <= 480);
  await page.locator('[data-mark="spores"]').click(); await page.locator('#resultButton').click();
  await page.waitForFunction(() => document.querySelector('#resultButton').textContent.includes('DROP BACK IN'), null, { timeout: 5000 });
  assert.equal(await page.locator('#crateCount').innerText(), '1');
  assert.equal(Number((await page.locator('#lobbyRep').innerText()).replace(/,/g, '')), score);
  assert.equal(Number((await page.locator('#lockerBest').innerText()).replace(/,/g, '')), score);
  const raided = await (await fetch(`${base}/api/arena/demo`)).json();
  assert.equal(raided.scars.at(-1).type, 'spores');
  assert.equal(raided.lastRun.tier, 'safe');
  assert.equal(raided.lastRun.score, score);
  await page.locator('#lockerButton').click(); await page.locator('#openCrateButton').click();
  assert.equal(await page.locator('#crateModal').isVisible(), true);
  assert.equal(await page.locator('#crateCount').innerText(), '0');
  assert.deepEqual(errors, []);

  // Synthetic boundary check: set up a six-supply, two-elimination run at the
  // exit to exercise the three-crate claim UI without a fragile combat macro.
  const legendPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const legendErrors = []; legendPage.on('pageerror', error => legendErrors.push(error.message));
  await legendPage.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: 'application/javascript', body: `${await response.text()}\nwindow.__testGame = game;` });
  });
  await legendPage.goto(base, { waitUntil: 'domcontentloaded' });
  await legendPage.locator('#playButton').click();
  await legendPage.evaluate(() => {
    const game = window.__testGame;
    game.loot = 6; game.kills = 2; game.timeLeft = 100;
    game.player.x = game.extract.x; game.player.y = game.extract.y;
    game.bots = []; game.respawnTimers = []; game.traps = []; game.scars = [];
    game.keys.add('e');
  });
  await legendPage.waitForFunction(() => !document.querySelector('#resultOverlay').hidden, null, { timeout: 10000 });
  assert.match(await legendPage.locator('#resultKicker').innerText(), /PIT LEGEND \/ 3 FREE CRATES/);
  await legendPage.locator('#resultButton').click();
  await legendPage.waitForFunction(() => document.querySelector('#resultButton').textContent.includes('DROP BACK IN'), null, { timeout: 5000 });
  assert.equal(await legendPage.locator('#crateCount').innerText(), '3');
  assert.ok(Number((await legendPage.locator('#lockerRep').innerText()).replace(/,/g, '')) > 1100);
  assert.equal((await (await fetch(`${base}/api/arena/demo`)).json()).lastRun.tier, 'legend');
  assert.deepEqual(legendErrors, []);
  await legendPage.close();

  // A synthetic high-haul defeat must forfeit the entire run, including Pit Rep.
  const lostPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const lostErrors = []; lostPage.on('pageerror', error => lostErrors.push(error.message));
  await lostPage.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: 'application/javascript', body: `${await response.text()}\nwindow.__testGame = game;` });
  });
  await lostPage.goto(base, { waitUntil: 'domcontentloaded' });
  await lostPage.locator('#playButton').click();
  const recordResponse = lostPage.waitForResponse(response => response.url().includes('/api/arena/demo/raid') && response.request().method() === 'POST');
  await lostPage.evaluate(() => {
    const game = window.__testGame;
    game.loot = 6; game.kills = 2; game.timeLeft = .01;
  });
  await lostPage.waitForFunction(() => !document.querySelector('#resultOverlay').hidden, null, { timeout: 5000 });
  await recordResponse;
  assert.equal(await lostPage.locator('#resultTitle').innerText(), 'THE PIT WON.');
  assert.match(await lostPage.locator('#resultPayout').innerText(), /0 CRATES · 0 PIT REP/);
  assert.equal(await lostPage.locator('#resultButton').isVisible(), false);
  assert.equal(await lostPage.locator('#crateCount').innerText(), '0');
  assert.equal(await lostPage.locator('#lobbyRep').innerText(), '0');
  const lostRecord = (await (await fetch(`${base}/api/arena/demo`)).json()).lastRun;
  assert.equal(lostRecord.tier, 'lost'); assert.equal(lostRecord.score, 0);
  assert.deepEqual(lostErrors, []);
  await lostPage.close();
  console.log('PASS: desktop + portrait rotate gate + real landscape touch raid/extraction, NFT demo builder, heat/hunters and 1/2/3-crate rules');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
}
