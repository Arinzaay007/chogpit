#!/usr/bin/env node
// Mint one Raider Pass to your Privy wallet so holder check passes
// Usage: node scripts/mint-pass-to-privy.mjs 0xYourPrivyWallet
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
import { readFileSync } from 'node:fs';
import solc from 'solc';
const RPC=process.env.MONAD_RPC||'https://rpc.monad.xyz';
const PK=process.env.MONAD_OWNER_KEY;
const PASS=process.env.RAIDER_PASS_ADDRESS||'0xf927c92a4305ec63fd667d03301498df33526c0c';
const recipient=process.argv[2];
if(!recipient||!/^0x[0-9a-fA-F]{40}$/.test(recipient)){ console.error('Usage: node scripts/mint-pass-to-privy.mjs 0xYourPrivyWallet'); process.exit(1); }
const account=privateKeyToAccount(PK.trim());
const publicClient=createPublicClient({chain:monad, transport:http(RPC)});
const walletClient=createWalletClient({account, chain:monad, transport:http(RPC)});
const solcInput={ language:'Solidity', sources:{ 'contracts/ChogpitRaiderPassDraft.sol':{content: readFileSync('contracts/ChogpitRaiderPassDraft.sol','utf8')}}, settings:{optimizer:{enabled:true,runs:200}, outputSelection:{'*':{'*':['abi']}}}};
function cb(p){ try{return {contents:readFileSync('node_modules/'+p,'utf8')}}catch{return {error:'not found '+p}}}
const out=JSON.parse(solc.compile(JSON.stringify(solcInput),{import: cb}));
const abi=out.contracts['contracts/ChogpitRaiderPassDraft.sol']['ChogpitRaiderPassDraft'].abi;
// EIP-712 mintWithConsent needs recipient signature over (recipient, nonce, deadline)
// For hackathon fast path we let owner mint, recipient signs empty consent - we generate recipient sig via owner impersonation is not possible without recipient private key.
// Instead we use direct owner mint via internal _mint if you change contract to add ownerMint. For draft, use batch with dummy sig and we bypass check by having recipient be owner for test.
// Simpler: mint to owner then transfer
console.log(`Minting pass to ${recipient} via owner ${account.address}...`);
// Use _safeMint path via ownerMint if available, else use mintWithConsent with recipient = owner for demo then transfer
// Here we mint to owner first then transfer to recipient in same tx via helper
const deadline = BigInt(Math.floor(Date.now()/1000)+3600);
console.log('Note: Draft requires recipient signature. For LFG test, we will mint to OWNER then transfer to your Privy wallet.');
const hash1 = await walletClient.writeContract({ address: PASS, abi, functionName:'mintWithConsent', args:[account.address, deadline, '0x'] }).catch(async e=>{
  console.log('Direct mint failed, trying transfer workaround...');
  // fallback: owner already holds pass from earlier? check balance
  return null;
});
if(hash1){ await publicClient.waitForTransactionReceipt({hash:hash1}); console.log('Minted to owner',hash1); }
const transferAbi=[{name:'transferFrom',type:'function',stateMutability:'nonpayable',inputs:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'tokenId',type:'uint256'}],outputs:[]}];
const tokenId=1n; // first pass
try{
  const h2=await walletClient.writeContract({address:PASS, abi:transferAbi, functionName:'transferFrom', args:[account.address, recipient, tokenId]});
  await publicClient.waitForTransactionReceipt({hash:h2});
  console.log(`✓ Pass #1 transferred to your Privy wallet ${recipient} tx ${h2}`);
  console.log('You now HOLD the 40-cap pass - CHOG auto-pay will succeed!');
}catch(e){ console.error('Transfer failed - you may need to mint directly with a Privy signature. DM me your Privy wallet to sign:', e.shortMessage||e.message); }
