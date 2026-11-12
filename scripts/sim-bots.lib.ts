// SP-037 `sim:bots` building blocks (features/15 §Live simulators; features/02 §Hit counting).
// The CLI is scripts/sim-bots.ts; everything here takes its clock, RNG and fetch as arguments so
// tests can drive it. Relative imports (not `@spigot/*`) so `tsx` runs it without a build.
// Only the UA table: the gate barrel would also load the middleware, flusher and DNS verifier.
// Nothing here imports `@spigot/*` by package name (that resolves to an unbuilt `dist/`).
import { matchBot } from '../packages/gate/src/bots.js';
import {
  MAX_HIT_BUCKETS,
  gateHitsSchema,
  type GateHitBucket,
  type GateHits,
} from '../packages/shared/src/gate.js';

/** Header the gate honours as SIM when it runs with `SPIGOT_GATE_DEMO=1`. */
export const SIM_HEADER = 'x-spigot-sim';

/** The six bots the demo shows (features/15). Category and name come from the gate's UA table. */
export const SIM_BOT_UAS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'CCBot/2.0 (https://commoncrawl.org/faq/)',
  'python-requests/2.32.3',
  'Scrapy/2.11.2 (+https://scrapy.org)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
] as const;

/** Browser UAs for the "human" stream (no bot marker, so the gate counts them as HUMAN). */
export const HUMAN_UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
] as const;

export const HUMAN_LABEL = 'humans';

/** Ungated pages mixed into every stream, so the report shows bots passing there too. */
export const OPEN_PATHS = ['/', '/robots.txt', '/sitemap.xml'] as const;
/** Share of requests that go to a sitemap page (mostly gated) rather than an open path. */
export const SITEMAP_SHARE = 0.85;

/** SP-008b: body ≤ 1 MB (1,048,576 B); we pack to 1,000,000 to leave headroom. */
export const MAX_POST_BYTES = 1_000_000;
/** SP-008b: 1 post / 5 s / site. Posts are started at least this far apart. */
export const MIN_POST_GAP_MS = 5_200;

export type Rng = () => number;

/** Deterministic RNG (mulberry32) for `--seed` and tests. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class UsageError extends Error {
  override name = 'UsageError';
}

/** `7d`, `24h`, `90m`, `30s` → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([dhms])$/i.exec(s.trim());
  if (!m) throw new UsageError(`bad duration "${s}" (use e.g. 7d, 24h, 90m)`);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[m[2]!.toLowerCase() as 'd'];
  const ms = Number(m[1]) * unit;
  if (!(ms > 0)) throw new UsageError(`duration must be positive: "${s}"`);
  return ms;
}

/** `3` → [3, 3]; `2-5` → [2, 5]. Requests per second, ≥ 0. */
export function parseRate(s: string, what: string): [number, number] {
  const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(s.trim());
  if (!m) throw new UsageError(`bad ${what} "${s}" (use N or MIN-MAX)`);
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (hi < lo) throw new UsageError(`bad ${what} "${s}": MIN > MAX`);
  return [lo, hi];
}

/** Pathnames from a sitemap.xml (`<loc>` entries), deduplicated, in order. */
export function sitemapPaths(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    try {
      const u = new URL(m[1]!.replace(/&amp;/g, '&'));
      out.add(u.pathname + u.search);
    } catch {
      // skip malformed entries
    }
  }
  return [...out];
}

export function pickPath(rng: Rng, pages: readonly string[]): string {
  if (pages.length > 0 && rng() < SITEMAP_SHARE) return pages[Math.floor(rng() * pages.length)]!;
  return OPEN_PATHS[Math.floor(rng() * OPEN_PATHS.length)]!;
}

/** One simulated client stream: a bot UA, or the pool of human UAs. */
export interface SimAgent {
  /** Tally / report label: the gate's bot name, or `humans`. */
  label: string;
  /** UA(s) to send; humans rotate through several. */
  uas: readonly string[];
  rps: number;
  /** What the gate will count this as. */
  category: GateHitBucket['category'];
  botName: string;
}

