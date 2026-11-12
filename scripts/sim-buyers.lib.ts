// `npm run sim:buyers [-- --live]` (SP-036; features/15 §Seed script 7, §Live simulators).
//
// The 20 SIM buyers that `seed:demo` (SP-035) funded make real paid reads, in-process, through
// the same `paidRead` service `/v1` and MCP use (their own derived API keys, idempotency, price
// caps, `chargeAndRecord`, CHARGE txn, audit sample). Everything they buy is `is_simulated`
// because they are, so every grid shows it with the SIM chip.
//
// - Default ("the week"): records and changes calls spread over the past 7 days, enough for
//   ~$500 gross on the demo publisher (W08's week). Each call passes `simulatedAt`, which
//   `chargeAndRecord` writes as `created_at` on the `api_calls` row, the CHARGE txn and its
//   entries **at insert time**; nothing is ever UPDATEd to backdate it (data-model: the insert
//   trigger allows a backdated `created_at` only on `is_simulated` rows). A buyer's calls all
//   land after its latest top-up, so it is funded at every simulated instant. Re-running tops
//   the week up to the target instead of adding another $500.
// - `--live`: one SIM call (dated now) every 3–6 s until Ctrl-C, so W08 looks alive on camera.
// - A buyer whose call comes back 402 INSUFFICIENT_BALANCE is stopped: SIM buyers never top up.
// - Needs a LIVE dataset on the demo site. With none, `ensureLive` runs the discovery crawl
//   (`crawlSite`, in-process), the schema agent, and approves the Listing proposal through
//   SP-014a's approve service (`rightsAttested`, `agent_phone` hidden), and says so.
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { authenticateKey } from '../apps/api/src/auth/apiKeys.js';
import { seedApiKey } from '../apps/api/src/cli/seedDemo.js';
import type { Config } from '../apps/api/src/config.js';
import { crawlSite } from '../apps/api/src/crawl/crawlSite.js';
import type { CrawlDeps } from '../apps/api/src/crawl/deps.js';
import { approveDataset } from '../apps/api/src/datasets/approve.js';
import { publishRunDatasets, runApproveExtract } from '../apps/api/src/datasets/extractRun.js';
import { patchDataset } from '../apps/api/src/datasets/patch.js';
import type { Db } from '../apps/api/src/db/index.js';
import { ApiError } from '../apps/api/src/http/errors.js';
import { readChanges } from '../apps/api/src/records/changes.js';
import type { FilterClause } from '../apps/api/src/records/filters.js';
import {
  countRecords,
  loadServedDataset,
  queryRecords,
  type ServedDataset,
} from '../apps/api/src/records/query.js';
import { schemaModelFor, type SchemaModel } from '../apps/api/src/schema-agent/claude.js';
import { proposeForSite } from '../apps/api/src/schema-agent/propose.js';
import { paidRead, type PaidReadResult } from '../apps/api/src/services/paidRead.js';
import { normalizeOrigin } from '../apps/api/src/sites/sites.js';
import { DEFAULT_DEMO_SITE_URL } from '../apps/api/src/cli/seedDemo.js';

const DAY_MS = 86_400_000;

/** features/15 §Seed 7: W08 shows about this much gross for the week. */
export const DEFAULT_WEEK_GROSS_MICROS = 500_000_000;
/** The simulated week: calls land in `[now - 7 d + margin, now - END_MARGIN]`. */
export const WEEK_MS = 7 * DAY_MS;
const START_MARGIN_MS = 5 * 60_000;
const END_MARGIN_MS = 2 * 60_000;
/** A buyer's first call comes at least this long after its latest top-up. */
const AFTER_TOPUP_MS = 60_000;
/** SIM buyers making week calls at once (each buyer's own calls run in time order). */
export const WEEK_CONCURRENCY = 4;
/** `--live` cadence (features/15 §Live simulators). */
export const LIVE_GAP_MS: readonly [number, number] = [3_000, 6_000];

/** The Listing proposal `ensureLive` approves, and the field it keeps hidden. */
export const LISTING_TYPE = 'Listing';
export const HIDDEN_FIELD = 'agent_phone';

export type Log = (line: string) => void;

