// Candidate Merkle/proof builder for a NEW future campaign. It is deliberately
// NOT connected to reward-preview.mjs or the currently running game. A root
// proves a precommitted list, NOT that these off-chain game events were genuine
// or fairly included. Independent review and a durable event source are needed.
import { concatHex, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const WORD = /^0x[a-fA-F0-9]{64}$/;
const EVENT_FIELDS = new Set(['eventId', 'recipient']);
const LEAF_TYPES = [
  { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
  { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }
];

export function pairHash(left, right) {
  if (!WORD.test(left) || !WORD.test(right)) throw new Error('Expected two bytes32 Merkle nodes.');
  const [a, b] = left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left];
  return keccak256(concatHex([a, b]));
}

export function candidateClaimBatch({ chainId, vault, batchId, entries }) {
  if (chainId !== 143 && chainId !== 31337) throw new Error('Only explicitly chosen Monad/local claim chains are supported.');
  if (!Number.isSafeInteger(batchId) || batchId < 0) throw new Error('Invalid batch number.');
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 40) throw new Error('A batch needs 1–40 fresh events.');
  const address = getAddress(vault);
  const used = new Set();
  const list = entries.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !EVENT_FIELDS.has(key))) {
      throw new Error('Only fresh eventId/recipient pairs are accepted; preview records and amounts are forbidden.');
    }
    if (!WORD.test(input.eventId) || /^0x0{64}$/i.test(input.eventId)) throw new Error('Event ID must be a nonzero bytes32.');
    const eventId = input.eventId.toLowerCase();
    if (used.has(eventId)) throw new Error('An event may appear only once in this batch.');
    used.add(eventId);
    const recipient = getAddress(input.recipient);
    const leaf = keccak256(encodeAbiParameters(LEAF_TYPES,
      [BigInt(chainId), address, BigInt(batchId), BigInt(index), recipient, eventId]));
    return { index, eventId, recipient, leaf };
  });
  const levels = [list.map(entry => entry.leaf)];
  while (levels.at(-1).length > 1) {
    const row = levels.at(-1), parents = [];
    for (let i = 0; i < row.length; i += 2) parents.push(pairHash(row[i], row[i + 1] ?? row[i]));
    levels.push(parents);
  }
  const root = levels.at(-1)[0];
  const proofs = list.map((entry, index) => {
    const proof = [];
    for (let level = 0; level < levels.length - 1; level++) {
      proof.push(levels[level][index ^ 1] ?? levels[level][index]);
      index = Math.floor(index / 2);
    }
    if (proof.reduce(pairHash, entry.leaf) !== root) throw new Error('Merkle construction failed.');
    return { ...entry, proof };
  });
  return { chainId, vault: address, batchId, root, entries: proofs,
    warning: 'CANDIDATE ROOT ONLY. Not evidence of prize eligibility; never import preview balances.' };
}
