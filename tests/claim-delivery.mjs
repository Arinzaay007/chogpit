import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ganache from 'ganache';
import solc from 'solc';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, keccak256, toHex } from 'viem';
import { WebSocket } from 'ws';
import { LiveRooms } from '../live-rooms.mjs';
import { ClaimLedger } from '../claim-ledger.mjs';
import { FreshCampaignIntake } from '../claim-intake.mjs';
import { CampaignClaimSessions, SponsorBudget, SponsoredClaims, manifestSigningMessage,
  sponsoredClaimHttpHandler, verifyPublishedClaims } from '../claim-delivery.mjs';

// Every key, token, vault and bytecode in this test exists ONLY on disposable
// local Ganache. The implemented relay supports real RPC + injected signers,
// but there is no funded Monad vault or live prize in this test.
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-fresh-claims-'));
const rpc = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143 },
  wallet: { totalAccounts: 4, defaultBalance: 1000 } });
let intake, budget, httpServer, hub, legacy;
try {
  const accounts = await rpc.request({ method: 'eth_accounts' });
  const chain = { id: 143, name: 'Disposable claim integration test',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: ['http://local.invalid'] } } };
  const transport = custom(rpc), publicClient = createPublicClient({ chain, transport });
  const owner = createWalletClient({ chain, transport, account: accounts[0] });
  const sponsor = createWalletClient({ chain, transport, account: accounts[1] });
  const player = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const other = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  assert.equal(await publicClient.getBalance({ address: player.address }), 0n);
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
  const deploy = async (artifact, args = []) => {
    const hash = await owner.deployContract({ abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`, args, gas: 6_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const write = async (artifact, address, functionName, args = [], value = 0n) => {
    const hash = await owner.writeContract({ address, abi: artifact.abi, functionName,
      args, value, gas: 2_000_000n });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  };
  const token = await deploy(artifacts.MockChog), entropy = await deploy(artifacts.MockEntropy);
  const vault = await deploy(artifacts.ChogRewardVaultDraft,
    [accounts[0], token, entropy, accounts[3]]);
  const campaignId = 'CHOGPIT_FRESH_LOCAL_TEST';
  const rulesHash = keccak256(toHex('not real campaign rules; disposable integration fixture'));
  const policy = { rulesHash, canOpen: () => true }; // TEST ONLY. Real rules must supply their own reviewed policy.
  const intakePath = path.join(temp, 'new-campaign.sqlite');
  intake = new FreshCampaignIntake(intakePath,
    { campaignId, vault, token, rulesHash, admissionPolicy: policy, allowMockToken: true });
  legacy = new ClaimLedger(path.join(temp, 'old-preview.sqlite'));
  assert.throws(() => new FreshCampaignIntake(legacy.file,
    { campaignId, vault, token, rulesHash, admissionPolicy: policy, allowMockToken: true }),
  /Never import preview or local-test events/);
  legacy.close(); legacy = null;
  const fakeSocket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, inputWindowAt: 0,
    inputCount: 0, messages: [], send(value) { this.messages.push(JSON.parse(value)); }, close() {} });
  let clock = 1_000_000;
  hub = new LiveRooms({
    resolveArena: async () => ({ id: 'demo', genome: 'demo-training', traps: [], scars: [] }),
    resolveSession: session => session === 'fresh-signed-test-session' ? player.address : null,
    onVerifiedOpening: (room, identity, box) => intake.recordServerOpening({
      runId: room.instanceId, round: room.roundNumber, boxId: box.id,
      recipient: identity.rewardSession === 'fresh-signed-test-session' ? player.address : null,
      mode: room.mode, arenaId: room.arena.id
    }),
    onReward: async () => ({ status: 'pending-oracle', amount: null }),
    now: () => clock, countdownMs: 100
  });
  const unlinked = fakeSocket();
  await hub.create(unlinked, { type: 'solo', arenaId: 'demo', name: 'NO WALLET' });
  const unlinkedBox = unlinked.player.room.rewardBoxes[0];
  unlinked.player.x = unlinkedBox.x; unlinked.player.y = unlinkedBox.y;
  hub.receiveInput(unlinked, { interact: true }, clock); clock += 33; hub.tickAll();
  assert.equal(unlinkedBox.opened, false, 'Without a campaign wallet, the prize-bearing box stays closed.');
  assert.equal(intake.audit().openings, 0);
  const soloWs = fakeSocket();
  await hub.create(soloWs, { type: 'solo', arenaId: 'demo', name: 'SOLO', session: 'fresh-signed-test-session' });
  const solo = soloWs.player.room, soloBox = solo.rewardBoxes[0];
  soloWs.player.x = soloBox.x; soloWs.player.y = soloBox.y;
  hub.receiveInput(soloWs, { interact: true }, clock); clock += 33; hub.tickAll();
  assert.equal(soloBox.opened, true);
  assert.equal(intake.audit().openings, 1);
  assert.throws(() => intake.exportManifest(), /every recorded event has been batched/);
  const pvpWs = fakeSocket(), guest = fakeSocket();
  await hub.create(pvpWs, { type: 'create', arenaId: 'demo', name: 'PVP', session: 'fresh-signed-test-session' });
  hub.join(guest, { code: pvpWs.player.room.code, name: 'GUEST' });
  hub.startCountdown(pvpWs); clock += 101; hub.tickAll();
  const pvp = pvpWs.player.room, pvpBox = pvp.rewardBoxes[0];
  pvpWs.player.x = pvpBox.x; pvpWs.player.y = pvpBox.y;
  hub.receiveInput(pvpWs, { interact: true }, clock); clock += 33; hub.tickAll();
  assert.equal(pvpBox.opened, true);
  assert.equal(intake.audit().openings, 2);
  assert.equal(intake.audit().pending, 2);
  assert.equal(intake.sealNextBatch().count, 2);
  const candidate = intake.exportManifest();
  assert.equal(candidate.batches[0].entries.length, 2);
  assert.deepEqual(new Set(candidate.batches[0].entries.map(entry => entry.mode)), new Set(['solo','pvp']));
  assert.equal(candidate.attestation, null);
  await assert.rejects(() => verifyPublishedClaims(candidate,
    { trustedPublisher: accounts[0], allowMockToken: true }), /valid signature/);
  const publisher = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const signed = { ...candidate, attestation: { signer: publisher.address,
    signature: await publisher.signMessage({ message: manifestSigningMessage(candidate) }) } };
  await assert.rejects(() => verifyPublishedClaims(signed, { trustedPublisher: other.address, allowMockToken: true }),
    /valid signature/);
  await assert.rejects(() => verifyPublishedClaims(signed, { trustedPublisher: publisher.address }),
    /verified mainnet CHOG token/);
  await assert.rejects(() => verifyPublishedClaims({ ...signed,
    batches: [{ ...signed.batches[0], entries: [{ ...signed.batches[0].entries[0],
      source: 'NON_ELIGIBLE_PREVIEW' }, signed.batches[0].entries[1]] }] },
  { trustedPublisher: publisher.address, allowMockToken: true }), /preview, local mock/);
  const book = await verifyPublishedClaims(signed,
    { trustedPublisher: publisher.address, allowMockToken: true });
  assert.equal(book.mockToken, true);
  assert.equal(book.claimsFor(other.address).length, 0);
  assert.equal(book.claimsFor(player.address).length, 2);
  intake.close(); intake = new FreshCampaignIntake(intakePath,
    { campaignId, vault, token, rulesHash, admissionPolicy: policy, allowMockToken: true });
  assert.equal(intake.audit().pending, 0);
  assert.equal(intake.exportManifest().digest, candidate.digest, 'Fresh inclusion persists across restarts.');
  await write(artifacts.MockChog, token, 'mint', [accounts[0], 1_000n * 10n ** 18n]);
  await write(artifacts.MockChog, token, 'transfer', [vault, 1_000n * 10n ** 18n]);
  await write(artifacts.ChogRewardVaultDraft, vault, 'setNewBatchesPaused', [false]);
  const fee = await publicClient.readContract({ address: vault,
    abi: artifacts.ChogRewardVaultDraft.abi, functionName: 'currentEntropyFee' });
  await write(artifacts.ChogRewardVaultDraft, vault, 'commitBatch',
    [candidate.batches[0].root, 2, keccak256(toHex('local mock owner entropy'))], fee);
  budget = new SponsorBudget(path.join(temp, 'sponsor-budget.sqlite'),
    { maxTotalWei: 1n * 10n ** 18n });
  const relay = new SponsoredClaims({ book, publicClient, walletClient: sponsor, budget,
    expectedCodeHash: keccak256(await publicClient.getBytecode({ address: vault })),
    maxGasPriceWei: 1_000_000_000_000n, maxTxFeeWei: 1_000_000_000_000_000n });
  assert.equal((await relay.status()).ready, false, 'A mock token never reports mainnet claim readiness.');
  const first = book.claimsFor(player.address)[0];
  await assert.rejects(() => relay.redeem(player.address, first.eventId), /Oracle seed has not arrived/);
  const roll = seed => BigInt(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }
  ], [seed, 0n, 0n, player.address, first.eventId]))) % 100n;
  let seed;
  for (let i = 0; i < 2000; i++) {
    const sample = keccak256(toHex(`local-mock-oracle-${i}`));
    if (roll(sample) < 70n) { seed = sample; break; }
  }
  assert.ok(seed);
  await write(artifacts.MockEntropy, entropy, 'fulfill', [1n, seed]);
  const sessions = new CampaignClaimSessions(book);
  httpServer = http.createServer(sponsoredClaimHttpHandler({ relay, sessions }));
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const post = (url, body, bearer) => fetch(`${base}${url}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body) });
  const mockStatus = await (await fetch(`${base}/api/claims/status`)).json();
  assert.equal(mockStatus.ready, false);
  assert.equal((await fetch(`${base}/api/claims/proofs`)).status, 401);
  assert.equal((await post('/api/claims/withdraw', {})).status, 401);
  const ch = await (await fetch(`${base}/api/claims/challenge?wallet=${player.address}`)).json();
  assert.match(ch.message, /REAL CLAIM WALLET LINK/);
  assert.doesNotMatch(ch.message, /PREVIEW wallet link|LOCAL MOCK CLAIM TEST ONLY/);
  const signature = await player.signMessage({ message: ch.message });
  const login = await post('/api/claims/session', { wallet: player.address, nonce: ch.nonce, signature });
  assert.equal(login.status, 200);
  const { bearer } = await login.json();
  assert.equal((await post('/api/claims/session', { wallet: player.address,
    nonce: ch.nonce, signature })).status, 401);
  const proofReply = await (await fetch(`${base}/api/claims/proofs`,
    { headers: { authorization: `Bearer ${bearer}` } })).json();
  assert.equal(proofReply.proofs.length, 2);
  assert.equal(proofReply.onchainCreditWei, '0');
  assert.equal((await post('/api/claims/redeem', { eventId: `0x${'f'.repeat(64)}` }, bearer)).status, 409);
  assert.equal((await post('/api/claims/withdraw', { recipient: other.address }, bearer)).status, 400);
  const claimed = await post('/api/claims/redeem', { eventId: first.eventId }, bearer);
  assert.equal(claimed.status, 200, JSON.stringify(await claimed.clone().json()));
  const receipt = await claimed.json();
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.recipient.toLowerCase(), player.address.toLowerCase());
  assert.equal((await post('/api/claims/redeem', { eventId: first.eventId }, bearer)).status, 409);
  const credit = await publicClient.readContract({ address: vault,
    abi: artifacts.ChogRewardVaultDraft.abi, functionName: 'creditOf', args: [player.address] });
  assert.equal(credit, 5n * 10n ** 18n, 'One box immediately creates a withdrawable five-token credit.');
  const withdrawal = await post('/api/claims/withdraw', {}, bearer);
  assert.equal(withdrawal.status, 200, JSON.stringify(await withdrawal.clone().json()));
  assert.equal((await withdrawal.json()).status, 'confirmed');
  assert.equal(await publicClient.readContract({ address: token,
    abi: artifacts.MockChog.abi, functionName: 'balanceOf', args: [player.address] }), credit);
  assert.equal(await publicClient.getBalance({ address: player.address }), 0n);
  assert.equal(budget.summary().operations, 2);
  assert.equal((await post('/api/claims/withdraw', {}, bearer)).status, 409);
  await assert.rejects(() => relay.redeem(other.address, book.claimsFor(player.address)[1].eventId),
    /No published claim for this signed wallet/);
  console.log('PASS: fresh solo/PvP openings -> signed manifest -> committed oracle-seeded root -> wallet-scoped proof -> sponsor-paid 5-CHOG mock redemption and no-minimum withdrawal');
} finally {
  if (httpServer) { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); }
  hub?.close();
  if (intake?.db.open) intake.close();
  if (legacy?.db.open) legacy.close();
  if (budget?.db.open) budget.close();
  await rpc.disconnect();
  await rm(temp, { recursive: true, force: true });
}
