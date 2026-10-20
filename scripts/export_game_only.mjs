// Publish only the playable game, not this repository's unreviewed reward work.
// Usage: node scripts/export_game_only.mjs [--check]
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'deploy', 'game-only');
const output = path.resolve(root, '..', 'CHOGPIT_Game_Only_Deploy');
const options = process.argv.slice(2);
const check = options.includes('--check');
if (options.some(argument => argument !== '--check')) {
  throw new Error('The only supported option is --check.');
}
const contents = new Map();
const add = async (destination, source) => contents.set(destination, await readFile(source));
for (const file of ['server.mjs', 'live-rooms.mjs']) await add(file, path.join(root, file));
for (const file of ['app.js', 'arena-world.js', 'audio.js', 'game.js', 'style.css']) {
  await add(`public/${file}`, path.join(root, 'public', file));
}
const originalPage = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
const accountLink = '<a class="claim-portal-link" href="/claim.html">READ FUTURE REWARD PROPOSAL ↗</a>';
if (!originalPage.includes(accountLink)) throw new Error('Index changed: re-review the disabled-claims game-only copy.');
contents.set('public/index.html', Buffer.from(originalPage.replace(accountLink,
  '<small>Game-only hosting has no email signup, payout-address form or real CHOG claim.</small>')));
const assets = await readdir(path.join(root, 'public', 'assets'));
for (const name of assets) {
  if (!/^[a-z0-9_-]+\.(?:jpg|jpeg|png|webp|svg)$/i.test(name)) throw new Error(`Unexpected public asset: ${name}`);
  await add(`public/assets/${name}`, path.join(root, 'public', 'assets', name));
}
for (const file of ['.gitignore', '.node-version', 'package.json', 'package-lock.json', 'README.md', 'render.yaml',
  'scripts/smoke.mjs', 'oracle/DEPLOY.md', 'oracle/install-on-ubuntu.sh', 'oracle/chogpit.service', 'oracle/Caddyfile']) {
  await add(file, path.join(template, file));
}

async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (prefix === '' && ['node_modules', 'data', '.git'].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected non-file in export: ${relative}`);
  }
  return files;
}
if (check) {
  const actual = (await listFiles(output)).sort();
  const expected = [...contents.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Export file list drifted.\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`);
  for (const [file, bytes] of contents) {
    const exported = await readFile(path.join(output, file));
    if (!exported.equals(bytes)) throw new Error(`Game-only export is stale: ${file}`);
  }
  console.log('PASS: game-only deploy package matches the reviewed source allowlist; no claim modules shipped.');
} else {
  // Update only allowlisted paths. Leave a user's repository and local data intact.
  try {
    const existing = await listFiles(output);
    const extra = existing.filter(file => !contents.has(file));
    if (extra.length) throw new Error(`Refusing to overwrite unexpected export files: ${extra.join(', ')}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [file, bytes] of contents) {
    const destination = path.join(output, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  console.log(`Exported the no-reward game to ${output} (${contents.size} allowlisted files).`);
}
