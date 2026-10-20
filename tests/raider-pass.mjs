import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ganache from 'ganache';
import solc from 'solc';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom } from 'viem';
import { raiderPassClaimTypedData } from '../raider-pass.mjs';

// Disposable EVM chain 143, NOT Monad mainnet. Neither NFT nor CHOG is real.
const root = path.resolve(import.meta.dirname, '..');
const source = await readFile(path.join(root, 'contracts/ChogpitRaiderPassDraft.sol'), 'utf8');
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
  sources: { 'ChogpitRaiderPassDraft.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } }
}), { import: name => {
  try { return { contents: requireFile(name) }; }
  catch (error) { return { error: error.message }; }
} }));
function requireFile(name) {
  if (!name.startsWith('@openzeppelin/contracts/')) throw Error('Unexpected contract import.');
  const base = path.join(root, 'node_modules', name);
  return readFileSync(base, 'utf8');
}
if (output.errors?.some(item => item.severity === 'error'))
  throw Error(output.errors.map(item => item.formattedMessage).join('\n'));
const artifact = output.contracts['ChogpitRaiderPassDraft.sol'].ChogpitRaiderPassDraft;
assert.ok(artifact.evm.deployedBytecode.object.length / 2 < 24576, 'Deployed code exceeds EVM size limit.');
const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143 },
  wallet: { totalAccounts: 3, defaultBalance: 1000 } });
try {
  const addresses = await provider.request({ method: 'eth_accounts' });
  const chain = { id: 143, name: 'Disposable CHOGPIT pass test',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: ['http://local.invalid'] } } };
  const transport = custom(provider), rpc = createPublicClient({ chain, transport });
  const owner = createWalletClient({ chain, transport, account: addresses[0] });
  const stranger = createWalletClient({ chain, transport, account: addresses[1] });
  const players = ['31','32','33','34'].map(hex => privateKeyToAccount(`0x${hex.repeat(32)}`));
  const send = async (wallet, fn, args) => {
    const tx = await wallet.writeContract({ address: pass, abi: artifact.abi,
      functionName: fn, args, gas: fn === 'mintBatchWithConsent' ? 9_000_000n : 2_000_000n });
    const receipt = await rpc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, 'success', `${fn} failed`);
    return receipt;
  };
  const deployTx = await owner.deployContract({ abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`, args: [addresses[0]], gas: 6_000_000n });
  const receipt = await rpc.waitForTransactionReceipt({ hash: deployTx });
  assert.equal(receipt.status, 'success');
  const pass = receipt.contractAddress;
  const read = (fn, args = []) => rpc.readContract({ address: pass,
    abi: artifact.abi, functionName: fn, args });
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const typed = async (player, deadline = expiry, overrides = {}) =>
    raiderPassClaimTypedData({ recipient: player.address, contract: pass,
      nonce: await read('nonces', [player.address]), deadline, ...overrides });
  const consent = async (player, deadline = expiry, overrides = {}) =>
    player.signTypedData(await typed(player, deadline, overrides));
  const expectRevert = async (wallet, fn, args, reason) => {
    await assert.rejects(() => rpc.simulateContract({ address: pass, abi: artifact.abi,
      functionName: fn, args, account: wallet.account }), /revert|denied/i, reason);
  };
  assert.equal(await read('maxSupply'), 40n, 'Real draft enforces the selected 40-pass supply on-chain.');
  assert.equal(await read('totalSupply'), 0n);
  assert.equal(await read('name'), 'CHOGPIT Raider Pass');
  const [a, b, c, d] = players;
  const aliceBefore = await rpc.getBalance({ address: a.address });
  assert.equal(aliceBefore, 0n, 'The player must need no gas balance to receive the pass.');
  const sigA = await consent(a);
  await expectRevert(stranger, 'mintWithConsent', [a.address, expiry, sigA], 'Only sponsor/issuer may pay for mint.');
  await expectRevert(owner, 'mintWithConsent', [b.address, expiry, sigA], 'A cannot sign for B.');
  await expectRevert(owner, 'mintWithConsent', [a.address, expiry,
    await consent(a, expiry, { chainId: 1 })], 'Consent on a different chain is invalid.');
  await expectRevert(owner, 'mintWithConsent', [a.address, expiry,
    await consent(a, expiry, { contract: addresses[2] })], 'Consent for another contract is invalid.');
  await expectRevert(owner, 'mintWithConsent', [a.address, 1n,
    await consent(a, 1n)], 'Expired mint consent is invalid.');
  const sponsorBefore = await rpc.getBalance({ address: addresses[0] });
  await send(owner, 'mintWithConsent', [a.address, expiry, sigA]);
  assert.equal(await read('ownerOf', [1n]), a.address);
  assert.equal(await read('balanceOf', [a.address]), 1n);
  assert.equal(await read('everClaimed', [a.address]), true);
  assert.equal(await read('nonces', [a.address]), 1n);
  assert.equal(await rpc.getBalance({ address: a.address }), aliceBefore,
    'Claimant paid no gas; the issuer submitted the mint transaction.');
  assert.ok((await rpc.getBalance({ address: addresses[0] })) < sponsorBefore);
  const dataURI = await read('tokenURI', [1n]);
  assert.match(dataURI, /^data:application\/json;base64,/);
  const meta = JSON.parse(Buffer.from(dataURI.split(',')[1], 'base64').toString());
  assert.equal(meta.name, 'CHOGPIT Raider Pass #1');
  assert.match(meta.description, /not an official Chog NFT or a CHOG prize entitlement/i);
  assert.match(Buffer.from(meta.image.split(',')[1], 'base64').toString(), /RAIDER PASS/);
  await expectRevert(owner, 'mintWithConsent', [a.address, expiry, sigA], 'One mint per wallet lifetime.');
  // A bad signature inside a batch must revert all minting, not issue B's pass.
  await expectRevert(owner, 'mintBatchWithConsent', [[b.address,c.address],
    [expiry,expiry], [await consent(b), await consent(d)]], 'Invalid batch is atomic.');
  assert.equal(await read('totalSupply'), 1n);
  await send(owner, 'mintBatchWithConsent', [[b.address,c.address],
    [expiry,expiry], [await consent(b), await consent(c)]]);
  assert.equal(await read('ownerOf', [2n]), b.address);
  assert.equal(await read('ownerOf', [3n]), c.address);
  assert.equal(await read('balanceOf', [d.address]), 0n);
  const morePlayers = Array.from({ length: 37 }, (_, index) =>
    privateKeyToAccount(`0x${(64 + index).toString(16).repeat(32)}`));
  for (let offset = 0; offset < morePlayers.length; offset += 20) {
    const batch = morePlayers.slice(offset, offset + 20);
    await send(owner, 'mintBatchWithConsent', [batch.map(player => player.address),
      batch.map(() => expiry), await Promise.all(batch.map(player => consent(player)))]);
  }
  assert.equal(await read('totalSupply'), 40n);
  assert.equal(await read('ownerOf', [40n]), morePlayers.at(-1).address);
  await expectRevert(owner, 'mintWithConsent', [d.address, expiry, await consent(d)],
    'The forty-first pass cannot be minted, even with valid recipient consent.');
  assert.equal(await read('balanceOf', [d.address]), 0n);
  // Wallet-free raid eligibility is independent of any token/balance; payout
  // eligibility, if ever built, would check the CURRENT NFT holder at payout.
  console.log('PASS: 40-pass on-chain cap, sponsor-paid ERC721 disposable-chain mint, wallet consent, on-chain art, one-per-wallet and atomic batches; no Monad mint or CHOG');
} finally { await provider.disconnect(); }
