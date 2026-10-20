#!/usr/bin/env node
// Read-only local engineering audit. Never redeems, commits a root, deploys, or
// converts preview observations into CHOG. Exported manifests contain test
// wallet addresses: keep them private and retain a copy OFF the game server.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { inspectJournal, inspectObservations, inspectLocalCampaign } from '../claim-audit.mjs';

const argv = process.argv.slice(2);
const usage = 'Usage: node scripts/audit_claim_journal.mjs <existing.sqlite> [--campaign LOCAL_TEST_ID] [--export new-manifest.json]';
if (!argv[0] || argv.some((arg, i) => i > 0 && arg.startsWith('--')
  && !['--campaign', '--export'].includes(arg)) || (argv.length - 1) % 2) {
  console.error(usage); process.exit(1);
}
const options = {};
for (let i = 1; i < argv.length; i += 2) {
  if (!['--campaign', '--export'].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) {
    console.error(usage); process.exit(1);
  }
  options[argv[i]] = argv[i + 1];
}
if (options['--export'] && !options['--campaign']) { console.error(usage); process.exit(1); }
let db;
try {
  db = new Database(path.resolve(argv[0]), { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  const report = db.transaction(() => {
    const sqlite = db.pragma('quick_check(1)', { simple: true });
    const foreignKeys = db.pragma('foreign_key_check');
    const journal = inspectJournal(db), observations = inspectObservations(db, journal);
    const campaigns = options['--campaign'] ? [options['--campaign']]
      : db.prepare('SELECT campaign_id FROM campaigns ORDER BY campaign_id').all().map(row => row.campaign_id);
    const tests = campaigns.map(campaignId => inspectLocalCampaign(db, campaignId));
    const issues = [...journal.issues, ...observations.issues,
      ...tests.flatMap(item => item.issues),
      ...(sqlite === 'ok' ? [] : ['SQLite quick_check failed.']),
      ...foreignKeys.map(() => 'Foreign-key integrity failed.')];
    return { sqlite, journal, observations, tests, issues };
  })();
  const summary = { kind: 'CHOGPIT_READ_ONLY_AUDIT_V1', mainnetClaimable: false,
    sqlite: report.sqlite, journalEntries: report.journal.count, journalHead: report.journal.head,
    previewObservations: report.observations.observationCount,
    unattestedLegacyObservations: report.observations.unattestedLegacyCount,
    campaigns: report.tests.map(item => ({ id: item.campaignId, state: item.state,
      events: item.eventCount, pending: item.pendingCount, candidateBatches: item.batchCount,
      manifestDigest: item.digest, issueCount: item.issues.length })),
    issueCount: report.issues.length, issues: report.issues.slice(0, 30) };
  if (options['--export']) {
    const selected = report.tests[0];
    if (report.issues.length || selected.state !== 'sealed')
      throw new Error('Refusing export: reconcile all events and finalize the LOCAL_TEST campaign first.');
    await writeFile(path.resolve(options['--export']), JSON.stringify({
      warning: 'LOCAL TEST ONLY — not real CHOG eligibility or a published on-chain root.',
      manifest: selected.manifest, digest: selected.digest,
      journalHeadAtExport: report.journal.head, mainnetClaimable: false
    }, null, 2), { flag: 'wx', mode: 0o600 });
    summary.exported = path.resolve(options['--export']);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (report.issues.length) process.exitCode = 2;
} catch (error) {
  console.error(`Audit refused: ${error.message}`); process.exitCode = 1;
} finally { db?.close(); }