// ---------------------------------------------------------------------------------------------
// Randomness (deterministic with --seed, so a run can be reproduced)

export type Rng = () => number;

/** mulberry32: small, fast, good enough for traffic shapes. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

// ---------------------------------------------------------------------------------------------
// The call catalogue: what a SIM buyer asks for, priced in advance with free internal reads

export interface CallSpec {
  datasetId: string;
  site: string;
  dataset: string;
  kind: 'records' | 'changes';
  filters?: FilterClause[];
  sort?: 'updated_at' | '-updated_at';
  limit: number;
  /** Changes only: `since=0` (full history); records never use a cursor here. */
  since?: number;
  includeRecord?: boolean;
  /** What this call costs right now (count × unit); the charge is recomputed when it runs. */
  priceMicros: number;
}

export const RECORD_LIMITS = [10, 25, 50, 100] as const;
export const CHANGE_LIMITS = [50, 100, 200, 400] as const;
/** Share of calls that are records searches (the rest read the changes feed). */
export const RECORDS_SHARE = 0.75;

export interface SoldDataset {
  ds: ServedDataset;
  siteSlug: string;
}

/** The demo site's LIVE / LIVE_STALE datasets, with their site slug. */
export async function soldDatasets(db: Db, siteId: string): Promise<SoldDataset[]> {
  const { rows } = await db.pool.query<{ id: string; slug: string }>(
    `SELECT d.id, coalesce(s.slug, s.id::text) AS slug
       FROM datasets d JOIN sites s ON s.id = d.site_id
      WHERE d.site_id = $1 AND d.status IN ('LIVE', 'LIVE_STALE')
      ORDER BY d.created_at, d.id`,
    [siteId],
  );
  const out: SoldDataset[] = [];
  for (const r of rows) {
    const ds = await loadServedDataset(db.pool, r.id);
    if (ds && ds.fields.length > 0) out.push({ ds, siteSlug: r.slug });
  }
  return out;
}

/**
 * Filters a buyer might plausibly send, built from a sample page of real values: numeric
 * ranges (`bedrooms >= 3`, `price_usd <= 2400`) and string equality (`city = Austin`), only on
 * fields the dataset makes filterable.
 */
export function filterOptions(
  ds: Pick<ServedDataset, 'fields'>,
  sample: Array<Record<string, unknown>>,
): FilterClause[][] {
  const out: FilterClause[][] = [];
  for (const f of ds.fields) {
    const values = sample.map((r) => r[f.name]).filter((v) => v !== null && v !== undefined);
    if (values.length === 0) continue;
    if (
      (f.type === 'integer' || f.type === 'number') &&
      values.every((v) => typeof v === 'number')
    ) {
      const sorted = [...(values as number[])].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      if (f.filterable.includes('gte')) out.push([{ field: f.name, op: 'gte', value: median }]);
      if (f.filterable.includes('lte')) out.push([{ field: f.name, op: 'lte', value: median }]);
    } else if (f.type === 'string' && f.filterable.includes('eq')) {
      const counts = new Map<string, number>();
      for (const v of values) if (typeof v === 'string') counts.set(v, (counts.get(v) ?? 0) + 1);
      const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      for (const [v] of common.slice(0, 2)) out.push([{ field: f.name, op: 'eq', value: v }]);
    }
  }
  return out;
}

/**
 * Every call shape a SIM buyer picks from, priced with internal reads (no charge, no row). Zero
 * price shapes (a filter matching nothing, an empty feed) are dropped: they'd be NOT_CHARGED.
 */
