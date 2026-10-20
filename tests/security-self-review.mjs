import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { WebSocket } from 'ws';

// Black-box regression tests of the preview server's corrected trust boundaries.
// This uses a disposable local key, private temporary files, and NO mainnet tx.
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-security-review-'));
const port = 4197, base = `http://127.0.0.1:${port}`;
const owner = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(port), REWARD_PAYOUTS: 'disabled',
    DATA_PATH: path.join(temp, 'arenas.json'), REWARD_DATA_PATH: path.join(temp, 'preview.json'),
    CLAIM_STAGING_DB_PATH: path.join(temp, 'staging.sqlite') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
server.stderr.on('data', chunk => { logs += chunk.toString(); });
const post = (url, data) => fetch(`${base}${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
});
const socketAttempt = origin => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  ws.once('open', () => { ws.close(); resolve(101); });
  ws.once('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); });
  ws.once('error', reject);
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Review test server did not start. ${logs}`)), 10000);
    server.stdout.on('data', chunk => {
      if (chunk.toString().includes('CHOGPIT ready')) { clearTimeout(timer); resolve(); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(Error(`Review test server exited: ${code}. ${logs}`)); });
  });
  const good = [{ type: 'turret', x: 1888, y: 992 }, { type: 'mine', x: 2400, y: 1248 }];
  const changed = [{ type: 'turret', x: 1888, y: 992 }, { type: 'slime', x: 2400, y: 1248 }];
  const endpoint = '/api/arena/1103/challenge';
  assert.equal((await fetch(`${base}${endpoint}?account=${owner.address}`)).status, 405,
    'The old layout-free GET challenge must be removed.');
  assert.equal((await post(endpoint, { account: owner.address, traps: [good[0], good[0]] })).status, 400);
  const challengeResponse = await post(endpoint, { account: owner.address, traps: good });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  assert.match(challenge.message, /Site: 127\.0\.0\.1:4197/);
  assert.match(challenge.message, /Monad chain: 143/);
  assert.match(challenge.message, /Chog Genesis token ID: 1103/);
  assert.ok(challenge.message.includes(`Exact trap layout: ${JSON.stringify(good)}`));
  assert.ok(challenge.expires > Date.now());
  const signature = await owner.signMessage({ message: challenge.message });
  assert.equal(await verifyMessage({ address: owner.address, message: challenge.message, signature }), true);
  const forgedLayout = await post('/api/arena/1103/traps', {
    account: owner.address, traps: changed, nonce: challenge.nonce, signature
  });
  assert.equal(forgedLayout.status, 401, 'A valid signature must NOT authorize a substituted layout.');
  assert.match((await forgedLayout.json()).error, /Signed trap layout changed/);
  assert.equal((await post('/api/arena/1103/traps', {
    account: owner.address, traps: good, nonce: challenge.nonce, signature
  })).status, 401, 'Failed attempts consume the nonce.');
  const fresh = await (await post(endpoint, { account: owner.address, traps: good })).json();
  assert.equal((await post('/api/arena/1103/traps', {
    account: owner.address, traps: good, nonce: fresh.nonce, signature
  })).status, 401, 'A signature for an old nonce cannot be replayed.');
  const forgedRun = await post('/api/arena/1103/raid', {
    won: true, loot: 25, kills: 99, mark: 'acid', timeLeft: 180
  });
  assert.equal(forgedRun.status, 403, 'Client-reported runs cannot mark a Chog NFT arena.');
  assert.match((await forgedRun.json()).error, /Unverified browser runs/);
  assert.equal(await socketAttempt('https://another.example'), 403,
    'Cross-origin browser room creation is not accepted.');
  assert.equal(await socketAttempt(base), 101, 'Same-origin browser sockets remain usable.');
  let limitAt = null;
  for (let i = 0; i < 46; i++) {
    const result = await fetch(`${base}/api/rewards/challenge?address=${owner.address}`, {
      headers: { 'x-forwarded-for': `198.51.100.${i}` }
    });
    if (result.status === 429) { limitAt = i; break; }
    assert.equal(result.status, 200);
  }
  assert.ok(limitAt !== null && limitAt < 45,
    'Spoofing a different X-Forwarded-For on every request must not evade rate limiting.');
  assert.equal((await fetch(`${base}/api/arena/1103`)).status, 429,
    'Rate limits must protect expensive NFT and metadata lookups.');
  assert.equal((await fetch(`${base}/api/chain/${owner.address}/1103`)).status, 429,
    'Rate limits must protect live RPC owner/balance lookups.');
  const status = await (await fetch(`${base}/api/claims/status`)).json();
  assert.equal(status.ready, false, 'Security fixes do not enable mainnet claims.');
  assert.equal((await fetch(`${base}/api/claims/proof?wallet=${owner.address}`)).status, 423);
  console.log('PASS: signed exact NFT layout, one-use challenge, NFT raid integrity, same-origin WS, lookup limits, and locked claims');
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await stopped;
  }
  await rm(temp, { recursive: true, force: true });
}
