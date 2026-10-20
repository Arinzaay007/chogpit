// Test-only fetch shim for a local Monad ERC-721 ownerOf/tokenURI + IPFS gateway.
// Imported into the spawned Node game via --import; NEVER packaged for deploy.
import { readFileSync } from 'node:fs';
import { encodeFunctionResult, parseAbi } from 'viem';

const originalFetch = globalThis.fetch;
const ownerAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);
const uriAbi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
const balanceAbi = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const traits = {
  '1': [{ trait_type: 'Background', value: 'Cinder' }, { trait_type: 'Aura', value: 'Amber' }, { trait_type: 'Skin', value: 'Moss' }],
  '2': [{ trait_type: 'Background', value: 'Moon' }, { trait_type: 'Aura', value: 'Static' }, { trait_type: 'Skin', value: 'Moss' }],
  '100': [{ trait_type: 'Background', value: 'Lemon' }, { trait_type: 'Aura', value: 'Cool Aura' },
    { trait_type: 'Base', value: 'Origin' }, { trait_type: 'Skin', value: 'Red' },
    { trait_type: 'Side', value: 'Right' }, { trait_type: 'Body', value: 'Jesus' },
    { trait_type: 'Mouth', value: 'Lip Bite' }, { trait_type: 'Eyes', value: 'Purple laser' },
    { trait_type: 'Head', value: 'Clown Nose' }, { trait_type: 'Form', value: 'Chog' },
    { trait_type: 'Tier', value: 'Common' }, { trait_type: 'Naked', value: 'No' }]
};

function answer(request) {
  if (request.method === 'eth_chainId') return { jsonrpc: '2.0', id: request.id, result: '0x8f' };
  const call = request.params?.[0];
  if (request.method !== 'eth_call' || !call?.data) throw Error(`Unexpected mock RPC method ${request.method}`);
  const selector = call.data.slice(0, 10).toLowerCase();
  const id = BigInt(`0x${call.data.slice(10) || '0'}`).toString();
  const owners = JSON.parse(readFileSync(process.env.CHOGPIT_NFT_TEST_OWNERS, 'utf8'));
  if (selector === '0x6352211e') {
    const owner = owners[id];
    if (!owner) return { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted: nonexistent token' } };
    return { jsonrpc: '2.0', id: request.id, result: encodeFunctionResult({ abi: ownerAbi, functionName: 'ownerOf', result: owner }) };
  }
  if (selector === '0xc87b56dd') {
    if (!owners[id]) return { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted: nonexistent token' } };
    return { jsonrpc: '2.0', id: request.id, result: encodeFunctionResult({ abi: uriAbi, functionName: 'tokenURI', result: `ipfs://mock-chog-collection/${id}.json` }) };
  }
  if (selector === '0x70a08231') return { jsonrpc: '2.0', id: request.id,
    result: encodeFunctionResult({ abi: balanceAbi, functionName: 'balanceOf', result: 0n }) };
  throw Error(`Unexpected mock contract selector ${selector}`);
}

globalThis.fetch = async (input, options = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://rpc.monad.xyz/' || url === 'https://rpc.monad.xyz') {
    const payload = JSON.parse(options.body || await input.clone().text());
    return json(Array.isArray(payload) ? payload.map(answer) : answer(payload));
  }
  const match = /^https:\/\/gateway\.pinata\.cloud\/ipfs\/mock-chog-collection\/(1|2|100)\.json$/.exec(url);
  if (match) return json({ name: `TEST CHOG #${match[1]}`, attributes: traits[match[1]], image: 'ipfs://mock-chog-art/chog.jpg' });
  return originalFetch(input, options);
};
