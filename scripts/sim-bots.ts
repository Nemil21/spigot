// `npm run sim:bots -- --target <demo-site-url> [--minutes 10] [--backfill 7d]` (SP-037).
//
// Real HTTP to the demo site with bot UAs (GPTBot, ClaudeBot, CCBot, python-requests, Scrapy,
// Googlebot) at 2–5 req/s each plus ~60 req/s human UAs, on random gated and open paths from its
// sitemap. Every request carries `X-Spigot-Sim: 1`; the gate classifies it for real and counts
// it as SIM only when it runs with `SPIGOT_GATE_DEMO=1` (features/15 §Live simulators).
//
// --backfill 7d posts a week of SIM `bot_hits` buckets straight to `POST /api/gate/hits` with the
// site's gate key, in as few posts as fit SP-008b's limits (1 MB, the schema's bucket cap),
// ≥ 5 s apart. It runs before the live traffic so the gate's own 10-s flush can't take the
// rate-limit slot. Posting the same window twice doubles it (the endpoint sums): `demo:reset`
// first for a clean take.
//
// Flags:
//   --target URL         demo site (default DEMO_SITE_URL)
//   --minutes N          live traffic duration (default 10; 0 = backfill only)
//   --bot-rps N|MIN-MAX  per-bot rate (default 2-5)
//   --human-rps N        human rate (default 60; turn it down for Render's free tier)
//   --backfill 7d        also backfill SIM buckets for this window (needs SPIGOT_API_BASE and
//                        SPIGOT_GATE_KEY, from the env or the repo .env)
//   --backfill-step N    backfill bucket width in minutes (default 10; W04's week view is hourly)
//   --seed N             deterministic rates, paths and backfill volumes
// Secrets come from the env or the repo .env and are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import {
  DEFAULT_DECISIONS,
  MIN_POST_GAP_MS,
  SIM_HEADER,
  UsageError,
  assertValidBatches,
  buildAgents,
  buildBackfill,
  demoModeWarnings,
  fetchDecisions,
  googlebotQuoted,
  mulberry32,
  packBatches,
  parseDuration,
  parseRate,
  postBatches,
  renderTally,
  runLive,
  sitemapPaths,
  sleep,
  type Tally,
} from './sim-bots.lib.js';

const ENV_KEYS = ['DEMO_SITE_URL', 'SPIGOT_API_BASE', 'SPIGOT_GATE_KEY', 'SPIGOT_GATE_DEMO'];

/** Fill the keys we use from the repo-root .env without overriding the env or printing values. */
function loadRootEnv(): void {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const key of ENV_KEYS) {
    if (process.env[key] === undefined && parsed[key]) process.env[key] = parsed[key];
  }
}

const warn = (msg: string) => console.error(`\x1b[33mwarning:\x1b[0m ${msg}`);