/** The six bots at a rate drawn from `botRps`, plus one human stream at `humanRps`. */
export function buildAgents(rng: Rng, botRps: [number, number], humanRps: number): SimAgent[] {
  const agents: SimAgent[] = SIM_BOT_UAS.map((ua) => {
    const bot = matchBot(ua);
    if (!bot) throw new Error(`gate UA table no longer matches "${ua}"`);
    const [lo, hi] = botRps;
    return {
      label: bot.name,
      uas: [ua],
      rps: Math.round((lo + rng() * (hi - lo)) * 10) / 10,
      category: bot.category,
      botName: bot.name,
    };
  });
  agents.push({
    label: HUMAN_LABEL,
    uas: HUMAN_UAS,
    rps: humanRps,
    category: 'HUMAN',
    botName: '-',
  });
  return agents;
}

/**
 * Turns per-agent rates into whole requests per tick: each agent accrues `rps × dt` credit and
 * fires its whole part, so fractional rates average out over time.
 */
export function createScheduler(rates: readonly number[]) {
  const credit = rates.map(() => 0);
  return {
    take(dtMs: number): number[] {
      return rates.map((r, i) => {
        credit[i]! += (r * dtMs) / 1000;
        const n = Math.floor(credit[i]!);
        credit[i]! -= n;
        return n;
      });
    },
  };
}

export type Outcome = 'ok' | 'quote' | 'other' | 'error' | 'skipped';

export interface TallyRow {
  label: string;
  sent: number;
  ok: number;
  quote: number;
  other: number;
  error: number;
  skipped: number;
}

export function outcomeOf(status: number): Outcome {
  if (status === 402) return 'quote';
  if (status >= 200 && status < 300) return 'ok';
  return 'other';
}

/** Live tally of what the gate decided, by bot (features/15: "decision by bot"). */
export function createTally(labels: readonly string[]) {
  const rows = new Map<string, TallyRow>(
    labels.map((label) => [
      label,
      { label, sent: 0, ok: 0, quote: 0, other: 0, error: 0, skipped: 0 },
    ]),
  );
  return {
    record(label: string, outcome: Outcome): void {
      const row = rows.get(label);
      if (!row) return;
      if (outcome !== 'skipped') row.sent += 1;
      row[outcome] += 1;
    },
    rows(): TallyRow[] {
      return [...rows.values()];
    },
    get(label: string): TallyRow | undefined {
      return rows.get(label);
    },
  };
}
export type Tally = ReturnType<typeof createTally>;