export async function buildCatalogue(db: Db, sold: SoldDataset[]): Promise<CallSpec[]> {
  const specs: CallSpec[] = [];
  for (const { ds, siteSlug } of sold) {
    const base = { datasetId: ds.id, site: siteSlug, dataset: ds.slug };
    const sample = await queryRecords(db.pool, ds, {
      filters: [],
      sort: 'desc',
      limit: Math.min(100, ds.maxRecordsPerCall),
      cursor: null,
    });
    const filterSets: FilterClause[][] = [
      [],
      ...filterOptions(
        ds,
        sample.records.map((r) => r.data as Record<string, unknown>),
      ),
    ];
    for (const filters of filterSets) {
      for (const limit of RECORD_LIMITS) {
        const effective = Math.min(limit, ds.maxRecordsPerCall);
        const n = await countRecords(db.pool, ds, filters, effective);
        const price = n * ds.pricePerRecordMicros;
        if (price <= 0) continue;
        for (const sort of ['-updated_at', 'updated_at'] as const) {
          specs.push({ ...base, kind: 'records', filters, sort, limit, priceMicros: price });
        }
      }
    }
    if (ds.pricePerChangeMicros > 0) {
      for (const limit of CHANGE_LIMITS) {
        const feed = await readChanges(db.pool, ds, { since: 0, limit });
        const price = feed.changes.length * ds.pricePerChangeMicros;
        if (price <= 0) continue;
        for (const includeRecord of [false, true]) {
          specs.push({
            ...base,
            kind: 'changes',
            limit,
            since: 0,
            includeRecord,
            priceMicros: price,
          });
        }
      }
    }
  }
  return specs;
}

/** Pick one call: records ~75% of the time, else changes (whichever exists). */
export function pickSpec(rng: Rng, catalogue: readonly CallSpec[]): CallSpec {
  const records = catalogue.filter((s) => s.kind === 'records');
  const changes = catalogue.filter((s) => s.kind === 'changes');
  if (records.length === 0) return pick(rng, changes);
  if (changes.length === 0) return pick(rng, records);
  return pick(rng, rng() < RECORDS_SHARE ? records : changes);
}

// ---------------------------------------------------------------------------------------------
// The week plan (pure)

export interface PlanBuyer {
  id: string;
  balanceMicros: number;
  /** The buyer's latest TOPUP txn `created_at`: every call lands after it. */
  fundedAt: Date;
}

export interface PlannedCall {
  buyerId: string;
  at: Date;
  spec: CallSpec;
}

export interface WeekPlan {
  /** Per buyer, in time order. */
  byBuyer: Map<string, PlannedCall[]>;
  plannedMicros: number;
  /** `[from, to)` of the simulated week. */
  from: Date;
  to: Date;
  skipped: Array<{ buyerId: string; reason: string }>;
}

/**
 * Relative traffic by UTC hour: busy in US working hours (≈ 14:00–02:00 UTC), quiet overnight,
 * a bit lower at weekends, and a gentle upward trend over the week (`progress` 0 → 1).
 */
export function activityWeight(at: Date, progress: number): number {
  const h = at.getUTCHours();
  const diurnal = h >= 14 || h < 2 ? 1 : h >= 10 && h < 14 ? 0.55 : 0.25;
  const dow = at.getUTCDay();
  const weekly = dow === 0 || dow === 6 ? 0.7 : 1;
  return diurnal * weekly * (0.75 + 0.5 * progress);
}

/** `n` instants in `[start, end)`, shaped by `activityWeight`, sorted ascending. */
export function sampleTimes(rng: Rng, n: number, start: Date, end: Date): Date[] {
  const s = start.getTime();
  const span = end.getTime() - s;
  const out: number[] = [];
  if (span <= 0) return [];
  while (out.length < n) {
    const t = s + Math.floor(rng() * span);
    const w = activityWeight(new Date(t), (t - s) / span);
    if (rng() * 1.25 <= w) out.push(t);
  }
  return out.sort((a, b) => a - b).map((t) => new Date(t));
}

export interface PlanInput {
  buyers: PlanBuyer[];
  catalogue: readonly CallSpec[];
  /** Gross still to add this week (target minus what SIM calls already bought). */
  remainingMicros: number;
  now: Date;
  rng: Rng;
}

/**
 * Split `remainingMicros` across the buyers in proportion to their balance (never planning more
 * than a buyer holds), draw calls from the catalogue until each buyer's share is covered, and
 * date them inside the buyer's window: after its top-up, inside the past week.
 */
