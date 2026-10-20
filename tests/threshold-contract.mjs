import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ganache from 'ganache';
import solc from 'solc';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, custom, encodeAbiParameters,
  keccak256, toHex } from 'viem';
import { candidateThresholdBatch } from '../claim-kit-threshold.mjs';
import { capacityPermitTypedData } from '../sponsor-threshold.mjs';

// Disposable local chain only. No actual Monad signer, CHOG, pool or relayer.
const [source, mocks] = await Promise.all([
  readFile(new URL('../contracts/ChogRewardVaultThresholdDraft.sol', import.meta.url), 'utf8'),
  readFile(new URL('../contracts/test/Mocks.sol', import.meta.url), 'utf8')
]);
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
  sources: { 'Threshold.sol': { content: source }, 'Mocks.sol': { content: mocks } },
  settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
if (compiled.errors?.some(item => item.severity === 'error'))
  throw Error(compiled.errors.map(item => item.formattedMessage).join('\n'));
const artifacts = { ...compiled.contracts['Threshold.sol'], ...compiled.contracts['Mocks.sol'] };
const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 143 },
  wallet: { totalAccounts: 4, defaultBalance: 1000 } });
try {
  const accounts = await provider.request({ method: 'eth_accounts' });
  const player = privateKeyToAccount(`0x${'3a'.repeat(32)}`); // disposable deterministic test key
  const sponsorAddress = accounts[1], ownerAddress = accounts[0];
  const ownerSigner = privateKeyToAccount(provider.getInitialAccounts()[ownerAddress.toLowerCase()].secretKey);
  const chain = { id: 143, name: 'Disposable threshold test',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: ['http://local.invalid'] } } };
  const transport = custom(provider), client = createPublicClient({ chain, transport });
  const owner = createWalletClient({ chain, transport, account: ownerAddress });
  const sponsor = createWalletClient({ chain, transport, account: sponsorAddress });
  const deploy = async (artifact, args = []) => {
    const hash = await owner.deployContract({ abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`, args, gas: 6_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success'); return receipt.contractAddress;
  };
  const write = async (wallet, artifact, address, fn, args = [], value = 0n) => {
    const hash = await wallet.writeContract({ address, abi: artifact.abi, functionName: fn,
      args, value, gas: 2_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `${fn} must succeed`);
  };
  const token = await deploy(artifacts.MockChog), entropy = await deploy(artifacts.MockEntropy);
  const vault = await deploy(artifacts.ChogRewardVaultThresholdDraft,
    [ownerAddress, sponsorAddress, token, entropy, accounts[3]]);
  const read = (fn, args = []) => client.readContract({ address: vault,
    abi: artifacts.ChogRewardVaultThresholdDraft.abi, functionName: fn, args });
  const permit = async (epochId, batchId, root, entries, userRandomNumber) => {
    const deadline = BigInt(Math.floor(Date.now()/1000) + 3600);
    const signature = await ownerSigner.signTypedData({
      domain: { name: 'CHOGPIT Threshold', version: '2', chainId: 143, verifyingContract: vault },
      types: { BatchPermit: [
        { name: 'epochId', type: 'uint256' }, { name: 'batchId', type: 'uint256' },
        { name: 'root', type: 'bytes32' }, { name: 'entries', type: 'uint32' },
        { name: 'userRandomNumber', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }
      ] }, primaryType: 'BatchPermit', message: { epochId: BigInt(epochId),
        batchId: BigInt(batchId), root, entries, userRandomNumber, deadline }
    });
    return [BigInt(epochId), root, entries, userRandomNumber, deadline, signature];
  };
  const capacity = async (epochId, slots) => {
    const deadline = BigInt(Math.floor(Date.now()/1000) + 3600);
    const nonce = await read('capacityPermitNonce');
    const signature = await ownerSigner.signTypedData(capacityPermitTypedData({
      chainId:143,vault,epochId,slots,nonce,deadline}));
    return [BigInt(epochId),slots,deadline,signature];
  };
  const balance = address => client.readContract({ address: token,
    abi: artifacts.MockChog.abi, functionName: 'balanceOf', args: [address] });
  const ether = 10n ** 18n, fee = await read('currentEntropyFee');
  assert.equal(await read('PAYOUT_THRESHOLD'), 50n * ether);
  assert.equal(await read('newBatchesPaused'), true);
  assert.equal(await read('currentEpochId'), 0n);
  assert.equal(await client.getBalance({ address: player.address }), 0n);
  await write(owner, artifacts.MockChog, token, 'mint', [ownerAddress, 1000n * ether]);
  await write(owner, artifacts.MockChog, token, 'transfer', [vault, 1000n * ether]);
  await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'purchaseCapacity', await capacity(0,1));
  assert.equal(await read('totalPendingCapacity'),25n*ether,
    'The owner-signed opening slot is backed before any player opens.');
  const firstEvent = keccak256(toHex('fresh-epoch-zero-box'));
  const batch0 = candidateThresholdBatch({ chainId: 143, vault, epochId: 0, batchId: 0,
    entries: [{ eventId: firstEvent, recipient: player.address }] });
  const args0 = await permit(0,0,batch0.root,1,firstEvent);
  await assert.rejects(() => write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'commitBatch', args0, fee), /revert/i, 'Draft starts paused.');
  await write(owner, artifacts.ChogRewardVaultThresholdDraft, vault, 'setNewBatchesPaused', [false]);
  const stranger = createWalletClient({chain,transport,account:accounts[2]});
  await assert.rejects(() => write(stranger,artifacts.ChogRewardVaultThresholdDraft,vault,
    'commitBatch',args0,fee), /revert/i, 'Only owner/authorized operator may publish.');
  const fakeArgs0 = [...args0.slice(0,5), await privateKeyToAccount(`0x${'4b'.repeat(32)}`)
    .signTypedData({domain:{name:'CHOGPIT Threshold',version:'2',chainId:143,verifyingContract:vault},
      types:{BatchPermit:[{name:'epochId',type:'uint256'},{name:'batchId',type:'uint256'},
        {name:'root',type:'bytes32'},{name:'entries',type:'uint32'},
        {name:'userRandomNumber',type:'bytes32'},{name:'deadline',type:'uint256'}]},
      primaryType:'BatchPermit',message:{epochId:0n,batchId:0n,root:batch0.root,
        entries:1,userRandomNumber:firstEvent,deadline:args0[4]}})];
  await assert.rejects(() => write(sponsor,artifacts.ChogRewardVaultThresholdDraft,vault,
    'commitBatch',fakeArgs0,fee), /revert/i, 'Operator cannot publish an unsigned root.');
  await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'commitBatch', args0, fee);
  assert.equal(await read('leafFor', [0n, 0n, player.address, firstEvent]), batch0.entries[0].leaf);
  const roll = (seed, epochId, batchId, index, eventId) => BigInt(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'address' }, { type: 'bytes32' }
  ], [seed, BigInt(epochId), BigInt(batchId), BigInt(index), player.address, eventId]))) % 100n;
  let firstSeed;
  for (let i = 0; i < 1000; i++) {
    const seed = keccak256(toHex(`first-local-seed-${i}`));
    if (roll(seed, 0, 0, 0, firstEvent) < 70n) { firstSeed = seed; break; }
  }
  assert.ok(firstSeed);
  await write(owner, artifacts.MockEntropy, entropy, 'fulfill', [1n, firstSeed]);
  await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'redeem', [0n, 0n, player.address, firstEvent, []]);
  assert.equal(await read('creditOf', [player.address]), 5n * ether);
  assert.equal(await balance(player.address), 0n, 'Five CHOG is a carried credit, not an early payout.');
  assert.equal(await read('outstandingCredits'), 5n * ether);
  await assert.rejects(() => write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'redeem', [0n, 0n, player.address, firstEvent, []]), /revert/i, 'The same event cannot pay twice.');
  await write(owner, artifacts.ChogRewardVaultThresholdDraft, vault, 'closeCurrentEpoch');
  await assert.rejects(() => write(owner, artifacts.ChogRewardVaultThresholdDraft, vault,
    'openNextEpoch', [1000n * ether]), /revert/i,
  'A new 1,000-CHOG budget cannot spend the earlier five-CHOG liability.');
  await write(owner, artifacts.MockChog, token, 'mint', [ownerAddress, 1000n * ether]);
  await write(owner, artifacts.MockChog, token, 'transfer', [vault, 1000n * ether]);
  await write(owner, artifacts.ChogRewardVaultThresholdDraft, vault, 'openNextEpoch', [1000n * ether]);
  assert.equal(await read('currentEpochId'), 1n);
  assert.equal(await read('newBatchesPaused'), true, 'Future epochs pause until the owner explicitly unpauses.');
  await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'purchaseCapacity', await capacity(1,9));
  await write(owner, artifacts.ChogRewardVaultThresholdDraft, vault, 'setNewBatchesPaused', [false]);
  const eventIds = Array.from({ length: 9 }, (_, i) => keccak256(toHex(`fresh-epoch-one-box-${i}`)));
  const batch1 = candidateThresholdBatch({ chainId: 143, vault, epochId: 1, batchId: 1,
    entries: eventIds.map(eventId => ({ eventId, recipient: player.address })) });
  const commitment1 = keccak256(toHex('sponsor-seed-epoch-one'));
  const args1 = await permit(1,1,batch1.root,9,commitment1);
  await assert.rejects(() => write(sponsor,artifacts.ChogRewardVaultThresholdDraft,vault,
    'commitBatch',[...args1.slice(0,2),8,...args1.slice(3)],fee),/revert/i,
    'A signature authorizes the exact number of recipients.');
  await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault,
    'commitBatch', args1, fee);
  assert.equal(await read('leafFor', [1n, 0n, player.address, eventIds[0]]), batch1.entries[0].leaf);
  let seed1;
  for (let i = 0; i < 100000; i++) {
    const candidate = keccak256(toHex(`nine-five-outcomes-${i}`));
    if (eventIds.every((eventId, index) => roll(candidate, 1, 1, index, eventId) < 70n)) {
      seed1 = candidate; break;
    }
  }
  assert.ok(seed1, 'A mock seed can be found to exercise the 50-CHOG boundary.');
  await write(owner, artifacts.MockEntropy, entropy, 'fulfill', [2n, seed1]);
  for (let index = 0; index < 8; index++) {
    await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault, 'redeem',
      [1n, BigInt(index), player.address, eventIds[index], batch1.entries[index].proof]);
  }
  assert.equal(await read('creditOf', [player.address]), 45n * ether);
  assert.equal(await balance(player.address), 0n);
  await write(sponsor, artifacts.ChogRewardVaultThresholdDraft, vault, 'redeem',
    [1n, 8n, player.address, eventIds[8], batch1.entries[8].proof]);
  assert.equal(await balance(player.address), 50n * ether,
    'The sponsor-triggered tenth box automatically sends the accumulated CHOG.');
  assert.equal(await read('creditOf', [player.address]), 0n);
  assert.equal(await read('outstandingCredits'), 0n);
  assert.equal(await read('totalPaidOut'), 50n * ether);
  assert.equal(await client.getBalance({ address: player.address }), 0n,
    'No player-paid MON was needed to receive the automatic transfer.');
  assert.equal((await read('epochs', [0n]))[1], 5n * ether);
  assert.equal((await read('epochs', [1n]))[1], 45n * ether);
  assert.throws(() => candidateThresholdBatch({ chainId: 143, vault, epochId: 1, batchId: 2,
    entries: [{ eventId: eventIds[0], recipient: player.address, previewBalance: 50 }] }),
  /preview records and amounts/);
  console.log('PASS: new 50-CHOG vault draft carries five-CHOG credit across funded epochs, blocks early payout, and auto-sends at 50 with sponsor gas and zero player MON');
} finally { await provider.disconnect(); }
