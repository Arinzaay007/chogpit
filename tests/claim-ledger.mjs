import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import solc from 'solc';
import ganache from 'ganache';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom, keccak256, toHex } from 'viem';
import { WebSocket } from 'ws';
import { ClaimLedger, LocalClaimSessions, LocalClaimProofService,
  localProofHttpHandler } from '../claim-ledger.mjs';
import { LiveRooms } from '../live-rooms.mjs';
import { sendWalletRedeem, sendWalletWithdrawal } from '../public/claim-wallet.js';

// Truly separate LOCAL TEST flow: server-checked box -> SQLite transaction ->
// Merkle proof service -> mock on-chain CHOG redeem -> sponsor-funded withdrawal.
// Nothing here publishes to mainnet, imports preview balances or enables claims.
const temp = await mkdtemp(path.join(tmpdir(), 'chogpit-claim-ledger-'));
const file = path.join(temp, 'sandbox-claims.sqlite');
let ledger, hub, provider, proofServer;
try {
  const player = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const stranger = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const observed = { runId: 'a'.repeat(32), round: 1, boxId: 0,
    wallet: player.address, mode: 'solo', arenaId: 'demo' };
  ledger = new ClaimLedger(file);
  assert.equal(ledger.recordObservation(observed).claimable, false);
  assert.equal(ledger.recordObservation(observed).duplicate, true);
  assert.throws(() => ledger.recordObservation({ ...observed, wallet: stranger.address }), /Conflicting duplicate/);
  assert.throws(() => ledger.startLocalCampaign('LOCAL_TEST_PIPELINE'), /not available in the hosted game/);
  assert.throws(() => new LocalClaimProofService(ledger, () => player.address), /explicit local test/);
  assert.equal(ledger.claimEventCount(), 0);
  ledger.close();
  ledger = new ClaimLedger(file, { allowLocalTests: true });
  assert.equal(ledger.observationCount(), 1, 'Staging observation persists but stays outside claims.');
  const campaignId = 'LOCAL_TEST_PIPELINE';
  ledger.startLocalCampaign(campaignId);
  assert.throws(() => ledger.recordLocalTestEvent(campaignId, observed), /preview opening cannot be imported/);
  assert.equal(ledger.claimEventCount(), 0);
  assert.throws(() => ledger.startLocalCampaign('MAINNET_CHOG'), /LOCAL_TEST/);

  const sessions = new LocalClaimSessions();
  const signIn = async signer => {
    const challenge = sessions.challenge(signer.address, 'localhost:4193');
    const signature = await signer.signMessage({ message: challenge.message });
    const session = await sessions.create({ wallet: signer.address, nonce: challenge.nonce, signature });
    await assert.rejects(() => sessions.create({ wallet: signer.address, nonce: challenge.nonce, signature }), /Invalid or replayed/);
    return session.bearer;
  };
  const bearer = await signIn(player), otherBearer = await signIn(stranger);
  const proofService = new LocalClaimProofService(ledger, token => sessions.resolve(token));
  assert.throws(() => proofService.forSession({ campaignId, bearer: 'fake' }), /Valid signed wallet/);
  assert.throws(() => proofService.forSession({ campaignId, bearer }), /finalized, reconciled/);

  const fakeSocket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, inputWindowAt: 0,
    inputCount: 0, messages: [], send(payload) { this.messages.push(JSON.parse(payload)); }, close() {} });
  hub = new LiveRooms({
    resolveArena: async () => ({ id: 'demo', traps: [], scars: [], genome: 'local-test' }),
    resolveSession: token => sessions.resolve(token), now: () => Date.now(), countdownMs: 0,
    onVerifiedOpening: (room, identity, box) => ledger.recordLocalTestEvent(campaignId, {
      runId: room.instanceId, round: room.roundNumber, boxId: box.id,
      wallet: sessions.resolve(identity.rewardSession), mode: room.mode, arenaId: room.arena.id
    }),
    onReward: async () => ({ status: 'sample-only', note: 'Local test; not real CHOG.' })
  });
  const opened = [];
  for (let i = 0; i < 10; i++) {
    const host = fakeSocket(), mode = i < 7 ? 'solo' : 'pvp';
    await hub.create(host, { type: mode === 'solo' ? 'solo' : 'create', arenaId: 'demo', name: 'TEST', session: bearer });
    if (mode === 'pvp') {
      const guest = fakeSocket();
      hub.join(guest, { code: host.player.room.code, name: 'GUEST' });
      hub.startCountdown(host);
      hub.tickAll();
      assert.equal(host.player.room.phase, 'playing');
    }
    const room = host.player.room, box = room.rewardBoxes[0];
    assert.ok(box, 'The server must pick at least one hidden box for a test room.');
    // Direct position assignment is confined to this test; clients cannot send
    // coordinates in production (covered by tests/rewards.mjs).
    host.player.x = box.x; host.player.y = box.y;
    hub.receiveInput(host, { type: 'input', interact: true }, Date.now());
    hub.tickAll();
    assert.equal(box.opened, true, `Server checks and journals the ${mode} box before opening.`);
    assert.equal(ledger.claimEventCount(), i + 1);
    opened.push({ runId: room.instanceId, round: room.roundNumber, boxId: box.id,
      wallet: player.address, mode, arenaId: room.arena.id });
    hub.tickAll();
    assert.equal(ledger.claimEventCount(), i + 1, 'Repeat client input cannot replay an opened box.');
  }
  assert.equal(ledger.observationCount(), 1, 'The sandbox test never imports preview observations.');
  assert.equal(ledger.recordLocalTestEvent(campaignId, opened[0]).duplicate, true);
  assert.throws(() => ledger.recordLocalTestEvent(campaignId,
    { ...opened[0], wallet: stranger.address }), /Conflicting duplicate/);
  assert.throws(() => ledger.recordObservation(opened[0]), /cannot be relabeled as a preview/);

  const [vaultSource, mockSource] = await Promise.all([
    readFile(new URL('../contracts/ChogRewardVaultDraft.sol', import.meta.url), 'utf8'),
    readFile(new URL('../contracts/test/Mocks.sol', import.meta.url), 'utf8')
  ]);
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
    sources: { 'Vault.sol': { content: vaultSource }, 'Mocks.sol': { content: mockSource } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } } })));
  if (compiled.errors?.some(error => error.severity === 'error'))
    throw Error(compiled.errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = { ...compiled.contracts['Vault.sol'], ...compiled.contracts['Mocks.sol'] };
  provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143 },
    wallet: { totalAccounts: 4, defaultBalance: 1000 } });
  const addresses = await provider.request({ method: 'eth_accounts' });
  const chain = { id: 143, name: 'Ephemeral mock chain', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: ['http://local.invalid'] } } };
  const transport = custom(provider), client = createPublicClient({ chain, transport });
  const owner = createWalletClient({ chain, transport, account: addresses[0] });
  const deploy = async (artifact, args = []) => {
    const hash = await owner.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`,
      args, gas: 6_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const sendOwner = async (artifact, address, functionName, args = [], value = 0n) => {
    const hash = await owner.writeContract({ address, abi: artifact.abi, functionName, args, value, gas: 2_000_000n });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success', functionName);
  };
  const token = await deploy(artifacts.MockChog), entropy = await deploy(artifacts.MockEntropy);
  const vault = await deploy(artifacts.ChogRewardVaultDraft, [addresses[0], token, entropy, addresses[3]]);
  assert.throws(() => ledger.finalizeLocalCampaign(campaignId), /unbatched events/);
  const batch = ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault });
  assert.equal(batch.count, 10); assert.equal(batch.batchId, 0);
  assert.equal(batch.status, 'CANDIDATE_UNPUBLISHED');
  assert.throws(() => ledger.sealLocalCandidateBatch({ campaignId, chainId: 143, vault }), /No fresh/);
  assert.throws(() => proofService.forSession({ campaignId, bearer }), /finalized, reconciled/);
  const seal = ledger.finalizeLocalCampaign(campaignId);
  assert.equal(seal.eventCount, 10); assert.equal(seal.batchCount, 1);
  assert.equal(seal.manifest.provenance, 'LOCAL_TEST_ONLY_NOT_MAINNET');
  assert.equal(ledger.auditLocalCampaign(campaignId).digest, seal.digest);
  assert.deepEqual(ledger.auditLocalCampaign(campaignId).issues, []);
  assert.throws(() => ledger.recordLocalTestEvent(campaignId,
    { ...opened[0], runId: 'b'.repeat(32) }), /not accepting events/);
  assert.throws(() => ledger.finalizeLocalCampaign(campaignId), /already finalized/);
  assert.equal(proofService.forSession({ campaignId, bearer: otherBearer }).length, 0);
  assert.throws(() => proofService.forSession({ campaignId, bearer: otherBearer, wallet: player.address }), /another wallet/);
  let proofs = proofService.forSession({ campaignId, bearer });
  assert.equal(proofs.length, 10);
  assert.ok(proofs.some(item => item.index === 0));
  assert.ok(proofs.every(item => item.root === batch.root && item.status === 'LOCAL_TEST_ONLY'
    && item.recipient === player.address.toLowerCase()));
  ledger.close(); ledger = new ClaimLedger(file, { allowLocalTests: true });
  assert.equal(ledger.observationCount(), 1);
  assert.equal(ledger.claimEventCount(), 10);
  const restartedService = new LocalClaimProofService(ledger, token => sessions.resolve(token));
  proofs = restartedService.forSession({ campaignId, bearer });
  assert.equal(proofs.length, 10, 'Merkle proofs survive a process restart.');
  const snapshotFile = path.join(temp, 'verified-snapshot.sqlite');
  const snapshot = await ledger.snapshotTo(snapshotFile);
  assert.equal(snapshot.observationCount, 1);
  assert.equal(snapshot.localCampaigns, 1);
  assert.equal(snapshot.unattestedLegacyCount, 0);
  const recovered = new ClaimLedger(snapshotFile, { allowLocalTests: true });
  assert.equal(recovered.auditLocalCampaign(campaignId).digest, seal.digest);
  assert.equal(recovered.getLocalProofsForWallet({ campaignId,
    wallet: player.address, sessionAccount: player.address }).length, 10);
  recovered.close();
  await assert.rejects(() => ledger.snapshotTo(snapshotFile), /EEXIST/);
  ledger.db.prepare('UPDATE proofs SET root=? WHERE event_id=?').run(`0x${'1'.repeat(64)}`, proofs[0].eventId);
  assert.throws(() => restartedService.forSession({ campaignId, bearer }), /Missing or altered proof/);
  ledger.db.prepare('UPDATE proofs SET root=? WHERE event_id=?').run(batch.root, proofs[0].eventId);
  proofServer = http.createServer(localProofHttpHandler(restartedService));
  await new Promise(resolve => proofServer.listen(0, '127.0.0.1', resolve));
  const proofUrl = `http://127.0.0.1:${proofServer.address().port}/local-test/claims/proofs?campaignId=${campaignId}`;
  assert.equal((await fetch(proofUrl)).status, 401, 'HTTP proofs require a signed local-test wallet.');
  assert.equal((await fetch(proofUrl, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${proofUrl}&wallet=${player.address}`, {
    headers: { authorization: `Bearer ${otherBearer}` } })).status, 403);
  const response = await fetch(proofUrl, { headers: { authorization: `Bearer ${bearer}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const served = await response.json();
  assert.equal(served.mainnetClaimable, false);
  assert.equal(served.proofs.length, 10);
  assert.deepEqual(served.proofs, proofs, 'Only the signed wallet receives its durable proof set.');

  // Candidate proofs alone cannot move tokens; only the test owner may commit
  // a root, supply mock funding and pay the mock oracle's fee.
  const sponsorProvider = { request: ({ method, params }) => method === 'eth_requestAccounts'
    ? Promise.resolve([addresses[2]]) : provider.request({ method, params }) };
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, {
    vault, claim: proofs[0], expectedToken: token, allowSponsor: true }), /Claim root differs/);
  await sendOwner(artifacts.MockChog, token, 'mint', [addresses[0], 1_000n * 10n ** 18n]);
  await sendOwner(artifacts.MockChog, token, 'transfer', [vault, 1_000n * 10n ** 18n]);
  await sendOwner(artifacts.ChogRewardVaultDraft, vault, 'setNewBatchesPaused', [false]);
  const fee = await client.readContract({ address: vault, abi: artifacts.ChogRewardVaultDraft.abi,
    functionName: 'currentEntropyFee' });
  await sendOwner(artifacts.ChogRewardVaultDraft, vault, 'commitBatch',
    [batch.root, batch.count, keccak256(toHex('local-only-owner-contribution'))], fee);
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, {
    vault, claim: proofs[0], expectedToken: token, allowSponsor: true }), /Oracle seed is not ready/);
  await sendOwner(artifacts.MockEntropy, entropy, 'fulfill', [1n, keccak256(toHex('local-only-provider-seed'))]);
  const readCredit = () => client.readContract({ address: vault, abi: artifacts.ChogRewardVaultDraft.abi,
    functionName: 'creditOf', args: [player.address] });
  await assert.rejects(() => sendWalletWithdrawal(sponsorProvider, { vault,
    recipient: player.address, expectedToken: token, allowSponsor: true }), /no on-chain CHOG credits/);
  let firstPayout = 0n;
  for (const [index, proof] of proofs.entries()) {
    const hash = await sendWalletRedeem(sponsorProvider, { vault, claim: proof,
      expectedToken: token, allowSponsor: true });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
    if (index === 0) {
      firstPayout = await readCredit();
      assert.ok([5n, 10n, 25n].includes(firstPayout / 10n ** 18n));
      const early = await sendWalletWithdrawal(sponsorProvider, { vault,
        recipient: player.address, expectedToken: token, allowSponsor: true });
      assert.equal((await client.waitForTransactionReceipt({ hash: early })).status, 'success');
      assert.equal(await readCredit(), 0n);
      assert.equal(await client.readContract({ address: token, abi: artifacts.MockChog.abi,
        functionName: 'balanceOf', args: [player.address] }), firstPayout);
    }
  }
  const credit = await readCredit();
  assert.ok(credit > 0n && credit <= 225n * 10n ** 18n);
  assert.equal(await client.getBalance({ address: player.address }), 0n, 'Recipient pays no MON gas.');
  await assert.rejects(() => sendWalletRedeem(sponsorProvider, { vault, claim: proofs[0],
    expectedToken: token, allowSponsor: true }), /revert/i, 'A published proof still cannot be redeemed twice.');
  const withdrawal = await sendWalletWithdrawal(sponsorProvider, { vault, recipient: player.address,
    expectedToken: token, allowSponsor: true });
  assert.equal((await client.waitForTransactionReceipt({ hash: withdrawal })).status, 'success');
  assert.equal(await readCredit(), 0n);
  assert.equal(await client.readContract({ address: token, abi: artifacts.MockChog.abi,
    functionName: 'balanceOf', args: [player.address] }), credit + firstPayout);
  assert.equal(ledger.observationCount(), 1, 'Preview observation was never paid.');
  assert.equal(ledger.claimEventCount(), 10);
  ledger.startLocalCampaign('LOCAL_TEST_ANOTHER');
  assert.throws(() => ledger.recordLocalTestEvent('LOCAL_TEST_ANOTHER', opened[0]),
    /cannot be replayed in another campaign/);
  assert.equal(ledger.claimEventCount(), 10);

  // Corrupt data is refused rather than silently reset to an empty journal.
  await writeFile(path.join(temp, 'broken.sqlite'), 'not a sqlite database');
  assert.throws(() => new ClaimLedger(path.join(temp, 'broken.sqlite')), /database|malformed/i);
  console.log('PASS: durable isolated local-test box events + wallet-auth proof service + restart/replay isolation + sponsored mock CHOG claim/withdrawal');
} finally {
  if (proofServer) { proofServer.closeAllConnections(); await new Promise(resolve => proofServer.close(resolve)); }
  if (hub) hub.close();
  if (ledger?.db.open) ledger.close();
  if (provider) await provider.disconnect();
  await rm(temp, { recursive: true, force: true });
}