export function renderTally(rows: readonly TallyRow[], header: string): string {
  const cols = ['bot', 'sent', '200/2xx', '402', 'other', 'error', 'skipped'];
  const data = rows.map((r) => [
    r.label,
    String(r.sent),
    String(r.ok),
    String(r.quote),
    String(r.other),
    String(r.error),
    String(r.skipped),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  return [header, line(cols), ...data.map(line)].join('\n');
}

export interface LiveOptions {
  /** Demo site origin. */
  target: string;
  agents: readonly SimAgent[];
  pages: readonly string[];
  durationMs: number;
  rng: Rng;
  fetch?: typeof fetch;
  tickMs?: number;
  /** Requests in flight at once; beyond it a due request is skipped (and counted). */
  maxInFlight?: number;
  timeoutMs?: number;
  /** Called about once a second with the tally. */
  onProgress?: (tally: Tally, elapsedMs: number) => void;
  signal?: AbortSignal;
}

/**
 * Real HTTP to the demo site: each request carries its agent's UA and `X-Spigot-Sim: 1`; the
 * gate classifies it for real. Resolves with the tally once the time is up and every request
 * in flight has settled.
 */
export async function runLive(opts: LiveOptions): Promise<Tally> {
  const doFetch = opts.fetch ?? fetch;
  const tickMs = opts.tickMs ?? 100;
  const maxInFlight = opts.maxInFlight ?? 128;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const tally = createTally(opts.agents.map((a) => a.label));
  const scheduler = createScheduler(opts.agents.map((a) => a.rps));
  const inFlight = new Set<Promise<void>>();
  const start = Date.now();
  let lastTick = start;
  let lastProgress = start;

  const fire = (agent: SimAgent) => {
    if (inFlight.size >= maxInFlight) return tally.record(agent.label, 'skipped');
    const ua = agent.uas[Math.floor(opts.rng() * agent.uas.length)]!;
    const url = new URL(pickPath(opts.rng, opts.pages), opts.target);
    const accept =
      agent.category === 'HUMAN'
        ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        : '*/*';
    const p: Promise<void> = doFetch(url, {
      headers: { 'user-agent': ua, accept, [SIM_HEADER]: '1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then(async (res) => {
        // Read the body so the gate counts its bytes and the socket is reused.
        await res.arrayBuffer().catch(() => {});
        tally.record(agent.label, outcomeOf(res.status));
      })
      .catch(() => tally.record(agent.label, 'error'))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  while (!opts.signal?.aborted) {
    const now = Date.now();
    if (now - start >= opts.durationMs) break;
    const due = scheduler.take(now - lastTick);
    lastTick = now;
    // Interleave the agents so no stream starves another under the in-flight cap.
    let more = true;
    for (let k = 0; more; k++) {
      more = false;
      opts.agents.forEach((agent, i) => {
        if (k < due[i]!) {
          fire(agent);
          more = true;
        }
      });
    }
    if (opts.onProgress && now - lastProgress >= 1_000) {
      lastProgress = now;
      opts.onProgress(tally, now - start);
    }
    await sleep(tickMs, opts.signal);
  }
  await Promise.allSettled([...inFlight]);
  return tally;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// --- Backfill -------------------------------------------------------------------------------

export type Decisions = Record<
  'SEARCH' | 'AI_TRAINING' | 'AI_AGENT' | 'SCRAPER_TOOL' | 'UNKNOWN',
  'PASS' | 'QUOTE'
>;

/** Spec defaults (features/02 rule 3), used when the site's policy can't be fetched. */
export const DEFAULT_DECISIONS: Decisions = {
  SEARCH: 'PASS',
  AI_TRAINING: 'QUOTE',
  AI_AGENT: 'QUOTE',
  SCRAPER_TOOL: 'QUOTE',
  UNKNOWN: 'PASS',
};

/** Rough page sizes for `bytes`: a gated page (listing), an open one (home, robots, sitemap). */
export const GATED_PAGE_BYTES = 18_000;
export const OPEN_PAGE_BYTES = 4_000;

const MINUTE_MS = 60_000;

export interface BackfillOptions {
  agents: readonly SimAgent[];
  /** End of the window (exclusive); rounded down to the minute. */
  now: number;
  durationMs: number;
  /** Width of each bucket in minutes; every bucket starts on a minute (SP-008b schema). */
  stepMinutes: number;
  decisions: Decisions;
  rng: Rng;
}

/** Humans follow the day (UTC, US-centred demo site); bots crawl around the clock. */
function humanDayFactor(at: number): number {
  const hour = new Date(at).getUTCHours();
  // Peak ~19:00 UTC (US afternoon), trough ~07:00 UTC (US night): 1.0 down to 0.1.
  return 0.55 + 0.45 * Math.cos(((hour - 19) / 24) * 2 * Math.PI);
}

/**
 * Every SIM `bot_hits` bucket for the window, as the gate would have counted them: per step and
 * agent, `SITEMAP_SHARE` of the hits land on gated pages (402 when the policy quotes the
 * category, else a pass) and the rest on open pages (pass). All `isSimulated: true`.
 */
export function buildBackfill(opts: BackfillOptions): GateHitBucket[] {
  if (!Number.isInteger(opts.stepMinutes) || opts.stepMinutes < 1)
    throw new UsageError('--backfill-step must be a whole number of minutes ≥ 1');
  const stepMs = opts.stepMinutes * MINUTE_MS;
  const end = Math.floor(opts.now / MINUTE_MS) * MINUTE_MS;
  const first = Math.ceil((end - opts.durationMs) / stepMs) * stepMs;
  const out: GateHitBucket[] = [];
  for (let t = first; t < end; t += stepMs) {
    const bucket = new Date(t).toISOString().replace('.000Z', 'Z');
    const width = Math.min(stepMs, end - t) / 1000;
    for (const a of opts.agents) {
      const human = a.category === 'HUMAN';
      const jitter = 0.7 + opts.rng() * 0.6;
      const total = Math.round(a.rps * width * jitter * (human ? humanDayFactor(t) : 1));
      if (total <= 0) continue;
      const gated = Math.round(total * SITEMAP_SHARE);
      const open = total - gated;
      const quotes = a.category !== 'HUMAN' && opts.decisions[a.category] === 'QUOTE';
      // The gate estimates a 402's "avoided" bytes from the gated pages it served.
      const quoted = quotes ? gated : 0;
      const passed = total - quoted;
      const passBytes = (gated - quoted) * GATED_PAGE_BYTES + open * OPEN_PAGE_BYTES;
      const base = { bucket, category: a.category, botName: a.botName, isSimulated: true };
      if (quoted > 0)
        out.push({
          ...base,
          decision: 'QUOTE_402',
          hits: quoted,
          bytes: quoted * GATED_PAGE_BYTES,
        });
      if (passed > 0) out.push({ ...base, decision: 'PASS', hits: passed, bytes: passBytes });
    }
  }
  return out;
}

/** Byte length of a `POST /api/gate/hits` body as `JSON.stringify` writes it. */
export function payloadBytes(body: GateHits): number {
  return Buffer.byteLength(JSON.stringify(body));
}

/**
 * Split buckets into as few `POST /api/gate/hits` bodies as fit SP-008b's limits: each body
 * ≤ `maxBytes` serialized and ≤ `maxBuckets` buckets (the shared schema's cap).
 */
export function packBatches(
  buckets: readonly GateHitBucket[],
  sentAt: string,
  maxBytes = MAX_POST_BYTES,
  maxBuckets = MAX_HIT_BUCKETS,
): GateHits[] {
  const overhead = payloadBytes({ sentAt, buckets: [] });
  const batches: GateHits[] = [];
  let cur: GateHitBucket[] = [];
  let size = overhead;
  for (const b of buckets) {
    const bytes = Buffer.byteLength(JSON.stringify(b));
    if (overhead + bytes > maxBytes) throw new Error('one bucket is larger than a whole post');
    if (cur.length > 0 && (size + 1 + bytes > maxBytes || cur.length >= maxBuckets)) {
      batches.push({ sentAt, buckets: cur });
      cur = [];
      size = overhead;
    }
    size += bytes + (cur.length > 0 ? 1 : 0); // a comma before every bucket but the first
    cur.push(b);
  }
  if (cur.length > 0) batches.push({ sentAt, buckets: cur });
  return batches;
}

export interface PostOptions {
  /** Spigot API origin (SPIGOT_API_BASE). */
  apiBase: string;
  /** Site gate key; sent as a Bearer token, never printed. */
  gateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  /** Retries per post after a 429 (waiting `Retry-After`). */
  maxRetries?: number;
  log?: (line: string) => void;
}

export interface PostResult {
  posts: number;
  buckets: number;
  hits: number;
  rateLimited: number;
  elapsedMs: number;
}

export class BackfillError extends Error {
  override name = 'BackfillError';
}

/** Error text from an API error body, without echoing anything we sent. */
async function apiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string } | string;
    message?: string;
  } | null;
  const e = body?.error;
  const code = typeof e === 'object' ? e?.code : e;
  const msg = typeof e === 'object' ? e?.message : body?.message;
  return [res.status, code, msg].filter(Boolean).join(' ');
}

/**
 * Post the batches one after another, each started ≥ `minGapMs` after the previous one started
 * (SP-008b allows 1 post / 5 s / site). A 429 waits `Retry-After` and retries; anything else
 * non-2xx stops the run, since a bucket the API rejected would just be rejected again.
 */
export async function postBatches(
  batches: readonly GateHits[],
  opts: PostOptions,
): Promise<PostResult> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? ((ms: number) => sleep(ms));
  const minGap = opts.minGapMs ?? MIN_POST_GAP_MS;
  const maxRetries = opts.maxRetries ?? 3;
  const log = opts.log ?? (() => {});
  const url = new URL('/api/gate/hits', opts.apiBase);
  const started = now();
  let lastPost = Number.NEGATIVE_INFINITY;
  const result: PostResult = { posts: 0, buckets: 0, hits: 0, rateLimited: 0, elapsedMs: 0 };

  for (const [i, batch] of batches.entries()) {
    for (let attempt = 0; ; attempt++) {
      const gap = lastPost + minGap - now();
      if (gap > 0) await wait(gap);
      lastPost = now();
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.gateKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        result.posts += 1;
        result.buckets += batch.buckets.length;
        result.hits += batch.buckets.reduce((n, b) => n + b.hits, 0);
        log(`  post ${i + 1}/${batches.length}: ${batch.buckets.length} buckets → ${res.status}`);
        break;
      }
      if (res.status === 429 && attempt < maxRetries) {
        result.rateLimited += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        await res.body?.cancel().catch(() => {});
        const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : minGap;
        log(`  post ${i + 1}/${batches.length}: 429, retrying in ${Math.ceil(ms / 1000)} s`);
        // The limiter counts from its own clock: wait the full window from now.
        lastPost = now() + ms - minGap;
        continue;
      }
      throw new BackfillError(`POST ${url.pathname} → ${await apiError(res)}`);
    }
  }
  result.elapsedMs = now() - started;
  return result;
}

