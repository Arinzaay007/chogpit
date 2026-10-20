#!/usr/bin/env node
// Pull CHOG back from owner-recover vault (hackathon only)
// Usage:
//   $env:MONAD_RPC="https://rpc.monad.xyz"
//   $env:MONAD_OWNER_KEY="0x..."
//   node scripts/pull-vault.mjs 0xYourNewVaultAddress 0xYourWalletToReceive 1000
// amount in whole CHOG (e.g. 1000 = 1000 CHOG)
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';

const [vault, to, amountStr] = process.argv.slice(2);
if (!vault || !to || !amountStr) {
  console.error('Usage: node scripts/pull-vault.mjs 0xVault 0xTo 1000');
  process.exit(1);
}
const RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const PK = process.env.MONAD_OWNER_KEY;
if (!PK) { console.error('Set MONAD_OWNER_KEY'); process.exit(1); }
const account = privateKeyToAccount(PK.trim());
const publicClient = createPublicClient({ chain: monad, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: monad, transport: http(RPC) });
const abi = [{ name:'ownerRecover', type:'function', stateMutability:'nonpayable', inputs:[{name:'to',type:'address'},{name:'amount',type:'uint256'}], outputs:[]}];
const amount = parseEther(amountStr);
console.log(`Pulling ${amountStr} CHOG from ${vault} → ${to} as ${account.address} ...`);
const hash = await walletClient.writeContract({ address: vault, abi, functionName:'ownerRecover', args:[to, amount] });
console.log('tx', hash);
const rc = await publicClient.waitForTransactionReceipt({ hash });
console.log('confirmed, status', rc.status);
