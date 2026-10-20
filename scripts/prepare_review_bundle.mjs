// Reproducible, read-only build inventory for INDEPENDENT review.
// No RPC, wallet, deployment, transaction, funding or approval is performed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import solc from 'solc';
import { keccak256 } from 'viem';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = [
  'contracts/ChogRewardVaultThresholdDraft.sol', 'package.json', 'package-lock.json',
  'contracts/ChogpitRaiderPassDraft.sol', 'raider-pass.mjs',
  'claim-kit-threshold.mjs', 'late-bound-intake.mjs', 'passkey-accounts.mjs',
  'email-accounts.mjs', 'email-admission.mjs',
  'campaign-admission.mjs', 'sponsor-threshold.mjs',
  'candidate-recovery.mjs', 'campaign-candidate-service.mjs',
  'email-candidate-service.mjs', 'live-rooms.mjs', 'server.mjs',
  'deploy/game-only/cloudflare/worker.mjs',
  'public/arena-world.js', 'public/app.js', 'public/index.html', 'public/style.css',
  'public/campaign-account.js', 'public/campaign-account.html',
  'public/campaign-email-account.js', 'public/campaign-email-account.html',
  'tests/email-account-candidate.mjs', 'tests/email-admission.mjs',
  'tests/email-candidate-api.mjs', 'tests/nft-loop.mjs', 'tests/raider-pass.mjs',
  'tests/fixtures/mock-chog-rpc.mjs', 'tests/game-only-deployment.mjs',
  'scripts/package_game_only_zip.py', 'public/claim.html',
  'CAMPAIGN_RULES_DRAFT.md', 'RAIDER_PASS_PROTOTYPE.md',
  'EMBEDDED_WALLET_CLAIM_PLAN.md',
  // The isolated owner-preview portal is NOT packaged with the public game.
  'raider-pass-portal/package.json', 'raider-pass-portal/package-lock.json',
  'raider-pass-portal/pnpm-lock.yaml', 'raider-pass-portal/.npmrc',
  'raider-pass-portal/README.md',
  'raider-pass-portal/index.html', 'raider-pass-portal/auth.mjs',
  'raider-pass-portal/registry.mjs', 'raider-pass-portal/server.mjs',
  'raider-pass-portal/src/portal.js', 'raider-pass-portal/src/provider.jsx',
  'raider-pass-portal/scripts/check-bundle.mjs',
  'raider-pass-portal/tests/portal.mjs'
];
const sha256 = data => `0x${createHash('sha256').update(data).digest('hex')}`;
const files = {};
for (const name of paths) files[name] = sha256(await readFile(path.join(root, name)));
const source = await readFile(path.join(root, paths[0]), 'utf8');
const settings = {
  optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
  outputSelection: { '*': { '*': [
    'abi', 'evm.bytecode.object', 'evm.deployedBytecode.object',
    'evm.deployedBytecode.immutableReferences'
  ] } }
};
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
  sources: { 'ChogRewardVaultThresholdDraft.sol': { content: source } }, settings })));
const errors = output.errors?.filter(item => item.severity === 'error') || [];
if (errors.length) throw Error(errors.map(item => item.formattedMessage).join('\n'));
const item = output.contracts?.['ChogRewardVaultThresholdDraft.sol']?.ChogRewardVaultThresholdDraft;
if (!item?.evm?.bytecode?.object || !item?.evm?.deployedBytecode?.object)
  throw Error('Expected a compiled threshold vault and ABI.');
const passPath = 'contracts/ChogpitRaiderPassDraft.sol';
const passOutput = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
  'ChogpitRaiderPassDraft.sol': { content: await readFile(path.join(root, passPath), 'utf8') }
}, settings }), { import: name => {
  if (!name.startsWith('@openzeppelin/contracts/')) return { error: 'Unexpected contract import' };
  try { return { contents: readFileSync(path.join(root, 'node_modules', name), 'utf8') }; }
  catch (error) { return { error: error.message }; }
} }));
const passErrors = passOutput.errors?.filter(e => e.severity === 'error') || [];
if (passErrors.length) throw Error(passErrors.map(e => e.formattedMessage).join('\n'));
const pass = passOutput.contracts?.['ChogpitRaiderPassDraft.sol']?.ChogpitRaiderPassDraft;
if (!pass?.evm?.bytecode?.object || !pass?.evm?.deployedBytecode?.object)
  throw Error('Expected a compiled Raider Pass and ABI.');
const object = {
  schema: 'CHOGPIT_REVIEW_BUILD_V2',
  status: 'UNREVIEWED_UNDEPLOYED_NO_MAINNET_CLAIMS',
  chainTarget: 143,
  tokenTarget: '0x350035555e10d9afaf1566aaebfced5ba6c27777',
  compiler: solc.version(),
  compilerSettings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion },
  contract: 'ChogRewardVaultThresholdDraft',
  sourceSha256: files[paths[0]],
  creationBytecodeKeccak256: keccak256(`0x${item.evm.bytecode.object}`),
  creationBytecodeBytes: item.evm.bytecode.object.length / 2,
  runtimeTemplateKeccak256: keccak256(`0x${item.evm.deployedBytecode.object}`),
  runtimeTemplateBytes: item.evm.deployedBytecode.object.length / 2,
  immutableReferences: item.evm.deployedBytecode.immutableReferences,
  runtimeWarning: 'Runtime TEMPLATE contains constructor immutables. Its hash is NOT a deployed vault code hash. Independently verify actual on-chain runtime bytecode after a reviewed deployment.',
  files,
  abi: item.abi,
  compilerWarnings: output.errors?.filter(e => e.severity !== 'error')
    .map(e => e.formattedMessage) || [],
  raiderPass: {
    status: 'UNREVIEWED_UNDEPLOYED_NO_MAINNET_MINT',
    contract: 'ChogpitRaiderPassDraft', chainTarget: 143,
    selectedMaxSupply: 40, // Enforced by the contract constant; not the CHOG-backed opening cap.
    sourceSha256: files[passPath],
    creationBytecodeKeccak256: keccak256(`0x${pass.evm.bytecode.object}`),
    creationBytecodeBytes: pass.evm.bytecode.object.length / 2,
    runtimeTemplateKeccak256: keccak256(`0x${pass.evm.deployedBytecode.object}`),
    runtimeTemplateBytes: pass.evm.deployedBytecode.object.length / 2,
    immutableReferences: pass.evm.deployedBytecode.immutableReferences,
    runtimeWarning: 'Compiled runtime TEMPLATE; not a deployed Monad NFT or a verified chain code hash. Independently verify actual runtime/issuer/owner after a reviewed deployment.',
    abi: pass.abi,
    compilerWarnings: passOutput.errors?.filter(e => e.severity !== 'error')
      .map(e => e.formattedMessage) || []
  }
};
const serialized = JSON.stringify(object, null, 2) + '\n';
const target = path.join(root, 'REVIEW_BUILD.json');
if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8');
  if (existing !== serialized) throw Error('REVIEW_BUILD.json is stale; rebuild and re-review changed sources.');
  console.log('PASS: reproducible review bundle matches current source and rules draft.');
} else {
  await writeFile(target, serialized);
  console.log(`Wrote ${target}; Solidity ${object.compiler}; ${object.runtimeTemplateBytes} runtime-template bytes. NO DEPLOYMENT.`);
}
