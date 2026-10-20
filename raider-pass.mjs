// OFFLINE/ISOLATED HELPER. This creates a non-spending typed mint consent for
// the prospective CHOGPIT pass contract. No signer, relayer, mainnet transaction
// or CHOG payout service is mounted by the public game.
import { getAddress } from 'viem';

export const RAIDER_PASS_CHAIN_ID = 143;
export const RAIDER_PASS_NAME = 'CHOGPIT Raider Pass';
export const RAIDER_PASS_VERSION = '1';

export function raiderPassClaimTypedData({ recipient, contract, nonce, deadline, chainId = RAIDER_PASS_CHAIN_ID }) {
  if (!Number.isInteger(chainId) || chainId <= 0) throw Error('Invalid chain ID.');
  const expected = typeof nonce === 'bigint' ? nonce : BigInt(nonce);
  const expires = typeof deadline === 'bigint' ? deadline : BigInt(deadline);
  if (expected < 0n || expires <= 0n) throw Error('Invalid nonce or deadline.');
  return {
    domain: { name: RAIDER_PASS_NAME, version: RAIDER_PASS_VERSION,
      chainId, verifyingContract: getAddress(contract) },
    primaryType: 'Claim',
    types: { Claim: [
      { name: 'recipient', type: 'address' }, { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ] },
    message: { recipient: getAddress(recipient), nonce: expected, deadline: expires }
  };
}
