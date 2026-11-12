/**
 * `npm run demo:reset -- --yes` (SP-038): start the next take clean. Logic and docs in
 * `./demoReset.ts`.
 *
 *   DEMO_MODE=true npm run demo:reset -- --yes
 *   DEMO_MODE=true npm run demo:reset -- --yes --skip-site     # database only (no demo site, no crawl)
 *
 * Needs DATABASE_URL and SESSION_SECRET; the demo-site step needs DEMO_SITE_URL (default
 * http://localhost:4100) and DEMO_ADMIN_TOKEN. Refuses without `--yes`, without DEMO_MODE=true, and
 * for a publisher without `is_demo`. Prints Acme's new API key (the old one now answers 401) and
 * never PayPal credentials. Exits 1 on a refusal, a failed step or a failed ledger check.
 */
import { parseArgs } from 'node:util';
import { auditCrawlRunDone } from '../crawl/api.js';
import type { CrawlDeps } from '../crawl/deps.js';
import { onPageChanged, onRunEnding, onRunFinished } from '../crawl/hooks.js';
import { ConfigError, loadConfig } from '../config.js';
import {
  extractChangedPage,
  publishRunDatasets,
  settleRunDatasets,
} from '../datasets/extractRun.js';
import { createDb, createPool } from '../db/index.js';
import { loadDotenv } from '../env.js';
import { ledgerCheck } from '../ledger/check.js';
import { normalizeOrigin } from '../sites/sites.js';
import {
  assertDemoMode,
  crawlDemoSite,
  demoReset,
  DemoResetRefused,
  demoSiteOf,
  resetDemoSite,
} from './demoReset.js';
import { DEFAULT_DEMO_SITE_URL } from './seedDemo.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean', default: false },
    'skip-site': { type: 'boolean', default: false },
    publisher: { type: 'string' },
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

try {
  assertDemoMode(config, 'demo:reset');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
if (!values.yes) {
  console.error(
    'demo:reset puts the demo datasets back to PROPOSED, zeroes Acme, hides its calls and rotates its key.\n' +
      'Nothing is deleted and PayPal history is untouched. Re-run with --yes to do it.',
  );
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL, { max: 6, applicationName: 'spigot-demo-reset' });
const db = createDb(pool);
let exitCode = 0;
try {
  const r = await demoReset(db, values.publisher ? { publisherEmail: values.publisher } : {});
  const lines = [
    `demo:reset ${r.resetId}`,
    `Publisher  ${r.publisher.email}  (${r.publisher.id})`,
    r.datasets.length === 0
      ? '  datasets: nothing LIVE / UNPUBLISHED (already reset)'
      : `  datasets → PROPOSED (records kept): ${r.datasets.map((d) => `${d.slug} (was ${d.from})`).join(', ')}`,
    ...Object.entries(r.policyVersions).map(
      ([site, v]) => `  site ${site}: policy version ${v} (the gate stops quoting within 60 s)`,
    ),
    `Buyer      ${r.buyer.email}  (${r.buyer.id})`,
    r.buyer.ledgerTxnId
      ? `  balance $${(r.buyer.zeroedMicros / 1_000_000).toFixed(2)} → $0: DEMO_RESET txn ${r.buyer.ledgerTxnId} into PLATFORM_REVENUE`
      : '  balance already $0 (no ledger txn)',
    `  ${r.buyer.hiddenCalls} call(s) hidden (kept, hidden_at set); ${r.buyer.revokedKeyIds.length} key(s) revoked`,
    `  NEW API key ${r.buyer.apiKey}`,
    '  (update Claude Desktop / the demo prompt card; the old key now answers 401)',
  ];
  console.log(lines.join('\n'));

  if (values['skip-site']) {
    console.log('\nDemo site: skipped (--skip-site). Records revert after the next crawl.');
  } else {
    const siteUrl = config.DEMO_SITE_URL ?? DEFAULT_DEMO_SITE_URL;
    if (!config.DEMO_ADMIN_TOKEN) {
      console.error(
        `\nDemo site: DEMO_ADMIN_TOKEN is unset, so ${siteUrl}/admin/reset can't be called.`,
      );
      exitCode = 1;
    } else {
      const site = await resetDemoSite(siteUrl, config.DEMO_ADMIN_TOKEN);
      console.log(
        `\nDemo site ${siteUrl}: reset at ${site.at}, ${site.reverted.length} page(s) reverted, ` +
          `${site.removed.length} listing(s) removed`,
      );
      const row = await demoSiteOf(pool, r.publisher.id, normalizeOrigin(siteUrl));
      if (!row) {
        console.error(`  no Spigot site for ${siteUrl} under the demo publisher: no crawl started`);
        exitCode = 1;
      } else {
        // The API process's crawl hooks (routes/crawl.ts, routes/datasets.ts), for this run.
        const off = [
          onPageChanged((pageId, runId) => extractChangedPage(db, pageId, runId).then(() => {})),
          onRunEnding((runId) => settleRunDatasets(db, runId)),
          onRunFinished(async (runId) => {
            await publishRunDatasets(db, runId);
            await auditCrawlRunDone(db, runId);
          }),
        ];
        const crawlDeps: CrawlDeps = {
          db,
          crawlSecret: config.SESSION_SECRET,
          allowLocal: config.ALLOW_LOCAL_ORIGINS,
          appBaseUrl: config.APP_BASE_URL,
          minGapMs: process.env.CRAWL_MIN_GAP_MS?.trim() ? config.CRAWL_MIN_GAP_MS : undefined,
        };
        try {
          console.log(`  MANUAL crawl of ${siteUrl} …`);
          const crawl = await crawlDemoSite(crawlDeps, r.publisher.id, row.id);
          console.log(`  crawl ${crawl.crawlRunId}: ${crawl.status}`);
          if (crawl.status !== 'SUCCEEDED' && crawl.status !== 'PARTIAL') exitCode = 1;
        } finally {
          for (const f of off) f();
        }
      }
    }
  }

  const check = await ledgerCheck(pool);
  console.log(
    `\nLedger check: ${check.mismatches.length === 0 ? 'OK' : `${check.mismatches.length} mismatch(es)`} (${check.accountsChecked} accounts)`,
  );
  if (check.mismatches.length > 0) exitCode = 1;
} catch (err) {
  console.error(
    err instanceof DemoResetRefused
      ? `demo:reset refused: ${err.message}`
      : `demo:reset failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