export function planWeek(input: PlanInput): WeekPlan {
  const { buyers, catalogue, rng, now } = input;
  const from = new Date(now.getTime() - WEEK_MS);
  const to = new Date(now.getTime() - END_MARGIN_MS);
  const byBuyer = new Map<string, PlannedCall[]>();
  const skipped: WeekPlan['skipped'] = [];
  let plannedMicros = 0;
  if (input.remainingMicros <= 0 || catalogue.length === 0) {
    return { byBuyer, plannedMicros, from, to, skipped };
  }

  const funded = buyers.filter((b) => {
    if (b.balanceMicros <= 0) skipped.push({ buyerId: b.id, reason: 'no balance' });
    return b.balanceMicros > 0;
  });
  const total = funded.reduce((s, b) => s + b.balanceMicros, 0);
  const cheapest = Math.min(...catalogue.map((c) => c.priceMicros));

  for (const b of funded) {
    const start = new Date(
      Math.max(b.fundedAt.getTime() + AFTER_TOPUP_MS, from.getTime() + START_MARGIN_MS),
    );
    if (start >= to) {
      skipped.push({ buyerId: b.id, reason: 'topped up too recently for a backfill' });
      continue;
    }
    const share = Math.min(
      b.balanceMicros,
      Math.round((input.remainingMicros * b.balanceMicros) / total),
    );
    const specs: CallSpec[] = [];
    let sum = 0;
    while (sum < share && share - sum >= cheapest / 2) {
      const s = pickSpec(rng, catalogue);
      // Don't plan past the buyer's balance: the last affordable call ends its week.
      if (sum + s.priceMicros > b.balanceMicros) {
        const fits = catalogue.filter((c) => sum + c.priceMicros <= b.balanceMicros);
        if (fits.length === 0) break;
        const f = pick(rng, fits);
        specs.push(f);
        sum += f.priceMicros;
        continue;
      }
      specs.push(s);
      sum += s.priceMicros;
    }
    if (specs.length === 0) continue;
    const times = sampleTimes(rng, specs.length, start, to);
    byBuyer.set(
      b.id,
      specs.map((spec, i) => ({ buyerId: b.id, at: times[i]!, spec })),
    );
    plannedMicros += sum;
  }
  return { byBuyer, plannedMicros, from, to, skipped };
}

// ---------------------------------------------------------------------------------------------
// The demo site and its SIM buyers

export interface DemoSite {
  id: string;
  publisherId: string;
  origin: string;
  slug: string;
  status: string;
}

export async function findDemoSite(db: Db, config: Config): Promise<DemoSite> {
  const origin = normalizeOrigin(config.DEMO_SITE_URL ?? DEFAULT_DEMO_SITE_URL);
  const { rows } = await db.pool.query<DemoSite & { isDemo: boolean }>(
    `SELECT s.id, s.publisher_id AS "publisherId", s.origin, coalesce(s.slug, s.id::text) AS slug,
            s.status, p.is_demo AS "isDemo"
       FROM sites s JOIN publishers p ON p.id = s.publisher_id
      WHERE s.origin = $1`,
    [origin],
  );
  const site = rows[0];
  if (!site) throw new Error(`no site connected for ${origin}: run \`npm run seed:demo\` first`);
  if (!site.isDemo) throw new Error(`${origin} belongs to a non-demo publisher; refusing`);
  return {
    id: site.id,
    publisherId: site.publisherId,
    origin,
    slug: site.slug,
    status: site.status,
  };
}

export interface SimBuyer extends PlanBuyer {
  name: string;
  email: string;
  apiKeyId: string;
}

/**
 * Every `is_simulated` buyer whose derived key (`seedApiKey`, SP-035) authenticates, with its
 * balance and latest top-up time. Unfunded or keyless buyers are reported, not used.
 */
