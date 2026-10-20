import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import solc from 'solc';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeFunctionData, keccak256, toHex } from 'viem';
import { candidateClaimBatch, pairHash } from '../claim-kit.mjs';
import { encodeRedeem, encodeWithdrawal, inspectClaimVault, readClaimCredits,
  sendWalletRedeem, sendWalletWithdrawal } from '../public/claim-wallet.js';

// Local-only deployment to ephemeral Ganache. No mainnet wallet, funding key,
// deployment script or real CHOG transfer is part of this test.
const source = await readFile(new URL('../contracts/ChogRewardVaultDraft.sol', import.meta.url), 'utf8');
const mocks = await readFile(new URL('../contracts/test/Mocks.sol', import.meta.url), 'utf8');
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
  sources: { 'Vault.sol': { content: source }, 'Mocks.sol': { content: mocks } },
  settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
})));
if (output.errors?.some(error => error.severity === 'error')) throw Error(output.errors.map(error => error.formattedMessage).join('\n'));
const artifacts = Object.assign({}, output.contracts['Vault.sol'], output.contracts['Mocks.sol']);
const ganacheProvider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143 },
  wallet: { totalAccounts: 5, defaultBalance: 1000 } });
try {
  const accounts = await ganacheProvider.request({ method: 'eth_accounts' });
  const chain = { id: 143, name: 'Local contract test', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: ['http://local.invalid'] } } };
  const transport = custom(ganacheProvider);
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: accounts[0] });
  const deploy = async (artifact, args = []) => {
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, args, gas: 6_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const tokenArtifact = artifacts.MockChog, entropyArtifact = artifacts.MockEntropy;
  const vaultArtifact = artifacts.ChogRewardVaultDraft;
  const token = await deploy(tokenArtifact);
  const entropy = await deploy(entropyArtifact);
  const provider = accounts[3], winner = accounts[1], sponsor = accounts[2];
  const vault = await deploy(vaultArtifact, [accounts[0], token, entropy, provider]);
  const playerProvider = { request: ({ method, params }) => method === 'eth_requestAccounts'
    ? Promise.resolve([winner]) : ganacheProvider.request({ method, params }) };
  const sponsorProvider = { request: ({ method, params }) => method === 'eth_requestAccounts'
    ? Promise.resolve([sponsor]) : ganacheProvider.request({ method, params }) };
  const vaultArgs = { address: vault, abi: vaultArtifact.abi };
  const read = (functionName, args = []) => client.readContract({ ...vaultArgs, functionName, args });
  const send = async (artifact, address, functionName, args = [], value = 0n, account = accounts[0]) => {
    const hash = await wallet.writeContract({ address, abi: artifact.abi, functionName, args, value, account, gas: 2_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `${functionName} must succeed`);
    return receipt;
  };
  const fee = await read('currentEntropyFee');
  assert.equal(fee, 14n * 10n ** 17n, 'Mock fee models a variable 1.4 MON quote, never a hardcoded vault fee.');
  assert.equal(await read('newBatchesPaused'), true);
  const exampleRoot = keccak256(toHex('example-root'));
  const requestSeed = keccak256(toHex('owner-entropy-contribution'));
  await assert.rejects(() => send(vaultArtifact, vault, 'commitBatch', [exampleRoot, 1, requestSeed], fee), /revert/i);
  await assert.rejects(() => send(vaultArtifact, vault, 'setNewBatchesPaused', [false], 0n, sponsor), /revert/i);
  await send(vaultArtifact, vault, 'setNewBatchesPaused', [false]);
  await assert.rejects(() => send(vaultArtifact, vault, 'commitBatch', [exampleRoot, 1, requestSeed], fee), /revert/i,
    'A batch cannot be committed without wallet-supplied CHOG in the vault.');
  const fund = 1000n * 10n ** 18n;
  await send(tokenArtifact, token, 'mint', [accounts[0], fund]);
  await send(tokenArtifact, token, 'transfer', [vault, fund]);
  assert.equal(await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [vault] }), fund);
  assert.equal((await inspectClaimVault(playerProvider, vault, token)).token, token.toLowerCase());
  await assert.rejects(() => inspectClaimVault(playerProvider, vault), /verified CHOG token/,
    'Wallet code rejects a vault that points to the wrong token.');
  await assert.rejects(() => send(vaultArtifact, vault, 'commitBatch', [exampleRoot, 1, requestSeed], 0n), /revert/i,
    'Oracle fee is paid separately by the campaign owner.');

  const eventIds = Array.from({ length: 10 }, (_, i) => keccak256(toHex(`verified-game-event-${i}`)));
  const rollFor = (seed, index) => BigInt(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }
  ], [seed, 0n, BigInt(index), winner, eventIds[index]]))) % 100n;
  const candidate = candidateClaimBatch({ chainId: 143, vault, batchId: 0,
    entries: eventIds.map(eventId => ({ eventId, recipient: winner })) });
  const proof = index => candidate.entries[index].proof;
  const root = candidate.root;
  for (let i = 0; i < eventIds.length; i++) {
    assert.equal(candidate.entries[i].leaf, await read('leafFor', [0n, BigInt(i), winner, eventIds[i]]),
      `Off-chain leaf must exactly match the vault for index ${i}.`);
    assert.equal(proof(i).reduce(pairHash, candidate.entries[i].leaf), root);
  }
  const firstClaim = { ...candidate.entries[0], batchId: 0, root, vault, chainId: 143 };
  assert.equal(encodeRedeem(firstClaim), encodeFunctionData({ abi: vaultArtifact.abi, functionName: 'redeem',
    args: [0n, 0n, winner, eventIds[0], proof(0)] }));
  assert.equal(encodeWithdrawal(winner), encodeFunctionData({ abi: vaultArtifact.abi,
    functionName: 'withdrawFor', args: [winner] }));
  assert.throws(() => encodeRedeem({ ...firstClaim, proof: Array(7).fill(root) }), /Invalid claim proof/,
    'A 40-leaf batch never needs more than six Merkle siblings.');
  assert.throws(() => candidateClaimBatch({ chainId: 143, vault, batchId: 0,
    entries: [{ eventId: eventIds[0], recipient: winner, previewBalance: 5 }] }), /preview records and amounts/);
  assert.throws(() => candidateClaimBatch({ chainId: 143, vault, batchId: 0,
    entries: [{ eventId: eventIds[0], recipient: winner }, { eventId: eventIds[0], recipient: winner }] }), /only once/);
  await send(vaultArtifact, vault, 'commitBatch', [root, 10, requestSeed], fee);
  assert.equal(await read('reservedMaximum'), 250n * 10n ** 18n);
  await assert.rejects(() => send(vaultArtifact, vault, '_entropyCallback', [1n, provider, requestSeed], 0n, sponsor), /revert/i);
  let seed, tierRolls;
  for (let attempt = 0; attempt < 1000; attempt++) {
    seed = keccak256(toHex(`test-provider-randomness-${attempt}`));
    tierRolls = eventIds.map((_, index) => rollFor(seed, index));
    if (tierRolls[0] < 70n && tierRolls.some(roll => roll >= 70n && roll < 95n)
      && tierRolls.some(roll => roll >= 95n)) break;
  }
  assert.ok(tierRolls.some(roll => roll >= 95n), 'Must exercise the 25-CHOG branch on every test run.');
  await send(entropyArtifact, entropy, 'fulfill', [1n, seed]);
  await assert.rejects(() => send(vaultArtifact, vault, 'redeem', [0n, 0n, sponsor, eventIds[0], proof(0)], 0n, sponsor), /revert/i);
  await assert.rejects(() => send(vaultArtifact, vault, 'redeem',
    [0n, 0n, winner, eventIds[0], Array(7).fill(root)], 0n, sponsor), /revert/i,
  'The vault rejects an oversized proof before hashing it.');
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, { vault, claim: firstClaim, expectedToken: token }),
    /Connected wallet does not match/);
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, { vault,
    claim: { ...firstClaim, chainId: 31337 }, expectedToken: token, allowSponsor: true }),
  /Claim proof domain differs/);
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, { vault,
    claim: { ...firstClaim, vault: winner }, expectedToken: token, allowSponsor: true }),
  /Claim proof domain differs/);
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, { vault,
    claim: { ...firstClaim, root: keccak256(toHex('a fake root')) }, expectedToken: token, allowSponsor: true }),
  /Claim root differs/);
  let inflatedSent = false;
  const inflatedProvider = { request: ({ method, params }) => {
    if (method === 'eth_requestAccounts') return Promise.resolve([sponsor]);
    if (method === 'eth_estimateGas') return Promise.resolve('0x100000');
    if (method === 'eth_sendTransaction') { inflatedSent = true; throw Error('Should not send a costly transaction.'); }
    return ganacheProvider.request({ method, params });
  } };
  await assert.rejects(() => sendWalletRedeem(inflatedProvider, { vault,
    claim: firstClaim, expectedToken: token, allowSponsor: true }), /Sponsor gas limit exceeded/);
  assert.equal(inflatedSent, false, 'The sponsor helper rejects an oversized gas estimate before broadcasting.');
  await assert.rejects(() => sendWalletWithdrawal(sponsorProvider, { vault, recipient: winner,
    expectedToken: token, allowSponsor: true }), /no on-chain CHOG credits/);
  let expectedTotal = 0n, firstWithdrawal = 0n;
  for (let i = 0; i < eventIds.length; i++) {
    if (i === 0) {
      const hash = await sendWalletRedeem(sponsorProvider, { vault, claim: firstClaim,
        expectedToken: token, allowSponsor: true });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
    } else await send(vaultArtifact, vault, 'redeem', [0n, BigInt(i), winner, eventIds[i], proof(i)], 0n, sponsor);
    const roll = rollFor(seed, i);
    expectedTotal += (roll < 70n ? 5n : roll < 95n ? 10n : 25n) * 10n ** 18n;
    assert.equal(await read('creditOf', [winner]), expectedTotal - firstWithdrawal);
    if (i === 0) {
      assert.equal(await readClaimCredits(playerProvider, vault, winner, token), 5n * 10n ** 18n);
      const earlyHash = await sendWalletWithdrawal(sponsorProvider, { vault, recipient: winner,
        expectedToken: token, allowSponsor: true });
      assert.equal((await client.waitForTransactionReceipt({ hash: earlyHash })).status, 'success');
      firstWithdrawal = expectedTotal;
      assert.equal(await read('creditOf', [winner]), 0n);
      assert.equal(await read('outstandingCredits'), 0n);
      assert.equal(await client.readContract({ address: token, abi: tokenArtifact.abi,
        functionName: 'balanceOf', args: [winner] }), 5n * 10n ** 18n);
      await assert.rejects(() => sendWalletWithdrawal(sponsorProvider, { vault, recipient: winner,
        expectedToken: token, allowSponsor: true }), /no on-chain CHOG credits/);
    }
  }
  assert.equal(await read('reservedMaximum'), 0n);
  assert.equal(await read('lifetimeCredited'), expectedTotal);
  assert.equal(await read('outstandingCredits'), expectedTotal - firstWithdrawal);
  await assert.rejects(() => send(vaultArtifact, vault, 'redeem', [0n, 0n, winner, eventIds[0], proof(0)], 0n, sponsor), /revert/i);
  await assert.rejects(() => send(vaultArtifact, vault, 'commitBatch', [exampleRoot, 40, requestSeed], fee), /revert/i,
    'The lifetime campaign cap must include previous awards.');
  const withdrawalHash = await sendWalletWithdrawal(sponsorProvider, { vault, recipient: winner,
    expectedToken: token, allowSponsor: true });
  assert.equal((await client.waitForTransactionReceipt({ hash: withdrawalHash })).status, 'success');
  assert.equal(await read('creditOf', [winner]), 0n);
  assert.equal(await read('outstandingCredits'), 0n);
  assert.equal(await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [winner] }), expectedTotal);
  assert.equal(await read('lifetimeCredited'), expectedTotal, 'Withdrawing never resets the 1,000-CHOG lifetime cap.');
  const repeatedLeaf = await read('leafFor', [1n, 0n, winner, eventIds[0]]);
  await send(vaultArtifact, vault, 'commitBatch', [repeatedLeaf, 1, requestSeed], fee);
  await send(entropyArtifact, entropy, 'fulfill', [2n, seed]);
  await assert.rejects(() => send(vaultArtifact, vault, 'redeem', [1n, 0n, winner, eventIds[0], []], 0n, sponsor), /revert/i,
    'A game event cannot be credited again through a second Merkle batch.');
  assert.equal(await read('lifetimeCredited'), expectedTotal);
  console.log('PASS: un-deployed vault draft compiles and survives local funding, owner-only paused batches, all three tiers, immediate 5-CHOG withdrawal, sponsor gas, cross-batch replay and lifetime-cap checks');
} finally {
  await ganacheProvider.disconnect();
}
