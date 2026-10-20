import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// The deployable game remains sample-only while its future-rule copy distinguishes
// the box-opening raider's genuine pass-holder check from the Chog arena deed.
const sourceLobby = await readFile(path.join(root, 'public/index.html'), 'utf8');
const shippedLobby = await readFile(path.join(root, '..', 'CHOGPIT_Cloudflare_Free_Deploy', 'public/index.html'), 'utf8');
for (const lobby of [sourceLobby, shippedLobby]) {
  assert.match(lobby, /only the <strong>raider who opened the box<\/strong> could receive real CHOG/i);
  assert.match(lobby, /real, minted CHOGPIT Raider Pass before payout/i);
  assert.match(lobby, /email alone does not prove Raider Pass ownership/i);
  assert.match(lobby, /TRY SAMPLE RAIDER PASS/i);
  assert.match(lobby, /BROWSER ONLY · NO NFT MINT/i);
  assert.match(lobby, /TRY SAMPLE PASS/i);
  assert.match(lobby, /REAL NFT MINT NOT LIVE/i);
  assert.match(lobby, /browser-only illustration, NOT an NFT or CHOG claim/i);
  assert.match(lobby, /preview points never convert into tokens/i);
  assert.doesNotMatch(lobby, /No wallet connection for player payouts/i);
}
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-game-only-'));
const port = 4206;
const dataPath = path.join(temp, 'arenas.json');
const rewardPath = path.join(temp, 'reward-preview.json');
const claimPath = path.join(temp, 'claim-staging.sqlite');
const env = { ...process.env, NODE_ENV: 'production', GAME_ONLY_MODE: '1', REWARD_PAYOUTS: 'disabled',
  PORT: String(port), LISTEN_HOST: '127.0.0.1', DATA_PATH: dataPath,
  REWARD_DATA_PATH: rewardPath, CLAIM_STAGING_DB_PATH: claimPath };
const run = (command, args, options = {}) => {
  const child = spawn(command, args, { cwd: root, env: options.env || env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }), exited: () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Child timed out: ${stderr}`)); }, 15000);
    child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  }) };
};
let server;
try {
  server = run(process.execPath, ['server.mjs']);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Game-only server did not start: ${server.output().stderr}`)), 10000);
    server.child.stdout.on('data', chunk => {
      if (chunk.toString().includes('CHOGPIT ready')) { clearTimeout(timeout); resolve(); }
    });
    server.child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Game-only server exited: ${code} ${server.output().stderr}`)); });
  });
  assert.match(server.output().stdout, /127\.0\.0\.1:4206/, 'Oracle reverse-proxy mode must bind the game only to loopback.');
  const smoke = run(process.execPath, ['deploy/game-only/scripts/smoke.mjs', `http://127.0.0.1:${port}`]);
  const checked = await smoke.exited();
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /two-client private WebSocket round/);
  assert.equal(existsSync(rewardPath), false, 'No wallet-preview ledger must open in game-only mode.');
  assert.equal(existsSync(claimPath), false, 'No claim-staging SQLite journal must open in game-only mode.');
  const saved = await fetch(`http://127.0.0.1:${port}/api/arena/demo/traps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ traps: [{ type: 'mine', x: 2400, y: 1248 }] })
  });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal(JSON.parse(await readFile(dataPath, 'utf8')).demo.traps.length, 1);
  assert.equal(existsSync(rewardPath), false);
  assert.equal(existsSync(claimPath), false);
  const stopped = new Promise(resolve => server.child.once('exit', resolve));
  server.child.kill('SIGTERM'); await stopped; server = null;

  const missingMode = run(process.execPath, ['server.mjs'], { env: { ...env, GAME_ONLY_MODE: '0' } });
  const missing = await missingMode.exited();
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Public hosting requires GAME_ONLY_MODE=1/);
  const corrupt = '{broken';
  await writeFile(dataPath, corrupt);
  const broken = run(process.execPath, ['server.mjs']);
  const failed = await broken.exited();
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /Arena data could not be loaded/);
  assert.equal(await readFile(dataPath, 'utf8'), corrupt, 'Damaged arena data must not be overwritten.');
  console.log('PASS: production game-only host, locked rewards, private WS round, arena persistence, no reward ledgers, and fail-closed startup');
} finally {
  if (server && server.child.exitCode === null) {
    const stopped = new Promise(resolve => server.child.once('exit', resolve));
    server.child.kill('SIGTERM'); await stopped;
  }
  await rm(temp, { recursive: true, force: true });
}
