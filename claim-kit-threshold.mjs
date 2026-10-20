// Merkle leaves for the unreviewed 50-CHOG auto-payout + multi-epoch vault.
// Separate from the old no-minimum draft's six-field leaf format.
import { concatHex, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const HASH = /^0x[a-fA-F0-9]{64}$/;
const INPUT = new Set(['eventId', 'recipient']);
const TYPES = [
  { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
  { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }
];
export function thresholdPairHash(left, right) {
  if (!HASH.test(left) || !HASH.test(right)) throw new Error('Expected bytes32 Merkle nodes.');
  const a = left.toLowerCase(), b = right.toLowerCase();
  return keccak256(concatHex(a < b ? [a, b] : [b, a]));
}
export function candidateThresholdBatch({ chainId, vault, epochId, batchId, entries }) {
  if (chainId !== 143 || !Number.isSafeInteger(epochId) || epochId < 0
    || !Number.isSafeInteger(batchId) || batchId < 0
    || !Array.isArray(entries) || entries.length < 1 || entries.length > 40)
    throw new Error('A threshold batch needs chain 143 and 1–40 fresh entries.');
  const address = getAddress(vault), seen = new Set();
  const list = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !INPUT.has(key)) || !HASH.test(entry.eventId)
      || /^0x0{64}$/i.test(entry.eventId))
      throw new Error('Only fresh eventId/recipient pairs are accepted; preview records and amounts are forbidden.');
    const eventId = entry.eventId.toLowerCase();
    if (seen.has(eventId)) throw new Error('Duplicate event ID in threshold batch.');
    seen.add(eventId);
    const recipient = getAddress(entry.recipient);
    const leaf = keccak256(encodeAbiParameters(TYPES,
      [143n, address, BigInt(epochId), BigInt(batchId), BigInt(index), recipient, eventId]));
    return { index, eventId, recipient, leaf };
  });
  const levels = [list.map(entry => entry.leaf)];
  while (levels.at(-1).length > 1) {
    const previous = levels.at(-1), parents = [];
    for (let i = 0; i < previous.length; i += 2)
      parents.push(thresholdPairHash(previous[i], previous[i + 1] ?? previous[i]));
    levels.push(parents);
  }
  const root = levels.at(-1)[0];
  const claims = list.map((item, originalIndex) => {
    const proof = [];
    let index = originalIndex;
    for (let level = 0; level < levels.length - 1; level++) {
      proof.push(levels[level][index ^ 1] ?? levels[level][index]);
      index = Math.floor(index / 2);
    }
    if (proof.reduce(thresholdPairHash, item.leaf) !== root)
      throw new Error('Threshold Merkle proof construction failed.');
    return { ...item, proof };
  });
  return { chainId, vault: address, epochId, batchId, root, entries: claims,
    warning: 'UNREVIEWED CANDIDATE. A root is not proof of lawful, complete eligibility.' };
}
