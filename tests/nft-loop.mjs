import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { WebSocket } from 'ws';
import { LiveRooms } from '../live-rooms.mjs';
import { nftArenaIdentity, pinnedChogMetadata, buildArenaWorld, circleRect, LIVE_SPAWNS } from '../public/arena-world.js';

const root = path.resolve(import.meta.dirname, '..');
const pinnedCid = 'bafybeid4ybujnscdipkno7ps5utqelp5ry5ryreqhay3zhgk3a6x4jruqu';
for (const [id, art, route] of [['1', '1462', 'BREACH ROUTE'],
  ['2', '1463', 'SPLIT-LANE PIT'], ['100', '1561', 'CROSSFIRE PASS']]) {
  const uri = `ipfs://${pinnedCid}/${art}.json`;
  const meta = pinnedChogMetadata(id, uri);
  assert.equal(meta.name, `CHOG #${art}`);
  assert.ok(meta.attributes.length >= 12, 'Verified content-addressed traits must be complete.');
  assert.equal(buildArenaWorld(nftArenaIdentity(id, meta).genome).layoutName, route);
  assert.equal(pinnedChogMetadata(id, `ipfs://${pinnedCid}/other.json`), null,
    'A changed on-chain URI must never reuse old trait snapshots.');
  assert.equal(pinnedChogMetadata('999', uri), null, 'A token cannot borrow a featured NFT’s metadata.');
}
const ownerA = privateKeyToAccount(`0x${'11'.repeat(32)}`), ownerB = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const metadata = {
  '1': { attributes: [{ trait_type: 'Background', value: 'Cinder' }, { trait_type: 'Aura', value: 'Amber' }, { trait_type: 'Skin', value: 'Moss' }] },
  '2': { attributes: [{ trait_type: 'Background', value: 'Moon' }, { trait_type: 'Aura', value: 'Static' }, { trait_type: 'Skin', value: 'Moss' }] },
  '100': { attributes: [{ trait_type: 'Background', value: 'Lemon' }, { trait_type: 'Aura', value: 'Cool Aura' },
    { trait_type: 'Base', value: 'Origin' }, { trait_type: 'Skin', value: 'Red' },
    { trait_type: 'Side', value: 'Right' }, { trait_type: 'Body', value: 'Jesus' },
    { trait_type: 'Mouth', value: 'Lip Bite' }, { trait_type: 'Eyes', value: 'Purple laser' },
    { trait_type: 'Head', value: 'Clown Nose' }, { trait_type: 'Form', value: 'Chog' },
    { trait_type: 'Tier', value: 'Common' }, { trait_type: 'Naked', value: 'No' }] }
};
const worlds = Object.fromEntries(Object.entries(metadata).map(([id, traits]) => [id, buildArenaWorld(nftArenaIdentity(id, traits).genome)]));
assert.deepEqual(new Set(Object.values(worlds).map(world => world.layoutName)).size, 3,
  'Featured NFT trait sets must show three physically different wall routes.');
assert.deepEqual(new Set(Object.values(worlds).map(world => world.mapCode)).size, 3);
assert.equal(buildArenaWorld('demo-training').layoutName, 'OPEN TRAINING PIT');
assert.notEqual(nftArenaIdentity('1', metadata['1']).genome, nftArenaIdentity('2', metadata['1']).genome,
  'Token IDs must distinguish NFTs even when their traits are identical.');
assert.notEqual(nftArenaIdentity('1', metadata['1']).genome,
  nftArenaIdentity('1', { attributes: [{ trait_type: 'Aura', value: 'Glitch' }] }).genome,
  'A trait change must change the battlefield seed.');
assert.notEqual(nftArenaIdentity('1', null).genome, nftArenaIdentity('2', null).genome,
  'A gateway failure must not turn all tokens into the same level.');
for (const [id, world] of Object.entries(worlds)) {
  assert.ok(world.obstacles.some(box => box.type === 'wall' &&
    !buildArenaWorld('demo-training').obstacles.some(other => other.x === box.x && other.y === box.y)),
  `NFT #${id} must contain a playable wall not in the tutorial.`);
  for (const spawn of LIVE_SPAWNS)
    assert.ok(world.obstacles.every(box => !circleRect(spawn.x, spawn.y, 19, box)), `NFT #${id} spawn must be open.`);
}
// The authoritative server, not just the HUD, must inherit the NFT's walls
// and host-side scars when a fresh raider enters that token's next round.
let clock = 10_000;
const hub = new LiveRooms({ resolveArena: async id => ({ id, genome: nftArenaIdentity(id, metadata[id]).genome,
  traps: [], scars: [{ type: 'acid', x: 1450, y: 1300 }] }), now: () => clock });
const fakeSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0, messages: [],
  send(data) { this.messages.push(JSON.parse(data)); }, close() { this.readyState = WebSocket.CLOSED; } };
await hub.create(fakeSocket, { type: 'solo', arenaId: '1', name: 'UNOWNED RAIDER' });
const room = fakeSocket.player.room, raider = fakeSocket.player;
assert.equal(room.world.layoutName, worlds['1'].layoutName);
assert.equal(room.scars[0].type, 'acid');
raider.x = 1450; raider.y = 1300; raider.shield = 0; raider.spawnShieldUntil = 0;
room.scars[0].cd = 0;
hub.updateTraps(room, .1, clock, 179);
assert.equal(raider.hp, 93, 'An inherited acid scar must damage the next NFT raider on the server.');
room.scars = [{ type: 'static', x: 1450, y: 1300, cd: 0 }];
hub.updateTraps(room, .1, clock, 179);
assert.ok(room.bullets.some(bullet => bullet.owner === 'scar'), 'An inherited static scar fires server-owned shots.');
room.scars = [{ type: 'spores', x: 900, y: 890, cd: 0 }];
raider.x = 900; raider.y = 890; raider.lastInputAt = clock; raider.input = { dx: 1, dy: 0, aim: 0, fire: false, interact: false };
hub.updatePlayer(room, raider, .1, clock, 179);
const slowedX = raider.x;
raider.x = 900; room.scars = [];
hub.updatePlayer(room, raider, .1, clock, 179);
assert.ok(raider.x > slowedX + 5, 'An inherited spores scar must slow the next raider.');
hub.close();

// Complete one real server-measured NFT escape from input frames. Only that
// token's stored record is mutated, and the next room loads the raider's scar.
let matchClock = 20_000;
const store = new Map(['1', '2'].map(id => [id, { id,
  genome: nftArenaIdentity(id, metadata[id]).genome, traps: [], scars: [], raids: 0, clears: 0 }]));
const loopHub = new LiveRooms({ now: () => matchClock,
  resolveArena: async id => structuredClone(store.get(id)),
  onResult: async (activeRoom, player, summary) => {
    const pit = store.get(activeRoom.arena.id); pit.raids++;
    if (summary.won) pit.clears++;
    return summary.won ? pit.clears : null;
  },
  onScar: async (activeRoom, player, mark) => {
    const clearIndex = await player.resultPromise;
    assert.ok(clearIndex >= 1, 'Only a server-verified escape can claim a scar.');
    const pit = store.get(activeRoom.arena.id);
    pit.scars.push({ type: mark, x: 1450, y: 1300, raider: player.name });
    return structuredClone(pit);
  }
});
const socket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, messages: [],
  inputWindowAt: 0, inputCount: 0,
  send(data) { this.messages.push(JSON.parse(data)); }, close() { this.readyState = WebSocket.CLOSED; } });
const first = socket();
await loopHub.create(first, { type: 'solo', arenaId: '1', name: 'SCAR MAKER' });
const battle = first.player.room;
battle.bots = []; battle.traps = []; battle.scars = [];
first.player.x = battle.world.extract.x; first.player.y = battle.world.extract.y;
first.player.loot = 2; first.player.spawnShieldUntil = 0;
for (let i = 0; i < 55 && first.player.status === 'active'; i++) {
  matchClock += 33;
  loopHub.receiveInput(first, { dx: 0, dy: 0, interact: true }, matchClock);
  loopHub.tickAll();
}
assert.equal(first.player.status, 'escaped', 'Two supplies and a server-timed exit are required for an NFT scar.');
await first.player.resultPromise;
await loopHub.saveScar(first, { mark: 'spores' });
assert.equal(store.get('1').raids, 1); assert.equal(store.get('1').clears, 1);
assert.equal(store.get('1').scars[0].type, 'spores');
assert.equal(store.get('2').raids, 0); assert.deepEqual(store.get('2').scars, []);
assert.equal(first.messages.find(message => message.type === 'scar_saved').arena.id, '1');
const next = socket();
await loopHub.create(next, { type: 'solo', arenaId: '1', name: 'NEXT RAIDER' });
assert.equal(next.player.room.scars[0].type, 'spores', 'The next room must inherit that NFT scar.');
loopHub.close();

