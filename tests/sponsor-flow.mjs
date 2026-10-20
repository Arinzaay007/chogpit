import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import solc from 'solc';
import ganache from 'ganache';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom, keccak256, toHex } from 'viem';
import { ClaimLedger, LocalClaimProofService, LocalClaimSessions } from '../claim-ledger.mjs';
import { sendWalletRedeem, sendWalletWithdrawal } from '../public/claim-wallet.js';

// The only secrets here are freshly generated, disposable LOCAL TEST keys.
// No mainnet signer, sponsor address, vault deployment or real token is used.
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-sponsor-test-'));
const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143 },
  wallet: { totalAccounts: 4, defaultBalance: 1000 } });
let ledger;
try {
  const accounts = await provider.request({ method: 'eth_accounts' });
  const sponsorAddress = accounts[0], entropyProvider = accounts[3];
  const ownerAccount = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const playerAccount = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const chain = { id: 143, name: 'Sponsor-flow mock only',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: ['http://local.invalid'] } } };
  const transport = custom(provider), client = createPublicClient({ chain, transport });
  const sponsor = createWalletClient({ account: sponsorAddress, chain, transport });
  const owner = createWalletClient({ account: ownerAccount, chain, transport });
  const sponsorProvider = { request: ({ method, params }) => method === 'eth_requestAccounts'
    ? Promise.resolve([sponsorAddress]) : provider.request({ method, params }) };
  assert.equal(await client.getBalance({ address: ownerAccount.address }), 0n);
  assert.equal(await client.getBalance({ address: playerAccount.address }), 0n);
  const sponsorStart = await client.getBalance({ address: sponsorAddress });

  const [vaultSource, mockSource] = await Promise.all([
    readFile(new URL('../contracts/ChogRewardVaultDraft.sol', import.meta.url), 'utf8'),
    readFile(new URL('../contracts/test/Mocks.sol', import.meta.url), 'utf8')
  ]);
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
    sources: { 'Vault.sol': { content: vaultSource }, 'Mocks.sol': { content: mockSource } },
    settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  if (compiled.errors?.some(error => error.severity === 'error'))
    throw Error(compiled.errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = { ...compiled.contracts['Vault.sol'], ...compiled.contracts['Mocks.sol'] };
  const deployAsSponsor = async (artifact, args = []) => {
    const hash = await sponsor.deployContract({ abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`, args, gas: 6_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', 'Sponsor deployment must succeed only on the mock chain.');
    return receipt.contractAddress;
  };
  const send = async (wallet, artifact, address, functionName, args = [], value = 0n) => {
    const hash = await wallet.writeContract({ address, abi: artifact.abi, functionName,
      args, value, gas: 2_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw Error(`${functionName} reverted`);
    return receipt;
  };
  const token = await deployAsSponsor(artifacts.MockChog);
  const entropy = await deployAsSponsor(artifacts.MockEntropy);
  const vault = await deployAsSponsor(artifacts.ChogRewardVaultDraft,
    [ownerAccount.address, token, entropy, entropyProvider]);
  const vaultRead = (functionName, args = []) => client.readContract({ address: vault,
    abi: artifacts.ChogRewardVaultDraft.abi, functionName, args });
  const tokenBalance = account => client.readContract({ address: token,
    abi: artifacts.MockChog.abi, functionName: 'balanceOf', args: [account] });
  assert.equal(await vaultRead('owner'), ownerAccount.address);
  assert.notEqual((await vaultRead('owner')).toLowerCase(), sponsorAddress.toLowerCase());
  assert.equal(await vaultRead('newBatchesPaused'), true);
  assert.equal(await client.getBalance({ address: ownerAccount.address }), 0n,
    'The owner did not personally supply MON for sponsor-paid deployments.');

  const mockPool = 1_000n * 10n ** 18n;
  await send(sponsor, artifacts.MockChog, token, 'mint', [ownerAccount.address, mockPool]);
  assert.equal(await tokenBalance(ownerAccount.address), mockPool);
  assert.equal(await tokenBalance(sponsorAddress), 0n, 'The gas sponsor never holds the mock CHOG pool.');
  await assert.rejects(() => send(owner, artifacts.MockChog, token, 'transfer', [vault, mockPool]),
    /insufficient funds|insufficient balance/i, 'An unfunded owner cannot pay transaction gas.');
  await assert.rejects(() => send(sponsor, artifacts.ChogRewardVaultDraft, vault,
    'setNewBatchesPaused', [false]), /revert/i, 'Sponsor cannot unpause owner-only batches.');

  // Two distinct on-chain wallets: sponsor supplies MON; owner controls the
  // vault and explicitly transfers the mock pool from the owner's token wallet.
  const fee = await vaultRead('currentEntropyFee');
  assert.equal(fee, 14n * 10n ** 17n, 'This is a mock fee, not a mainnet quote.');
  const topUp = fee + 2n * 10n ** 18n; // test gas margin, NOT a production budget
  const topUpTx = await sponsor.sendTransaction({ to: ownerAccount.address, value: topUp,
    gas: 21_000n });
  assert.equal((await client.waitForTransactionReceipt({ hash: topUpTx })).status, 'success');
  assert.equal(await client.getBalance({ address: ownerAccount.address }), topUp);
  await send(owner, artifacts.MockChog, token, 'transfer', [vault, mockPool]);
  assert.equal(await tokenBalance(ownerAccount.address), 0n);
  assert.equal(await tokenBalance(vault), mockPool);
  await send(owner, artifacts.ChogRewardVaultDraft, vault, 'setNewBatchesPaused', [false]);

  ledger = new ClaimLedger(path.join(temp, 'local-sponsor.sqlite'), { allowLocalTests: true });
  const campaignId = 'LOCAL_TEST_SPONSOR_GAS';
  ledger.startLocalCampaign(campaignId);
  for (let i = 0; i < 10; i++) ledger.recordLocalTestEvent(campaignId, {
    runId: randomBytes(16).toString('hex'), round: 1, boxId: 0,
    wallet: playerAccount.address, mode: i % 2 ? 'pvp' : 'solo', arenaId: 'demo'
  });
  const batch = ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault });
  ledger.finalizeLocalCampaign(campaignId);
  const sessions = new LocalClaimSessions();
  const challenge = sessions.challenge(playerAccount.address, 'localhost:4193');
  const signature = await playerAccount.signMessage({ message: challenge.message });
  const { bearer } = await sessions.create({ wallet: playerAccount.address,
    nonce: challenge.nonce, signature });
  const proofs = new LocalClaimProofService(ledger, token => sessions.resolve(token))
    .forSession({ campaignId, bearer });
  assert.equal(proofs.length, 10);
  assert.ok(proofs.every(proof => proof.vault.toLowerCase() === vault.toLowerCase()));
  await assert.rejects(() => send(sponsor, artifacts.ChogRewardVaultDraft, vault,
    'commitBatch', [batch.root, batch.count, keccak256(toHex('sponsor-cannot-pick-root'))], fee),
  /revert/i, 'Paying for MON does not confer batch-root authority.');
  const seedContribution = keccak256(toHex('owner-mock-batch-contribution'));
  await send(owner, artifacts.ChogRewardVaultDraft, vault, 'commitBatch',
    [batch.root, batch.count, seedContribution], fee);
  assert.ok(await client.getBalance({ address: ownerAccount.address }) < topUp - fee,
    'Owner spent only MON supplied by sponsor, including the mock oracle request fee.');
  await send(sponsor, artifacts.MockEntropy, entropy, 'fulfill',
    [1n, keccak256(toHex('mock-oracle-seed'))]);
  let firstPayout = 0n;
  for (const [index, proof] of proofs.entries()) {
    const hash = await sendWalletRedeem(sponsorProvider, { vault, claim: proof,
      expectedToken: token, allowSponsor: true });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
    if (index === 0) {
      firstPayout = await vaultRead('creditOf', [playerAccount.address]);
      assert.ok([5n, 10n, 25n].includes(firstPayout / 10n ** 18n));
      const early = await sendWalletWithdrawal(sponsorProvider,
        { vault, recipient: playerAccount.address, expectedToken: token, allowSponsor: true });
      assert.equal((await client.waitForTransactionReceipt({ hash: early })).status, 'success');
      assert.equal(await tokenBalance(playerAccount.address), firstPayout);
      assert.equal(await vaultRead('creditOf', [playerAccount.address]), 0n);
      assert.equal(await client.getBalance({ address: playerAccount.address }), 0n);
    }
  }
  const credit = await vaultRead('creditOf', [playerAccount.address]);
  assert.ok(credit > 0n && credit <= 225n * 10n ** 18n);
  const withdrawal = await sendWalletWithdrawal(sponsorProvider,
    { vault, recipient: playerAccount.address, expectedToken: token, allowSponsor: true });
  assert.equal((await client.waitForTransactionReceipt({ hash: withdrawal })).status, 'success');
  assert.equal(await tokenBalance(playerAccount.address), credit + firstPayout);
  assert.equal(await tokenBalance(sponsorAddress), 0n);
  assert.equal(await vaultRead('creditOf', [playerAccount.address]), 0n);
  assert.equal(await client.getBalance({ address: playerAccount.address }), 0n);
  assert.ok(await client.getBalance({ address: sponsorAddress }) < sponsorStart - topUp,
    'The sponsor financed deployment, top-up, claim and withdrawal gas.');
  console.log('PASS: separate zero-MON owner/player and funded sponsor; sponsor finances mock deployment, owner-only oracle/commit gas and player claims without CHOG custody or root authority');
} finally {
  if (ledger?.db.open) ledger.close();
  await provider.disconnect();
  await rm(temp, { recursive: true, force: true });
}