export async function loadSimBuyers(
  db: Db,
  secret: string,
): Promise<{ buyers: SimBuyer[]; skipped: Array<{ email: string; reason: string }> }> {
  const { rows } = await db.pool.query<{
    id: string;
    name: string;
    email: string;
    balance: string | number | null;
    fundedAt: Date | null;
  }>(
    `SELECT b.id, b.name, b.email, a.balance_micros AS balance,
            (SELECT max(t.created_at) FROM ledger_txns t
               JOIN ledger_entries e ON e.txn_id = t.id
              WHERE t.kind = 'TOPUP' AND e.account_id = a.id) AS "fundedAt"
       FROM buyers b
       LEFT JOIN ledger_accounts a ON a.kind = 'BUYER_BALANCE' AND a.owner_id = b.id
      WHERE b.is_simulated
      ORDER BY b.email`,
  );
  const buyers: SimBuyer[] = [];
  const skipped: Array<{ email: string; reason: string }> = [];
  for (const r of rows) {
    if (!r.fundedAt) {
      skipped.push({ email: r.email, reason: 'never topped up' });
      continue;
    }
    let apiKeyId: string;
    try {
      const principal = await authenticateKey(db.pool, seedApiKey(secret, r.email));
      if (principal.buyerId !== r.id) throw new ApiError('UNAUTHENTICATED', 'key mismatch');
      apiKeyId = principal.id;
    } catch (err) {
      skipped.push({
        email: r.email,
        reason: `no usable seed key (${err instanceof ApiError ? err.code : String(err)})`,
      });
      continue;
    }
    buyers.push({
      id: r.id,
      name: r.name,
      email: r.email,
      apiKeyId,
      balanceMicros: Number(r.balance ?? 0),
      fundedAt: r.fundedAt,
    });
  }
  return { buyers, skipped };
}

/** SIM gross already charged on the demo publisher in `[from, to)` (hidden calls excluded). */
export async function simGross(db: Db, publisherId: string, from: Date, to: Date): Promise<number> {
  const { rows } = await db.pool.query<{ gross: string }>(
    `SELECT coalesce(sum(c.price_micros), 0)::bigint AS gross
       FROM api_calls c JOIN datasets d ON d.id = c.dataset_id JOIN sites s ON s.id = d.site_id
      WHERE s.publisher_id = $1 AND c.is_simulated AND c.charge_txn_id IS NOT NULL
        AND c.hidden_at IS NULL AND c.created_at >= $2 AND c.created_at < $3`,
    [publisherId, from, to],
  );
  return Number(rows[0]!.gross);
}

// ---------------------------------------------------------------------------------------------
// One SIM call

export interface SimCallDeps {
  db: Db;
  baseUrl: string;
}

export type CallOutcome = 'charged' | 'free' | 'insufficient' | 'over_max';

/** One real paid read with the buyer's key, through `paidRead` (REST channel). */
export async function simCall(
  deps: SimCallDeps,
  buyer: Pick<SimBuyer, 'id' | 'apiKeyId'>,
  spec: CallSpec,
  opts: { simulatedAt?: Date; idempotencyKey: string },
): Promise<{ outcome: CallOutcome; result: PaidReadResult }> {
  const result = await paidRead(
    {
      db: deps.db,
      buyerId: buyer.id,
      apiKeyId: buyer.apiKeyId,
      channel: 'REST',
      baseUrl: deps.baseUrl,
    },
    {
      site: spec.site,
      dataset: spec.dataset,
      kind: spec.kind,
      limit: spec.limit,
      idempotencyKey: opts.idempotencyKey,
      ...(spec.kind === 'records'
        ? { filters: spec.filters ?? [], sort: spec.sort ?? '-updated_at' }
        : { cursor: spec.since ?? 0, includeRecord: spec.includeRecord === true }),
      ...(opts.simulatedAt ? { simulatedAt: opts.simulatedAt } : {}),
    },
  );
  let outcome: CallOutcome;
  if (result.status === 402) outcome = result.callId === null ? 'over_max' : 'insufficient';
  else outcome = result.chargedMicros > 0 ? 'charged' : 'free';
  return { outcome, result };
}

// ---------------------------------------------------------------------------------------------
// The week

export interface WeekOptions {
  targetMicros?: number;
  now?: Date;
  seed?: number;
  concurrency?: number;
  log?: Log;
}

export interface WeekResult {
  from: Date;
  to: Date;
  targetMicros: number;
  beforeMicros: number;
  afterMicros: number;
  calls: number;
  chargedMicros: number;
  /** Buyers stopped by a 402 INSUFFICIENT_BALANCE. */
  stopped: string[];
  skipped: Array<{ buyer: string; reason: string }>;
}

