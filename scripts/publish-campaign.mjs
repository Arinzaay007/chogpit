#!/usr/bin/env node
// Publish CHOG campaign LIVE: unpause vault, set UTC window
// Usage: node scripts/publish-campaign.mjs 2026-10-21T00:00:00Z 2026-10-28T00:00:00Z
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
const RPC=process.env.MONAD_RPC||'https://rpc.monad.xyz';
const PK=process.env.MONAD_OWNER_KEY;
const VAULT=process.env.VAULT_ADDRESS||'0x371aa93574af4bc140537fe21fa656b788239149';
const [start, end] = process.argv.slice(2);
if(!start||!end||isNaN(Date.parse(start))||isNaN(Date.parse(end))) { console.error('Usage: node scripts/publish-campaign.mjs 2026-10-21T00:00:00Z 2026-10-28T00:00:00Z'); process.exit(1); }
if(!PK){ console.error('Set MONAD_OWNER_KEY'); process.exit(1); }
const account=privateKeyToAccount(PK.trim());
const publicClient=createPublicClient({chain:monad, transport:http(RPC)});
const walletClient=createWalletClient({account, chain:monad, transport:http(RPC)});
const abi=[{name:'setPaused',type:'function',stateMutability:'nonpayable',inputs:[{name:'p',type:'bool'}],outputs:[]}];
console.log(`Publishing LIVE window ${start} → ${end} as ${account.address} on vault ${VAULT} ...`);
const hash=await walletClient.writeContract({address:VAULT, abi, functionName:'setPaused', args:[false]});
console.log('tx',hash);
await publicClient.waitForTransactionReceipt({hash});
console.log('✓ Vault unpaused — LIVE');
console.log('Add to game host env:');
console.log(`CAMPAIGN_START=${new Date(start).toISOString()}`);
console.log(`CAMPAIGN_END=${new Date(end).toISOString()}`);
console.log(`VAULT_LIVE=true`);
console.log('Lobby will now show CLAIM LIVE + boxes credit 5/10/25 CHOG (holder-gated at 50).');
