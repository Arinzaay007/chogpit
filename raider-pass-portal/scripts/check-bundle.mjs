import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function buildProvider() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const result = await build({
    entryPoints: [path.join(root, 'src/provider.jsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser', 'module'],
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    minify: true,
    logLevel: 'error'
  });
  const output = result.outputFiles[0];
  if (!output?.text.includes('mountPrivyEmailFlow')) throw Error('Privy email-only adapter missing.');
  return output.contents;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const buffer = await buildProvider();
  console.log(`PASS: Privy email-only React adapter bundles locally (${(buffer.length / 1024).toFixed(0)} KiB).`);
}
