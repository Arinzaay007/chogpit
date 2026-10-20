// Keep a separate allowlisted Cloudflare package; never include unfinished
// campaign/claim modules, preview wallets, private data or .wrangler state.
// Usage: node scripts/export_cloudflare_game.mjs [--check]
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'deploy', 'game-only', 'cloudflare');
const oracleExport = path.resolve(root, '..', 'CHOGPIT_Game_Only_Deploy');
const output = path.resolve(root, '..', 'CHOGPIT_Cloudflare_Free_Deploy');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Unexpected option.');
const contents = new Map();
const add = async (dest, source) => contents.set(dest, await readFile(source));
for (const file of ['worker.mjs', 'ws-shim.mjs', 'wrangler.jsonc', 'package.json', 'DEPLOY.md', 'scripts/smoke.mjs'])
  await add(file, path.join(template, file));
for (const file of ['live-rooms.mjs', 'public/app.js', 'public/arena-world.js',
  'public/audio.js', 'public/game.js', 'public/style.css', 'public/index.html'])
  await add(file, path.join(oracleExport, file));
for (const file of await readdir(path.join(oracleExport, 'public', 'assets'))) {
  if (!/^[a-z0-9_-]+\.(?:jpg|jpeg|png|webp|svg)$/i.test(file)) throw new Error(`Unexpected game asset: ${file}`);
  await add(`public/assets/${file}`, path.join(oracleExport, 'public', 'assets', file));
}
const lockFile = path.join(template, 'package-lock.json');
await add('package-lock.json', lockFile);
async function list(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!prefix && ['node_modules', '.wrangler', 'data', '.git'].includes(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await list(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error(`Unexpected symlink or special file: ${rel}`);
  }
  return files;
}
if (check) {
  const actual = (await list(output)).sort(), expected = [...contents.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Cloudflare file list drifted.\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`);
  for (const [file, expectedBytes] of contents)
    if (!(await readFile(path.join(output, file))).equals(expectedBytes)) throw new Error(`Cloudflare export stale: ${file}`);
  console.log(`PASS: Cloudflare game-only export verified (${contents.size} allowlisted files; no claim modules).`);
} else {
  try {
    const extra = (await list(output)).filter(file => !contents.has(file));
    if (extra.length) throw new Error(`Refusing to overwrite extra files in Cloudflare export: ${extra.join(', ')}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [file, bytes] of contents) {
    await mkdir(path.dirname(path.join(output, file)), { recursive: true });
    await writeFile(path.join(output, file), bytes);
  }
  console.log(`Exported Cloudflare no-payout game to ${output} (${contents.size} allowlisted files).`);
}
