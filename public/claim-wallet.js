// Wallet-side mechanics for a FUTURE reviewed CHOG claim campaign.
// This module is intentionally not connected to the current preview UI or an
// active vault. No contract is deployed/funded by importing this file.
// Player wallet transactions require MON gas unless a sponsor submits them.
export const CLAIM_CHAIN_ID = 143;
export const MAINNET_CHOG = '0x350035555e10d9afaf1566aaebfced5ba6c27777';
const SELECTOR = Object.freeze({ chog: '53e1cb05', creditOf: '75807250',
  batches: 'b32c4d8d', redeem: 'b55a526f', withdrawFor: '9eca672c' });
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const cleanAddress = value => {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error('Invalid wallet or vault address.');
  return value.toLowerCase();
};
const bytes32 = value => {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Expected a bytes32 hash.');
  return value.toLowerCase().slice(2);
};
const word = value => {
  const n = BigInt(value);
  if (n < 0n || n >= 2n ** 256n) throw new Error('Invalid claim integer.');
  return n.toString(16).padStart(64, '0');
};
const accountWord = account => cleanAddress(account).slice(2).padStart(64, '0');
const rpc = (wallet, method, params = []) => {
  if (!wallet || typeof wallet.request !== 'function') throw new Error('A wallet or RPC provider is required.');
  return wallet.request({ method, params });
};

export function encodeRedeem({ batchId, index, recipient, eventId, proof }) {
  if (!Number.isSafeInteger(batchId) || batchId < 0 || !Number.isSafeInteger(index) || index < 0 || index >= 40
    || !Array.isArray(proof) || proof.length > 6) throw new Error('Invalid claim proof or batch index.');
  const siblings = proof.map(bytes32);
  // ABI tuple: four static args, dynamic array offset (0xa0), then array length and words.
  return `0x${SELECTOR.redeem}${word(batchId)}${word(index)}${accountWord(recipient)}${bytes32(eventId)}${word(160)}${word(siblings.length)}${siblings.join('')}`;
}
export function encodeWithdrawal(recipient) {
  return `0x${SELECTOR.withdrawFor}${accountWord(recipient)}`;
}

export async function inspectClaimVault(provider, vault, expectedToken = MAINNET_CHOG) {
  const address = cleanAddress(vault), token = cleanAddress(expectedToken);
  const chainId = BigInt(await rpc(provider, 'eth_chainId'));
  if (chainId !== BigInt(CLAIM_CHAIN_ID)) throw new Error('Switch your wallet to Monad mainnet (chain 143).');
  const code = await rpc(provider, 'eth_getCode', [address, 'latest']);
  if (!code || code === '0x') throw new Error('No claim contract code exists at this vault address.');
  const result = await rpc(provider, 'eth_call', [{ to: address, data: `0x${SELECTOR.chog}` }, 'latest']);
  if (typeof result !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(result)
    || cleanAddress(`0x${result.slice(-40)}`) !== token) throw new Error('The vault does not reference the verified CHOG token.');
  return { vault: address, token, chainId: CLAIM_CHAIN_ID };
}
export async function readClaimCredits(provider, vault, recipient, expectedToken = MAINNET_CHOG) {
  const config = await inspectClaimVault(provider, vault, expectedToken);
  const data = `0x${SELECTOR.creditOf}${accountWord(recipient)}`;
  const result = await rpc(provider, 'eth_call', [{ to: config.vault, data }, 'latest']);
  if (typeof result !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(result)) throw new Error('Could not read on-chain claim credits.');
  return BigInt(result);
}
async function caller(provider) {
  const accounts = await rpc(provider, 'eth_requestAccounts');
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('Connect a wallet to submit this transaction.');
  return cleanAddress(accounts[0]);
}
async function send(provider, from, to, data, { allowSponsor = false } = {}) {
  const transaction = { from, to, data, value: '0x0' };
  const estimate = BigInt(await rpc(provider, 'eth_estimateGas', [transaction]));
  if (estimate <= 0n) throw new Error('Invalid gas estimate.');
  const gasLimit = estimate * 12n / 10n + 10_000n;
  // Test helper only. A real relayer still needs its OWN vault allowlist,
  // gas-price/total-budget caps, authenticated requests and abuse controls.
  if (allowSponsor && gasLimit > 500_000n) throw new Error('Sponsor gas limit exceeded.');
  const gas = `0x${gasLimit.toString(16)}`;
  const txHash = await rpc(provider, 'eth_sendTransaction', [{ ...transaction, gas }]);
  if (!HASH.test(txHash)) throw new Error('Wallet returned an invalid transaction hash.');
  return txHash;
}
export async function sendWalletRedeem(provider, { vault, claim, expectedToken = MAINNET_CHOG, allowSponsor = false }) {
  if (!claim || typeof claim !== 'object' || !HASH.test(claim.root)) throw new Error('A published batch root and proof are required.');
  const config = await inspectClaimVault(provider, vault, expectedToken);
  const sender = await caller(provider);
  if (!allowSponsor && sender !== cleanAddress(claim.recipient)) throw new Error('Connected wallet does not match the claim recipient.');
  if (claim.chainId !== config.chainId || cleanAddress(claim.vault) !== config.vault)
    throw new Error('Claim proof domain differs from the selected chain or vault.');
  const batchId = claim.batchId;
  const batchResult = await rpc(provider, 'eth_call', [
    { to: config.vault, data: `0x${SELECTOR.batches}${word(batchId)}` }, 'latest'
  ]);
  if (typeof batchResult !== 'string' || !/^0x(?:[a-fA-F0-9]{64}){6}$/.test(batchResult)) throw new Error('Could not verify the on-chain batch.');
  const fields = batchResult.slice(2).match(/.{64}/g);
  if (`0x${fields[0].toLowerCase()}` !== claim.root.toLowerCase()) throw new Error('Claim root differs from the published vault root.');
  if (BigInt(`0x${fields[5]}`) !== 1n || BigInt(claim.index) >= BigInt(`0x${fields[3]}`)) {
    throw new Error('Oracle seed is not ready, or claim index is outside the batch.');
  }
  return send(provider, sender, config.vault, encodeRedeem(claim), { allowSponsor });
}
export async function sendWalletWithdrawal(provider, { vault, recipient, expectedToken = MAINNET_CHOG, allowSponsor = false }) {
  const config = await inspectClaimVault(provider, vault, expectedToken);
  const sender = await caller(provider), destination = cleanAddress(recipient);
  if (!allowSponsor && sender !== destination) throw new Error('Connected wallet does not match the withdrawal recipient.');
  const credits = await readClaimCredits(provider, config.vault, destination, config.token);
  if (credits === 0n) throw new Error('There are no on-chain CHOG credits to withdraw.');
  return send(provider, sender, config.vault, encodeWithdrawal(destination), { allowSponsor });
}
