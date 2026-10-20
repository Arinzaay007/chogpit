#!/usr/bin/env node
// Manual private SQLite/WAL point-in-time backup. No network, deployment,
// prize transfer, root publication, or claim activation. Store a copy offline.
import path from 'node:path';
import { ClaimLedger } from '../claim-ledger.mjs';

if (process.argv.length !== 4) {
  console.error('Usage: node scripts/backup_claim_journal.mjs <existing.sqlite> <new-snapshot.sqlite>');
  process.exit(1);
}
let ledger;
try {
  ledger = new ClaimLedger(path.resolve(process.argv[2]), { mustExist: true });
  const result = await ledger.snapshotTo(path.resolve(process.argv[3]));
  console.log(JSON.stringify({ ...result, warning: 'LOCAL STAGING BACKUP ONLY; no mainnet entitlement.' }, null, 2));
} catch (error) {
  console.error(`Backup refused: ${error.message}`);
  process.exitCode = 1;
} finally { if (ledger?.db.open) ledger.close(); }
