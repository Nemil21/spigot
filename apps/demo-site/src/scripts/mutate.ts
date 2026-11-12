// `npm run demo:mutate -- --prices 30 --leased 5 --new 3 [--seed 42] [--focus "bedrooms>=3,price_usd<2000,city=Austin"] [--target <url> [--ping]]`
//
// A "demo mutation": changes a known set of listings so the next crawl emits exactly those changes.
// - With --target, calls POST <target>/admin/mutate with DEMO_ADMIN_TOKEN (local site or Render).
// - Without it, appends to the mutation log in DEMO_DATA_DIR directly; a running site only
//   picks that up on restart, so use --target when the site is up.
// - --ping (SP-055, needs --target): then POST the changed pages to Spigot's
//   /api/sites/:id/ping with the site's crawl key (SPIGOT_API_BASE, SPIGOT_SITE_ID,
//   SPIGOT_CRAWL_KEY), so Spigot re-fetches only those pages.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { mutateSummary } from '../admin.js';
import { MutationError, parseMutateOptions } from '../data/mutations.js';
import { DEFAULT_DATA_DIR, openStore } from '../data/store.js';
import { pingConfigFromEnv, pingSpigot, pingUrls, type PingResult } from '../ping.js';
import { scaleFromEnv } from '../data/seed.js';

type Summary = ReturnType<typeof mutateSummary> & { ping?: PingResult };

/** Fill DEMO_* keys from the repo-root .env without overriding the environment or printing values. */
function loadRootEnv(): void {
  const file = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  const keys = [
    'DEMO_ADMIN_TOKEN',
    'DEMO_DATA_DIR',
    'DEMO_SEED_SCALE',
    'DEMO_LISTINGS',
    'SPIGOT_API_BASE',
    'SPIGOT_SITE_ID',
    'SPIGOT_CRAWL_KEY',
  ];
  for (const key of keys) {
    if (process.env[key] === undefined && parsed[key]) process.env[key] = parsed[key];
  }
}

function print(s: Summary): void {
  console.log(`demo mutation at ${s.at} (seed ${s.seed}${s.focus ? `, focus "${s.focus}"` : ''})`);
  console.log(`price changes (${s.prices.length}):`);
  for (const p of s.prices) console.log(`  ${p.slug}  $${p.from} -> $${p.to}`);
  console.log(`leased (${s.leased.length}):`);
  for (const slug of s.leased) console.log(`  ${slug}`);
  console.log(`new listings (${s.added.length}):`);
  for (const slug of s.added) console.log(`  ${slug}`);
  console.log(`pages with a new lastmod: ${s.touched.length}`);
  if (s.ping) {
    const how = s.ping.joined ? 'joined live run' : 'PING run';
    console.log(`pinged Spigot with ${s.ping.urls} URLs: ${how} ${s.ping.crawlRunId}`);
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  const { values } = parseArgs({
    options: {
      prices: { type: 'string' },
      leased: { type: 'string' },
      new: { type: 'string' },
      seed: { type: 'string' },
      focus: { type: 'string' },
      target: { type: 'string' },
      ping: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const opts = parseMutateOptions(values);
  const emit = (s: Summary) => (values.json ? console.log(JSON.stringify(s, null, 2)) : print(s));
  // Pinging pages the running site doesn't serve yet would fetch the old content.
  if (opts.ping && !values.target)
    throw new MutationError('--ping needs --target (the running site)');
  const ping = opts.ping ? pingConfigFromEnv(process.env) : null;

  if (values.target) {
    const token = process.env.DEMO_ADMIN_TOKEN;
    if (!token) throw new MutationError('--target needs DEMO_ADMIN_TOKEN (env or the repo .env)');
    const url = new URL('/admin/mutate', values.target);
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...opts, ping: false }),
    });
    const body = (await res.json().catch(() => ({}))) as Summary & {
      message?: string;
      error?: string;
    };
    if (!res.ok)
      throw new Error(
        `${url.origin}/admin/mutate → ${res.status} ${body.message ?? body.error ?? ''}`.trim(),
      );
    if (ping) {
      // The changed pages on the site Spigot knows: --target is that site's origin.
      body.ping = await pingSpigot(ping, pingUrls(values.target, body.touched));
    }
    emit(body);
    return;
  }

  const dataDir = process.env.DEMO_DATA_DIR || DEFAULT_DATA_DIR;
  const scale = scaleFromEnv(process.env);
  const store = await openStore({ dataDir, scale });
  const entry = await store.mutate(opts);
  emit(mutateSummary(entry));
  console.error(
    `wrote the mutation log in ${dataDir}; restart a running demo site to serve it (or use --target)`,
  );
}

main().catch((err: unknown) => {
  console.error(`demo:mutate: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof MutationError ? 2 : 1;
});
