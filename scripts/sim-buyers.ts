// `npm run sim:buyers [-- --live]` (SP-036). Logic and docs in `./sim-buyers.lib.ts`.
//
//   npm run sim:buyers                     # the simulated week: ~$500 SIM gross, dated at insert
//   npm run sim:buyers -- --live           # one SIM call every 3–6 s until Ctrl-C (recording)
//
// Flags:
//   --live           live calls (dated now) instead of the week backfill
//   --target-usd N   week gross to reach (default 500); a re-run only adds what's missing
//   --seed N         deterministic plan (buyers, call shapes, timestamps)
//
// Needs DATABASE_URL and SESSION_SECRET (the SIM keys are derived from it, SP-035) and a seeded
// DB (`npm run seed:demo`). With no LIVE dataset on the demo site it runs the discovery crawl
// (the demo site must be up at DEMO_SITE_URL), the schema agent and the Listing approve itself,
// and prints each step. Never prints keys or secrets. Exits 1 if the ledger check fails.
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../apps/api/src/config.js';
import { createDb, createPool } from '../apps/api/src/db/index.js';
import { loadDotenv } from '../apps/api/src/env.js';
import { ledgerCheck } from '../apps/api/src/ledger/check.js';
import {
  DEFAULT_WEEK_GROSS_MICROS,
  EnsureLiveAborted,
  ensureLive,
  findDemoSite,
  runLive,
  runWeek,
  usd,
} from './sim-buyers.lib.js';

loadDotenv();

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    'target-usd': { type: 'string' },
    seed: { type: 'string' },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) fail(err.message);
  throw err;
}

const target = values['target-usd'] === undefined ? undefined : Number(values['target-usd']);
if (target !== undefined && !(Number.isFinite(target) && target > 0)) {
  fail('--target-usd must be a positive number');
}
const seed = values.seed === undefined ? undefined : Number(values.seed);
if (seed !== undefined && !Number.isInteger(seed)) fail('--seed must be an integer');

const pool = createPool(config.DATABASE_URL, { max: 8, applicationName: 'spigot-sim-buyers' });
const db = createDb(pool);
const log = (l: string) => console.log(l);
const deps = { db, config, baseUrl: config.APP_BASE_URL };

// Ctrl-C stops every mode: no new SIM call starts, the crawl stops where it is (resumable), and
// the ledger check still runs before exit. `once`: a second Ctrl-C is Node's default hard exit.
const controller = new AbortController();
const { signal } = controller;
process.once('SIGINT', () => {
  console.log('\nstopping… (Ctrl-C again to quit at once)');
  controller.abort();
});

let exitCode = 0;
try {
  const site = await findDemoSite(db, config);
  console.log(`sim:buyers on ${site.origin} (${site.slug}); every call below is SIM`);
  // Same rule as `defaultCrawlDeps`: an explicit CRAWL_MIN_GAP_MS wins, else the adaptive gap.
  const crawl = process.env.CRAWL_MIN_GAP_MS?.trim() ? { minGapMs: config.CRAWL_MIN_GAP_MS } : {};
  const live = await ensureLive({ db, config, crawl, signal }, site, (l) =>
    console.log(`  ${l}`),
  ).catch((err: unknown) => {
    if (!(err instanceof EnsureLiveAborted)) throw err;
    console.log(`  ${err.message}`);
    return null;
  });
  if (live?.status === 'made_live') {
    console.log(
      `  The demo site had no LIVE dataset, so sim:buyers ran the crawl and approved the Listing proposal itself.`,
    );
  }

  if (!live) {
    exitCode = 130;
  } else if (values.live) {
    const r = await runLive(deps, site, { signal, seed, log });
    console.log(
      `\n--live ${r.reason === 'all_stopped' ? 'ended: every SIM buyer is out of balance' : 'stopped'}: ` +
        `${r.calls} calls, ${usd(r.chargedMicros)} charged` +
        (r.stopped.length ? `; stopped on 402: ${r.stopped.join(', ')}` : ''),
    );
  } else {
    const r = await runWeek(deps, site, {
      targetMicros:
        target === undefined ? DEFAULT_WEEK_GROSS_MICROS : Math.round(target * 1_000_000),
      seed,
      log,
      signal,
    });
    if (r.aborted) {
      console.log('\nStopped by Ctrl-C: a partial week. Re-run to top it up to the target.');
      exitCode = 130;
    }
    console.log(
      `\nWeek ${r.from.toISOString().slice(0, 10)} → ${r.to.toISOString().slice(0, 10)}: ` +
        `${r.calls} SIM calls, ${usd(r.chargedMicros)} charged; SIM week gross ${usd(r.beforeMicros)} → ${usd(r.afterMicros)} ` +
        `(target ${usd(r.targetMicros)})`,
    );
    if (r.stopped.length) console.log(`Stopped on 402 (no SIM top-up): ${r.stopped.join(', ')}`);
    for (const s of r.skipped) console.log(`Skipped ${s.buyer}: ${s.reason}`);
  }

  const check = await ledgerCheck(pool);
  console.log(
    `Ledger check: ${check.mismatches.length === 0 ? 'OK' : `${check.mismatches.length} mismatch(es)`} (${check.accountsChecked} accounts)`,
  );
  if (check.mismatches.length > 0) exitCode = 1;
} catch (err) {
  console.error(`sim:buyers failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