const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-nft-loop-'));
const port = 4219, base = `http://127.0.0.1:${port}`;
const dataPath = path.join(temp, 'arenas.json'), ownersPath = path.join(temp, 'owners.json');
await writeFile(ownersPath, JSON.stringify({ '1': ownerA.address, '2': ownerB.address, '100': ownerA.address }));
const seededLastRun = { won: true, loot: 3, kills: 1, mode: 'live-coop', raider: 'ALICE', at: '2026-10-19T11:00:00.000Z' };
await writeFile(dataPath, JSON.stringify({ '1': { id: '1', layoutVersion: 2, traps: [
  { type: 'turret', x: 1888, y: 992 }, { type: 'mine', x: 2400, y: 1248 }],
raids: 3, clears: 2, scars: [{ type: 'acid', x: 1450, y: 1300 }], lastRun: seededLastRun,
recentRuns: [seededLastRun, { won: false, loot: 1, kills: 0, mode: 'server-solo', raider: 'BOB', at: '2026-10-19T10:30:00.000Z' }] } }));
const server = spawn(process.execPath, ['--import', path.join(root, 'tests/fixtures/mock-chog-rpc.mjs'), 'server.mjs'], {
  cwd: root, env: { ...process.env, NODE_ENV: 'production', GAME_ONLY_MODE: '1', REWARD_PAYOUTS: 'disabled',
    LISTEN_HOST: '127.0.0.1', PORT: String(port), DATA_PATH: dataPath, CHOGPIT_NFT_TEST_OWNERS: ownersPath },
  stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
const get = async endpoint => { const response = await fetch(`${base}${endpoint}`); return { status: response.status, data: await response.json() }; };
const post = async (endpoint, body) => {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const save = async (id, signer, traps) => {
  const challenge = await post(`/api/arena/${id}/challenge`, { account: signer.address, traps });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
  const signature = await signer.signMessage({ message: challenge.data.message });
  return post(`/api/arena/${id}/traps`, { account: signer.address, traps, nonce: challenge.data.nonce, signature });
};
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mock-chain NFT game did not start.')), 10000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('CHOGPIT ready')) { clearTimeout(timeout); resolve(); } });
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`NFT test server exited: ${code}`)); });
  });
  assert.deepEqual((await get('/healthz')).data,
    { ok: true, mode: 'GAME_ONLY', rewardPayoutsEnabled: false });
  assert.equal((await get('/api/campaign/status')).data.ready, false);
  const pit1 = await get('/api/arena/1'), pit2 = await get('/api/arena/2'), pit100 = await get('/api/arena/100');
  for (const [id, result] of [['1', pit1], ['2', pit2], ['100', pit100]]) {
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.genome, nftArenaIdentity(id, metadata[id]).genome,
      `Node resolver must use the same NFT identity as the browser and authoritative rooms.`);
    assert.equal(result.data.metadataSource, 'NFT TRAITS + TOKEN ID');
    assert.ok(result.data.traitHighlights.length >= 2);
  }
  assert.equal(pit1.data.owner.toLowerCase(), ownerA.address.toLowerCase());
  assert.equal(pit1.data.raids, 3); assert.equal(pit1.data.clears, 2);
  assert.equal(pit1.data.scars[0].type, 'acid'); assert.equal(pit2.data.raids, 0);
  assert.equal(pit1.data.recentRuns.length, 2); assert.deepEqual(pit2.data.recentRuns, []);
  assert.notEqual(pit1.data.genome, pit2.data.genome);
  assert.notEqual(pit100.data.genome, pit1.data.genome);
  assert.equal((await get('/api/arena/0')).status, 404, 'An unminted token cannot enter the main arena.');
  assert.equal((await post('/api/arena/1/raid', { won: true, loot: 9, mark: 'static' })).status, 403,
    'Browser-reported wins cannot write NFT scars.');
  assert.equal((await get('/api/arena/1')).data.raids, 3);
  for (let i = 0; i < 7; i++) assert.equal((await post('/api/arena/demo/raid',
    { won: false, loot: i, kills: 0, timeLeft: 100 })).status, 200);
  assert.equal((await get('/api/arena/demo')).data.recentRuns.length, 5,
    'Chronicle storage must be bounded even in the tutorial pit.');
  const builderLayout = [{ type: 'turret', x: 1888, y: 992 }, { type: 'slime', x: 1632, y: 1440 }];
  assert.equal((await save('1', ownerB, builderLayout)).status, 403, 'Non-owner cannot save even with a valid signature.');
  const approval = await post('/api/arena/1/challenge', { account: ownerA.address, traps: builderLayout });
  assert.equal(approval.status, 200);
  const signature = await ownerA.signMessage({ message: approval.data.message });
  const altered = await post('/api/arena/1/traps', { account: ownerA.address,
    traps: [{ type: 'mine', x: 2400, y: 1248 }], nonce: approval.data.nonce, signature });
  assert.equal(altered.status, 401, 'A signed layout cannot be exchanged for a different defense.');
  assert.equal((await save('1', ownerA, builderLayout)).status, 200, 'Current on-chain owner can save a signed defense layout.');
  assert.deepEqual((await get('/api/arena/1')).data.traps, builderLayout);
  assert.equal((await get('/api/arena/2')).data.traps.length, 3, 'Traps persist by token ID, not across NFTs.');

  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: 'application/javascript',
      body: `${await response.text()}\nwindow.__testState = state; window.__testGame = game;` });
  });
  await page.route('**/ipfs/mock-chog-art/**', route => route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async value => { window.__copiedPitLink = value; } } });
  });
  await page.goto(`${base}/?pit=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__testState?.id === '1' && !window.__testState?.loading);
  assert.match(await page.locator('#pitDossierTitle').innerText(), /TEST CHOG #1/);
  assert.match(await page.locator('#pitDossierOwner').innerText(), new RegExp(ownerA.address.slice(0, 6), 'i'));
  assert.match(await page.locator('#pitDossierTraits').innerText(), /Cinder.*Amber/);
  assert.match(await page.locator('#pitDossierRoute').innerText(), /BREACH ROUTE/);
  assert.equal(await page.locator('#pitDossierTraps').innerText(), '2 / 8');
  assert.equal(await page.locator('#pitDossierRaids').innerText(), '3');
  assert.equal(await page.locator('#pitDossierScars').innerText(), '1');
  assert.match(await page.locator('#pitDossierChronicle').innerText(), /ACTIVE SCARS: 1 ACID.*NOT on the NFT contract/i);
  assert.match(await page.locator('#pitRecentRuns').innerText(), /EXTRACTED · CO-OP · ALICE.*FAILED · SOLO · BOB/s);
  assert.match(await page.locator('#playButton').innerText(), /RAID CHOG NFT #1 · SERVER SOLO/);
  assert.equal(await page.locator('#sharePitButton').isVisible(), true);
  assert.equal(await page.locator('#passMintButton').isDisabled(), true, 'No real NFT mint is available.');
  assert.equal((await get('/api/pass/status')).data.nftContract, null);
  assert.equal((await post('/api/pass/claim', { address: ownerA.address })).status, 423);
  await page.locator('#passJumpButton').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'passPreviewButton',
    'The visible sample-pass shortcut must lead to the labelled demo, not a claim page.');
  await page.locator('#passPreviewButton').click();
  assert.match(await page.locator('#passPreviewStatus').innerText(), /BROWSER ONLY · NO NFT OR CHOG CREDIT/);
  assert.equal(await page.evaluate(() => localStorage.getItem('chogpit.sampleRaiderPass')), 'true');
  assert.equal(await page.evaluate(() => window.__testState.wallet), null,
    'The sample badge and NFT raids must not force a wallet connection.');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.route('**/ipfs/mock-chog-art/**', route => route.abort());
  await phone.goto(`${base}/?pit=1`, { waitUntil: 'domcontentloaded' });
  await phone.waitForFunction(() => document.querySelector('#pitDossierTitle').textContent.includes('TEST CHOG #1'));
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390,
    'The NFT-first portrait menu must not scroll sideways.');
  await phone.locator('#pitDossier').scrollIntoViewIfNeeded();
  assert.equal(await phone.evaluate(() => document.querySelector('.nft-entry > #playButton') !== null), true,
    'The primary NFT raid button should follow the selected pit rather than payout guides.');
  await phone.close();
  await page.locator('#sharePitButton').click();
  assert.equal(new URL(await page.evaluate(() => window.__copiedPitLink)).searchParams.get('pit'), '1');
  await page.locator('#playButton').click();
  await page.waitForFunction(() => window.__testState?.live?.arena?.id === '1' && window.__testState?.live?.phase === 'playing', null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__testState.wallet), null, 'Raiding a minted NFT must not require a wallet.');
  assert.equal(await page.evaluate(() => window.__testState.live.mode), 'solo');
  assert.equal(await page.evaluate(() => window.__testGame.layoutName), 'BREACH ROUTE');
  await page.locator('#buildButton').click();
  await page.locator('#roomLeaveButton').click();
  await page.waitForFunction(() => window.__testState?.live === null && !window.__testState?.loading);
  await page.locator('[data-featured-pit="2"]').click();
  await page.waitForFunction(() => window.__testState?.id === '2' && !window.__testState?.loading);
  assert.match(await page.locator('#pitDossierRoute').innerText(), /SPLIT-LANE PIT/);
  assert.equal(await page.locator('#pitDossierRaids').innerText(), '0');
  assert.equal(new URL(page.url()).searchParams.get('pit'), '2');
  await page.locator('#arenaInput').fill('100');
  await page.locator('#loadArenaButton').click();
  await page.waitForFunction(() => window.__testState?.id === '100' && !window.__testState?.loading);
  assert.match(await page.locator('#pitDossierRoute').innerText(), /CROSSFIRE PASS/);
  await page.locator('#demoButton').click();
  await page.waitForFunction(() => window.__testState?.id === 'demo' && !window.__testState?.loading);
  assert.match(await page.locator('#pitDossierTitle').innerText(), /TRAINING PIT · NOT AN NFT/);
  assert.match(await page.locator('#playButton').innerText(), /TRY THE TRAINING PIT/);
  assert.equal(await page.locator('#sharePitButton').isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.has('pit'), false);

  // Transferring the token moves edit rights; the old owner's valid key cannot
  // edit the stored defenses or scar record after ownerOf changes.
  await writeFile(ownersPath, JSON.stringify({ '1': ownerB.address, '2': ownerB.address, '100': ownerA.address }));
  assert.equal((await get('/api/arena/1')).data.owner.toLowerCase(), ownerB.address.toLowerCase());
  assert.equal((await save('1', ownerA, [{ type: 'mine', x: 2400, y: 1248 }])).status, 403);
  assert.equal((await save('1', ownerB, [{ type: 'slime', x: 1632, y: 1440 }])).status, 200);
  const transferred = (await get('/api/arena/1')).data;
  assert.equal(transferred.owner.toLowerCase(), ownerB.address.toLowerCase());
  assert.deepEqual(transferred.traps, [{ type: 'slime', x: 1632, y: 1440 }]);
  assert.equal(transferred.raids, 4, 'The wallet-free server solo forfeit adds a verified raid to NFT #1.');
  assert.equal(transferred.lastRun.mode, 'server-solo');
  assert.match(transferred.recentRuns[0].raider, /^RAIDER-/);
  assert.deepEqual(transferred.recentRuns.slice(1).map(run => run.raider), ['ALICE', 'BOB'],
    'The newest server raid is prepended while earlier token history survives ownership transfer.');
  assert.equal(transferred.scars[0].type, 'acid',
    'Transferring the NFT does not erase its host-side battle history.');
  const neighbor = (await get('/api/arena/2')).data;
  assert.equal(neighbor.raids, 0); assert.equal(neighbor.scars.length, 0);
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
  assert.equal(JSON.parse(await readFile(dataPath, 'utf8'))['1'].traps[0].type, 'slime');
  console.log('PASS: three distinct NFT routes, owner-signed/transfer edits, wallet-free authoritative escape and scar, inherited hazards, bounded token-keyed raid history and locked payouts');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const done = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM'); await done;
  }
  await rm(temp, { recursive: true, force: true });
}