export async function runWeek(
  deps: SimCallDeps & { config: Config },
  site: DemoSite,
  opts: WeekOptions = {},
): Promise<WeekResult> {
  const { db } = deps;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const targetMicros = opts.targetMicros ?? DEFAULT_WEEK_GROSS_MICROS;
  const rng = mulberry32(opts.seed ?? now.getTime());
  const from = new Date(now.getTime() - WEEK_MS);

  const sold = await soldDatasets(db, site.id);
  if (sold.length === 0) throw new Error(`${site.origin} has no LIVE dataset`);
  const catalogue = await buildCatalogue(db, sold);
  if (catalogue.length === 0) throw new Error('the LIVE datasets have nothing to sell yet');

  const { buyers, skipped: noKey } = await loadSimBuyers(db, deps.config.SESSION_SECRET);
  const beforeMicros = await simGross(db, site.publisherId, from, now);
  const plan = planWeek({
    buyers,
    catalogue,
    remainingMicros: targetMicros - beforeMicros,
    now,
    rng,
  });
  const names = new Map(buyers.map((b) => [b.id, b.name]));
  log(
    `${buyers.length} SIM buyers, ${sold.length} LIVE dataset(s) (${sold.map((s) => s.ds.slug).join(', ')}); ` +
      `week ${plan.from.toISOString()} → ${plan.to.toISOString()}`,
  );
  log(
    `SIM gross already this week ${usd(beforeMicros)}; target ${usd(targetMicros)}; ` +
      `planned ${[...plan.byBuyer.values()].reduce((n, c) => n + c.length, 0)} calls ≈ ${usd(plan.plannedMicros)}`,
  );

  let calls = 0;
  let chargedMicros = 0;
  const stopped: string[] = [];
  const queue = new PQueue({ concurrency: opts.concurrency ?? WEEK_CONCURRENCY });
  const byId = new Map(buyers.map((b) => [b.id, b]));
  await Promise.all(
    [...plan.byBuyer.entries()].map(([buyerId, planned]) =>
      queue.add(async () => {
        const buyer = byId.get(buyerId)!;
        let spent = 0;
        let n = 0;
        for (const p of planned) {
          const { outcome, result } = await simCall(deps, buyer, p.spec, {
            simulatedAt: p.at,
            idempotencyKey: `sim-week:${randomUUID()}`,
          });
          calls++;
          n++;
          if (outcome === 'insufficient') {
            stopped.push(buyer.name);
            log(
              `  ${buyer.name}: 402 INSUFFICIENT_BALANCE after ${n - 1} calls; stopped (no SIM top-up)`,
            );
            break;
          }
          spent += result.chargedMicros;
        }
        chargedMicros += spent;
        log(`  ${buyer.name}: ${n} calls, ${usd(spent)}`);
      }),
    ),
  );

  const afterMicros = await simGross(db, site.publisherId, from, now);
  return {
    from: plan.from,
    to: plan.to,
    targetMicros,
    beforeMicros,
    afterMicros,
    calls,
    chargedMicros,
    stopped,
    skipped: [
      ...noKey.map((s) => ({ buyer: s.email, reason: s.reason })),
      ...plan.skipped.map((s) => ({ buyer: names.get(s.buyerId) ?? s.buyerId, reason: s.reason })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// --live

export interface LiveOptions {
  signal: AbortSignal;
  seed?: number;
  gapMs?: readonly [number, number];
  /** Stop after this many calls (tests). */
  maxCalls?: number;
  log?: Log;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface LiveResult {
  calls: number;
  chargedMicros: number;
  stopped: string[];
  /** Why it ended: Ctrl-C, maxCalls, or every SIM buyer out of balance. */
  reason: 'aborted' | 'max_calls' | 'all_stopped';
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export async function runLive(
  deps: SimCallDeps & { config: Config },
  site: DemoSite,
  opts: LiveOptions,
): Promise<LiveResult> {
  const { db } = deps;
  const log = opts.log ?? (() => {});
  const rng = mulberry32(opts.seed ?? Date.now());
  const [lo, hi] = opts.gapMs ?? LIVE_GAP_MS;
  const sleep = opts.sleep ?? abortableSleep;

  const sold = await soldDatasets(db, site.id);
  if (sold.length === 0) throw new Error(`${site.origin} has no LIVE dataset`);
  const catalogue = await buildCatalogue(db, sold);
  if (catalogue.length === 0) throw new Error('the LIVE datasets have nothing to sell yet');
  const { buyers } = await loadSimBuyers(db, deps.config.SESSION_SECRET);
  const active = buyers.filter((b) => b.balanceMicros > 0);
  log(
    `--live: ${active.length} funded SIM buyers, one call every ${lo / 1000}–${hi / 1000} s; Ctrl-C to stop`,
  );

  let calls = 0;
  let chargedMicros = 0;
  const stopped: string[] = [];
  for (;;) {
    if (opts.signal.aborted) return { calls, chargedMicros, stopped, reason: 'aborted' };
    if (opts.maxCalls !== undefined && calls >= opts.maxCalls)
      return { calls, chargedMicros, stopped, reason: 'max_calls' };
    if (active.length === 0) return { calls, chargedMicros, stopped, reason: 'all_stopped' };

    await sleep(lo + Math.floor(rng() * (hi - lo)), opts.signal);
    if (opts.signal.aborted) return { calls, chargedMicros, stopped, reason: 'aborted' };

    const buyer = pick(rng, active);
    const spec = pickSpec(rng, catalogue);
    const { outcome, result } = await simCall(deps, buyer, spec, {
      idempotencyKey: `sim-live:${randomUUID()}`,
    });
    calls++;
    if (outcome === 'insufficient') {
      active.splice(active.indexOf(buyer), 1);
      stopped.push(buyer.name);
      log(`[SIM] ${buyer.name}: 402 INSUFFICIENT_BALANCE; stopped (no SIM top-up)`);
      continue;
    }
    chargedMicros += result.chargedMicros;
    log(
      `[SIM] ${buyer.name} → ${spec.dataset} ${spec.kind} ×${result.count}  ` +
        `${usd(result.chargedMicros)}  (balance ${usd(result.balanceMicros)})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// ensureLive: crawl → proposal → approve, when the demo site has nothing LIVE

export interface EnsureLiveDeps {
  db: Db;
  config: Config;
  /** Crawl deps; default: this db with the config's crawl settings. */
  crawl?: Partial<CrawlDeps>;
  /** Schema model; default `schemaModelFor(config)` (recorded or live, per SCHEMA_AGENT_MODE). */
  model?: SchemaModel;
  /** Polling while another process proposes (default 1 s, up to 10 min). */
  pollMs?: number;
  maxWaitMs?: number;
}

export type EnsureLiveResult =
  | { status: 'already_live'; datasets: string[] }
  | {
      status: 'made_live';
      steps: string[];
      datasetId: string;
      schemaVersionId: string;
      records: number;
    };

/**
 * The demo needs something to sell. If the demo site has no LIVE dataset: run the discovery
 * crawl when the site is still VERIFIED, run the schema agent if no one has, then approve the
 * Listing proposal with `rightsAttested: true` and `agent_phone` hidden (PATCH first if a
 * proposal ever shows it), extract, and publish the watermark. Every step is the same service
 * the API calls; each is logged.
 */
export async function ensureLive(
  deps: EnsureLiveDeps,
  site: DemoSite,
  log: Log = () => {},
): Promise<EnsureLiveResult> {
  const { db, config } = deps;
  const live = await soldDatasets(db, site.id);
  if (live.length > 0) return { status: 'already_live', datasets: live.map((d) => d.ds.slug) };

  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    log(s);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const siteStatus = async () =>
    (await db.pool.query<{ status: string }>('SELECT status FROM sites WHERE id = $1', [site.id]))
      .rows[0]!.status;

  let status = await siteStatus();
  if (status === 'PENDING_VERIFY')
    throw new Error(`${site.origin} isn't verified: re-run seed:demo`);
  if (status === 'PAUSED') throw new Error(`${site.origin} is PAUSED: resume it on W03 first`);

  if (status === 'VERIFIED') {
    step(`no LIVE dataset on ${site.origin}: running the discovery crawl (crawlSite, in-process)…`);
    const run = await crawlSite(
      { siteId: site.id, trigger: 'MANUAL' },
      {
        db,
        crawlSecret: config.SESSION_SECRET,
        allowLocal: config.ALLOW_LOCAL_ORIGINS,
        appBaseUrl: config.APP_BASE_URL,
        ...deps.crawl,
      },
    );
    const c = run.counters;
    step(
      `crawl ${run.runId}: ${run.status}, ${c.pages_fetched + c.pages_not_modified}/${c.pages_total} pages`,
    );
    status = await siteStatus();
    if (status === 'VERIFIED') {
      throw new Error(
        `the discovery crawl ended ${run.status} without moving the site to PROPOSING; is the demo site up at ${site.origin}?`,
      );
    }
  }

  const model = deps.model ?? schemaModelFor(config);
  const deadline = Date.now() + (deps.maxWaitMs ?? 10 * 60_000);
  while (status === 'PROPOSING') {
    const r = await proposeForSite({ db, model }, site.id, { trigger: 'ADMIN' });
    if (r.status === 'done') {
      step(`schema agent (${model.mode}): ${r.proposals} proposal(s), site ${r.siteStatus}`);
    } else if (r.status === 'busy') {
      if (Date.now() > deadline) throw new Error('another process is still proposing; try again');
      await sleep(deps.pollMs ?? 1_000);
    } else if (r.status !== 'wrong_status') {
      throw new Error(`schema agent: ${r.status}`);
    }
    status = await siteStatus();
    if (r.status === 'done' && status === 'PROPOSING') {
      throw new Error('the schema agent finished but the site is still PROPOSING');
    }
  }
  if (status !== 'READY') throw new Error(`${site.origin} is ${status}; expected READY`);

  const { rows: proposals } = await db.pool.query<{
    datasetId: string;
    svId: string;
    fields: Array<{ name: string; visible?: boolean }>;
  }>(
    `SELECT d.id AS "datasetId", sv.id AS "svId", sv.fields
       FROM datasets d JOIN schema_versions sv ON sv.dataset_id = d.id AND sv.status = 'PROPOSED'
      WHERE d.site_id = $1 AND d.type_name = $2 AND d.status = 'PROPOSED'
      ORDER BY sv.version DESC LIMIT 1`,
    [site.id, LISTING_TYPE],
  );
  const proposal = proposals[0];
  if (!proposal) {
    throw new Error(
      `no PROPOSED ${LISTING_TYPE} dataset on ${site.origin} (rejected or unpublished?): approve one on W05/W06`,
    );
  }

  let schemaVersionId = proposal.svId;
  const phone = proposal.fields.find((f) => f.name === HIDDEN_FIELD);
  if (phone && phone.visible !== false) {
    const patched = await patchDataset(db, site.publisherId, proposal.datasetId, {
      fields: [{ name: HIDDEN_FIELD, visible: false }],
    });
    schemaVersionId = patched.schemaVersion!.id;
    step(
      `hid ${HIDDEN_FIELD} on the ${LISTING_TYPE} proposal (PATCH → schema version ${schemaVersionId})`,
    );
  }

  const approved = await approveDataset(
    db,
    { appBaseUrl: config.APP_BASE_URL },
    site.publisherId,
    proposal.datasetId,
    { schemaVersionId, rightsAttested: true },
  );
  step(
    `approved the ${LISTING_TYPE} proposal (rightsAttested, ${HIDDEN_FIELD} hidden) → ${approved.status} at ${approved.endpoint}`,
  );
  const extract = await runApproveExtract(db, {
    datasetId: approved.datasetId,
    runId: approved.crawlRunId,
    publisherId: approved.publisherId,
    fields: approved.fields,
  });
  if (extract.status !== 'SUCCEEDED') throw new Error(`extraction failed: ${extract.error}`);
  // The API process publishes on its `onRunFinished` hook; this process has no hooks.
  await publishRunDatasets(db, approved.crawlRunId);
  const { rows } = await db.pool.query<{ n: number }>(
    'SELECT record_count AS n FROM datasets WHERE id = $1',
    [approved.datasetId],
  );
  step(`extracted ${rows[0]!.n} records; watermark published`);
  return {
    status: 'made_live',
    steps,
    datasetId: approved.datasetId,
    schemaVersionId,
    records: rows[0]!.n,
  };
}

export function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
