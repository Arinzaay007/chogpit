#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
import solc from 'solc';

const RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const PK = process.env.MONAD_OWNER_KEY;
if (!PK || !/^0x[0-9a-fA-F]{64}$/.test(PK.trim())) {
  console.error('Set MONAD_OWNER_KEY=0x... (64 hex, owner wallet, never share).');
  process.exit(1);
}
const provider = process.env.ENTROPY_PROVIDER;
const entropy = process.env.ENTROPY_ADDRESS;
const chog = process.env.CHOG_TOKEN || '0x350035555e10d9afaf1566aaebfced5ba6c27777';
const account = privateKeyToAccount(PK.trim());
const publicClient = createPublicClient({ chain: monad, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: monad, transport: http(RPC) });

function findFile(importPath){
  // resolve @openzeppelin/* from node_modules
  const tries=[path.resolve(importPath), path.resolve('node_modules', importPath)];
  for(const p of tries) if(existsSync(p)) return p;
  return null;
}
function compile(sourcePath){
  const source=readFileSync(sourcePath,'utf8');
  const input={ language:'Solidity', sources:{ [sourcePath]:{content:source}}, settings:{ optimizer:{enabled:true,runs:200}, outputSelection:{'*':{'*':['abi','evm.bytecode']}} } };
  function importCb(p){
    const f=findFile(p);
    if(f) return {contents: readFileSync(f,'utf8')};
    return {error: 'File not found: '+p};
  }
  const out=JSON.parse(solc.compile(JSON.stringify(input),{import: importCb}));
  if(out.errors) for(const e of out.errors) if(e.severity==='error') console.error(e.formattedMessage); else console.log(e.formattedMessage);
  if(!out.contracts || !out.contracts[sourcePath]){ console.error('Compile failed, no output for',sourcePath); console.error(JSON.stringify(out,null,2).slice(0,2000)); process.exit(1); }
  const contractName=Object.keys(out.contracts[sourcePath])[0];
  const {abi, evm}=out.contracts[sourcePath][contractName];
  return {abi, bytecode:`0x${evm.bytecode.object}`};
}
async function deployPass(){
  console.log('Compiling Raider Pass (40 cap)...');
  const {abi,bytecode}=compile('contracts/ChogpitRaiderPassDraft.sol');
  console.log(`Deploying as Raider Pass owner ${account.address} ...`);
  const hash=await walletClient.deployContract({abi,bytecode,args:[account.address]});
  const rc=await publicClient.waitForTransactionReceipt({hash});
  console.log(`✓ Raider Pass deployed: ${rc.contractAddress} tx ${hash}`);
  return rc.contractAddress;
}
async function deployVault(passAddr){
  console.log('Compiling Holder-Aware Vault (owner-recover hackathon)...');
  const {abi,bytecode}=compile('contracts/ChogRewardVaultHolderAwareOwnerRecoverDraft.sol');
  if(!provider||!entropy){ console.warn('⚠ ENTROPY not set - using placeholder, do not fund until real addresses set'); }
  console.log(`Deploying Vault (owner ${account.address}, pass ${passAddr}) ...`);
  const hash=await walletClient.deployContract({abi,bytecode,args:[account.address,account.address,chog, entropy||'0x0000000000000000000000000000000000000000', provider||'0x0000000000000000000000000000000000000000', passAddr]});
  const rc=await publicClient.waitForTransactionReceipt({hash});
  console.log(`✓ Vault deployed: ${rc.contractAddress} tx ${hash}`);
  return rc.contractAddress;
}
const pass=await deployPass();
const vault=await deployVault(pass);
console.log('\n--- paste into your host .env (NEVER commit key) ---');
console.log(`RAIDER_PASS_ADDRESS=${pass}`);
console.log(`VAULT_ADDRESS=${vault}`);
console.log('Verify both on https://monadscan.com then fund vault with 1,000 CHOG only after verification.');