/** Validate every batch against the API's own schema before sending anything. */
export function assertValidBatches(batches: readonly GateHits[]): void {
  for (const b of batches) gateHitsSchema.parse(b);
}

/**
 * The site's decisions from `GET /api/gate/policy` (gate-key auth), so the backfill quotes the
 * same categories the live gate does. Null when it can't be fetched.
 */
export async function fetchDecisions(
  apiBase: string,
  gateKey: string,
  doFetch: typeof fetch = fetch,
): Promise<Decisions | null> {
  try {
    const res = await doFetch(new URL('/api/gate/policy', apiBase), {
      headers: { authorization: `Bearer ${gateKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json()) as { decisions?: Partial<Decisions> };
    const d = body.decisions;
    if (!d) return null;
    const out = { ...DEFAULT_DECISIONS };
    for (const k of Object.keys(out) as (keyof Decisions)[]) {
      if (d[k] === 'PASS' || d[k] === 'QUOTE') out[k] = d[k];
    }
    return out;
  } catch {
    return null;
  }
}

/** True for loopback / private hosts, where the sim's env is most likely the gate's env too. */
export function isLocalTarget(target: string): boolean {
  const host = new URL(target).hostname;
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host)
  );
}

/**
 * Warnings about SIM labelling. The sim can't read the gate's env, so it checks its own (a
 * local demo site reads the same `.env`) and, live, the one thing a non-demo gate does
 * differently with SIM traffic: it reverse-DNS-checks Googlebot from a public IP and, failing
 * that, quotes it (features/02 rule 5); in demo mode SIM traffic is never verified.
 */
export function demoModeWarnings(env: { SPIGOT_GATE_DEMO?: string }, target: string): string[] {
  const out: string[] = [];
  if (env.SPIGOT_GATE_DEMO !== '1') {
    out.push(
      "SPIGOT_GATE_DEMO is not 1 in this environment (or .env). If the demo site's gate runs " +
        'without it, these requests are counted as REAL bot traffic, not SIM. Set ' +
        'SPIGOT_GATE_DEMO=1 on the demo site and restart it.',
    );
  }
  if (!isLocalTarget(target)) {
    out.push(
      `${new URL(target).host} is remote: this script can't see its env, so make sure ` +
        'SPIGOT_GATE_DEMO=1 is set on that service.',
    );
  }
  return out;
}

export function googlebotQuoted(tally: Tally): boolean {
  return (tally.get('Googlebot')?.quote ?? 0) > 0;
}
