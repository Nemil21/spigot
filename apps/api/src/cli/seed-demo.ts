/**
 * `npm run seed:demo` (SP-035): seed the demo cast. Logic and docs in `./seedDemo.ts`.
 *
 *   PAYPAL_MODE=stub npm run seed:demo             # FakePayPal (CI smoke, dev)
 *   npm run seed:demo                              # sandbox: 20 real SIM card top-ups (< 5 min)
 *   npm run seed:demo -- --with-proposals          # also replay the recorded proposal (crawled site)
 *
 * Needs DATABASE_URL, SESSION_SECRET and the PayPal settings; the sandbox run also needs
 * DEMO_PUBLISHER_PAYOUT_EMAIL. Prints ids, emails, the demo logins and the keys the demo site and
 * Claude Desktop need; never PayPal credentials or card numbers. Exits 1 unless every SIM buyer is
 * funded (captured, or the labelled ledger-only fallback) and the ledger check passes.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import { createDb, createPool } from '../db/index.js';
import { loadDotenv } from '../env.js';
import { ledgerCheck } from '../ledger/check.js';
import { topupPayPal } from '../topups/index.js';
import { allFunded, SIM_NO_PAYPAL_LABEL, seedDemo, type SeedDemoResult } from './seedDemo.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    'with-proposals': { type: 'boolean', default: false },
    concurrency: { type: 'string' },
  },
});

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) {
  console.error('--concurrency must be a positive integer');
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL, { max: 8, applicationName: 'spigot-seed-demo' });
const db = createDb(pool);
let exitCode = 0;
try {
  console.log(
    `seed:demo on ${config.PAYPAL_MODE === 'stub' ? 'FakePayPal (stub)' : 'the PayPal sandbox'}`,
  );
  const result = await seedDemo(
    { db, config, pp: topupPayPal(config) },
    { withProposals: values['with-proposals'], concurrency, log: (l) => console.log(`  ${l}`) },
  );
  print(result);
  const check = await ledgerCheck(pool);
  console.log(
    `\nLedger check: ${check.mismatches.length === 0 ? 'OK' : `${check.mismatches.length} mismatch(es)`} (${check.accountsChecked} accounts)`,
  );
  if (check.mismatches.length > 0 || !allFunded(result)) exitCode = 1;
} catch (err) {
  console.error(`seed:demo failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);

function print(r: SeedDemoResult): void {
  const p = r.publisher;
  const s = r.site;
  const lines = [
    '',
    `Publisher  ${p.name}  ${p.email}  password ${p.password}`,
    `           id ${p.id}  is_demo=${p.isDemo}  payouts → ${p.payoutEmail}`,
    `Site       ${s.origin}  (${s.status}, slug ${s.slug}, id ${s.id})`,
    `           The discovery crawl is not seeded: start it live (W03, or POST /api/sites/${s.id}/crawl).`,
    '',
    "Demo site env (apps/demo-site's .env):",
    `  SPIGOT_API_BASE=${config!.APP_BASE_URL.replace(/\/+$/, '')}`,
    `  SPIGOT_GATE_KEY=${s.gateKey}`,
    `  SPIGOT_CRAWL_KEY=${s.crawlKey}`,
    `  SPIGOT_VERIFY_TOKEN=${s.verify.content}   (served at ${s.verify.path})`,
    ...(s.gateKeyMatches
      ? []
      : [
          '  WARNING: the site gate key was rotated since the seed; use the current one, not the above.',
        ]),
    '',
    `Buyer      ${r.acme.name}  ${r.acme.email}  password ${r.acme.password}  (no balance)`,
    `           API key ${r.acme.apiKey}`,
    '',
    `SIM buyers (${r.simTopups.length}), top-ups dated ${r.simulatedAt.toISOString()}:`,
    ...r.simTopups.map(
      (t) =>
        `  ${t.email.padEnd(36)} $${String(t.amountCents / 100).padStart(2)}  ${(t.status === 'LEDGER_ONLY' ? SIM_NO_PAYPAL_LABEL : t.status).padEnd(15)} ` +
        `${t.paypalOrderId ?? '-'} / ${t.paypalCaptureId ?? '-'}${t.created ? '' : '  (existing)'}${t.code ? `  ${t.code}` : ''}`,
    ),
    '  (SIM keys are derived from SESSION_SECRET; sim:buyers re-derives them with seedApiKey.)',
  ];
  if (r.proposals?.status === 'skipped')
    lines.push('', `--with-proposals skipped: ${r.proposals.reason}`);
  if (r.proposals?.status === 'ran') {
    const pr = r.proposals.result;
    lines.push(
      '',
      `Replayed proposal: ${pr.status}, ${pr.proposals} proposal(s), site ${pr.siteStatus ?? '?'} (audited "replayed proposal")`,
    );
  }
  const funded = r.simTopups.filter((t) => t.status === 'COMPLETED').length;
  const ledgerOnly = r.simTopups.filter((t) => t.status === 'LEDGER_ONLY').length;
  lines.push(
    '',
    `Done in ${(r.elapsedMs / 1000).toFixed(1)} s: ${funded} PayPal top-ups, ${ledgerOnly} ${SIM_NO_PAYPAL_LABEL}, ` +
      `${r.simTopups.length - funded - ledgerOnly} not funded.`,
  );
  console.log(lines.join('\n'));
}