async function loadPages(target: string): Promise<string[]> {
  try {
    const res = await fetch(new URL('/sitemap.xml', target), {
      headers: { 'user-agent': 'spigot-sim-bots (sitemap)', [SIM_HEADER]: '1' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pages = sitemapPaths(await res.text());
    if (pages.length === 0) throw new Error('no <loc> entries');
    return pages;
  } catch (err) {
    warn(
      `couldn't read ${target}/sitemap.xml (${err instanceof Error ? err.message : err}); ` +
        'sending open paths only, so nothing will be gated',
    );
    return [];
  }
}

async function backfill(
  window: string,
  stepMinutes: number,
  agents: ReturnType<typeof buildAgents>,
  seed: number,
) {
  const apiBase = process.env.SPIGOT_API_BASE?.trim();
  const gateKey = process.env.SPIGOT_GATE_KEY?.trim();
  if (!apiBase || !gateKey)
    throw new UsageError(
      '--backfill needs SPIGOT_API_BASE and SPIGOT_GATE_KEY (env or the repo .env)',
    );
  const durationMs = parseDuration(window);
  const decisions = await fetchDecisions(apiBase, gateKey);
  if (!decisions)
    warn("couldn't read the site's gate policy; backfilling with the default decisions");
  const t0 = Date.now();
  const buckets = buildBackfill({
    agents,
    now: t0,
    durationMs,
    stepMinutes,
    decisions: decisions ?? DEFAULT_DECISIONS,
    rng: mulberry32(seed ^ 0x5eed),
  });
  const batches = packBatches(buckets, new Date(t0).toISOString());
  assertValidBatches(batches);
  console.log(
    `backfill ${window}: ${buckets.length} SIM buckets (${stepMinutes}-min) in ${batches.length} ` +
      `post(s), ≥ 5 s apart → ${new URL(apiBase).origin}/api/gate/hits`,
  );
  const r = await postBatches(batches, { apiBase, gateKey, log: (l) => console.log(l) });
  console.log(
    `backfill done: ${r.posts} post(s), ${r.buckets} buckets, ${r.hits.toLocaleString('en-US')} ` +
      `hits in ${(r.elapsedMs / 1000).toFixed(1)} s; 429s: ${r.rateLimited}`,
  );
  if (r.rateLimited > 0)
    warn('the API rate-limited a post (another poster, e.g. the gate flushing live traffic?)');
}

function printFinal(tally: Tally, elapsedMs: number) {
  console.log(
    renderTally(tally.rows(), `\nsim:bots done after ${(elapsedMs / 1000).toFixed(0)} s:`),
  );
  console.log('Hits reach W04 (labelled SIM) within one gate flush, ~10 s.');
}

async function main(): Promise<void> {
  loadRootEnv();
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      minutes: { type: 'string', default: '10' },
      'bot-rps': { type: 'string', default: '2-5' },
      'human-rps': { type: 'string', default: '60' },
      backfill: { type: 'string' },
      'backfill-step': { type: 'string', default: '10' },
      seed: { type: 'string' },
    },
    strict: true,
  });
  const target = (values.target ?? process.env.DEMO_SITE_URL)?.trim().replace(/\/+$/, '');
  if (!target) throw new UsageError('--target <demo-site-url> is required (or set DEMO_SITE_URL)');
  try {
    new URL(target);
  } catch {
    throw new UsageError(`--target is not a URL: ${target}`);
  }
  const minutes = Number(values.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) throw new UsageError('--minutes must be ≥ 0');
  const [humanRps] = parseRate(values['human-rps'], '--human-rps');
  const botRps = parseRate(values['bot-rps'], '--bot-rps');
  const stepMinutes = Number(values['backfill-step']);
  const seed =
    values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed);
  const rng = mulberry32(seed);
  const agents = buildAgents(rng, botRps, humanRps);

  for (const w of demoModeWarnings(process.env, target)) warn(w);

  if (values.backfill) await backfill(values.backfill, stepMinutes, agents, seed);
  if (minutes === 0) return;
  if (values.backfill) {
    // The gate's first flush of live traffic must not land in the window of our last post,
    // or it gets the 429 and W04 waits a whole extra flush (10 s) for it.
    console.log('waiting out the 5-s gate-hits window before live traffic…');
    await sleep(MIN_POST_GAP_MS);
  }

  const pages = await loadPages(target);
  console.log(
    `sim:bots → ${target} for ${minutes} min (seed ${seed}); ${pages.length} sitemap pages; ` +
      agents.map((a) => `${a.label} ${a.rps}/s`).join(', '),
  );

  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const tty = process.stdout.isTTY;
  let warnedGooglebot = false;
  let lastPrint = 0;
  const started = Date.now();
  const tally = await runLive({
    target,
    agents,
    pages,
    durationMs: minutes * 60_000,
    rng,
    signal: stop.signal,
    onProgress(t, elapsed) {
      if (!warnedGooglebot && googlebotQuoted(t)) {
        warnedGooglebot = true;
        warn(
          'Googlebot got a 402: the gate verified it as a non-Google IP, which it skips for SIM ' +
            'traffic in demo mode. The gate is NOT in demo mode, so these hits count as real.',
        );
      }
      if (!tty && elapsed - lastPrint < 10_000) return;
      lastPrint = elapsed;
      const table = renderTally(t.rows(), `sim:bots ${(elapsed / 1000).toFixed(0)} s → ${target}`);
      console.log(tty ? `\x1b[H\x1b[2J${table}\n(Ctrl-C to stop)` : `${table}\n`);
    },
  });
  printFinal(tally, Date.now() - started);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`sim:bots: ${msg}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
