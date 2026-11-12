import { z } from 'zod';
import { botRatioLine } from '@spigot/shared';
import type { Queryable } from '../db/index.js';
import { ApiError, parse } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';

/**
 * W04 bot report (api.md §`GET /api/sites/:id/bots`; features/13 §1; SP-027a). Read-only
 * aggregates over `bot_hits` (the gate's minute buckets) for one of the publisher's sites:
 *
 * - `totals`: bot hits (every category but HUMAN), human hits, the "1 bot per N human visits"
 *   line, 402s quoted, bytes avoided (the `bytes` of QUOTE_402 rows, which the gate fills with
 *   the page's estimated size) and `wouldHaveEarnedMicros`, an **estimate**: quoted 402 hits ×
 *   records per gated page × price per record (see `pageValue`).
 * - `byBot`: one row per (bot, category, decision, SIM), largest first. Their `hits` sum to
 *   `totals.botHits`. `hits24h` is the row's hits per hour over the 24 h ending at `to`, oldest
 *   first (24 numbers; W04's sparkline cell, SP-027b).
 * - `series`: hits per time bucket and category (HUMAN included, so the chart can show it or
 *   not); the bucket size follows the range (`bucketSizeFor`).
 * - `earnedThisWeek`: the publisher's net share of calls charged on this site's datasets in the
 *   last 7 days (from `api_calls`, demo-hidden calls excluded), with the SIM part for the KPI
 *   hover.
 *
 * `includeSim=false` drops every SIM row (`bot_hits.is_simulated`, `api_calls.is_simulated`).
 * The range is half-open `[from, to)`; the default is the 7 days ending now.
 */

export const DEFAULT_RANGE_MS = 7 * 86_400_000;
/** Longest range one report may cover. */
export const MAX_RANGE_MS = 92 * 86_400_000;
/** Most `byBot` rows returned (the gate's UA table names a few dozen bots). */
export const BY_BOT_LIMIT = 500;
/** `datasets.price_per_record_micros` default, used when the site has no dataset yet. */
export const DEFAULT_PRICE_PER_RECORD_MICROS = 1500;

export type BucketSize = 'minute' | 'hour' | 'day';

/** Hourly points in each `byBot[].hits24h` sparkline. */
export const SPARKLINE_HOURS = 24;

/** ≤ 3 h → minute buckets, ≤ 7 d → hourly (the default range: 168 points), longer → daily. */
export function bucketSizeFor(rangeMs: number): BucketSize {
  if (rangeMs <= 3 * 3_600_000) return 'minute';
  if (rangeMs <= DEFAULT_RANGE_MS) return 'hour';
  return 'day';
}

const boolParam = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === undefined || v === 'true' || v === '1');

const isoParam = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 date-time')
  .optional();

export const botsQuery = z.object({ from: isoParam, to: isoParam, includeSim: boolParam });

export interface BotsReportInput {
  from: Date;
  to: Date;
  includeSim: boolean;
}

/** Parse and bound the query string; `now` is injectable for tests. */
export function parseBotsQuery(query: unknown, now = new Date()): BotsReportInput {
  const q = parse(botsQuery, query, 'query');
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  const span = to.getTime() - from.getTime();
  if (span <= 0) throw new ApiError('VALIDATION_ERROR', '`from` must be before `to`.');
  if (span > MAX_RANGE_MS) {
    throw new ApiError('VALIDATION_ERROR', 'The range may cover at most 92 days.');
  }
  return { from, to, includeSim: q.includeSim };
}

export interface BotsReport {
  range: { from: string; to: string; bucketSize: BucketSize };
  includeSim: boolean;
  totals: {
    botHits: number;
    humanHits: number;
    ratio: string;
    quoted402: number;
    bytesSavedEstimate: number;
    wouldHaveEarnedMicros: number;
    /** Always true: `wouldHaveEarnedMicros` and `wouldHavePaid` are estimates (W04 labels them). */
    estimate: true;
    /** The value of one quoted page behind the estimate, and where its price came from. */
    estimateBasis: { perGatedPageMicros: number; priceSource: PriceSource };
  };
  byBot: {
    botName: string;
    category: string;
    hits: number;
    decision: string;
    lastSeen: string;
    bytes: number;
    wouldHavePaid: number;
    isSimulated: boolean;
    /** Hits per hour over the 24 h ending at `range.to`, oldest first (`SPARKLINE_HOURS` long). */
    hits24h: number[];
  }[];
  series: { bucket: string; category: string; hits: number }[];
  earnedThisWeek: { micros: number; simMicros: number; simShare: number };
}

/** `LIVE`: the site's selling datasets; `PROPOSED`: not yet published; `DEFAULT`: no dataset. */
export type PriceSource = 'LIVE' | 'PROPOSED' | 'DEFAULT';

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const botKey = (bot: string, category: string, decision: string, sim: boolean) =>
  JSON.stringify([bot, category, decision, sim]);

/**
 * What one quoted page is worth, in micros: the average over the site's datasets, weighted by
 * template page count, of records per page × price per record. Records per page is 1 for a
 * detail template (one record per page) and `record_count / page_count` for list templates.
 * Prices come from LIVE / LIVE_STALE datasets; before anything is published, from the
 * proposals (not rejected ones), so W04 can show the estimate before the first sale.
 */
export async function pageValue(
  q: Queryable,
  siteId: string,
): Promise<{ micros: number; source: PriceSource }> {
  const { rows } = await q.query<{ source: 'LIVE' | 'PROPOSED'; weight: string; value: string }>(
    `SELECT CASE WHEN d.status IN ('LIVE', 'LIVE_STALE') THEN 'LIVE' ELSE 'PROPOSED' END AS source,
            sum(w.weight) AS weight,
            sum(w.weight * w.per_page * d.price_per_record_micros) AS value
       FROM datasets d
       LEFT JOIN templates t ON t.id = d.template_id
       CROSS JOIN LATERAL (
         SELECT GREATEST(COALESCE(t.page_count, 0), 1)::numeric AS weight,
                GREATEST(round(d.record_count::numeric / NULLIF(t.page_count, 0)), 1) AS per_page
       ) w
      WHERE d.site_id = $1 AND d.status <> 'REJECTED'
      GROUP BY 1`,
    [siteId],
  );
  const pick = rows.find((r) => r.source === 'LIVE') ?? rows.find((r) => r.source === 'PROPOSED');
  if (!pick) return { micros: DEFAULT_PRICE_PER_RECORD_MICROS, source: 'DEFAULT' };
  return { micros: Math.round(num(pick.value) / num(pick.weight)), source: pick.source };
}

/**
 * The report for one of `publisherId`'s sites; another publisher's site (or a bad id) is
 * `404 NOT_FOUND`. Three reads over `bot_hits` use the primary key's `(site_id, bucket)` prefix.
 */
export async function botsReport(
  q: Queryable,
  publisherId: string,
  siteId: string,
  input: BotsReportInput,
  now = new Date(),
): Promise<BotsReport> {
  await forPublisher(publisherId).get(q, 'sites', siteId, { columns: 't.id' });

  const { from, to, includeSim } = input;
  const bucketSize = bucketSizeFor(to.getTime() - from.getTime());
  const params = [siteId, from, to, includeSim];
  const where = `site_id = $1 AND bucket >= $2 AND bucket < $3 AND ($4::bool OR NOT is_simulated)`;
  const weekFrom = new Date(now.getTime() - DEFAULT_RANGE_MS);
  const sparkFrom = new Date(to.getTime() - SPARKLINE_HOURS * 3_600_000);

  const [totalsRes, byBotRes, seriesRes, earnedRes, value, sparkRes] = await Promise.all([
    q.query<Record<string, string | null>>(
      `SELECT sum(hits) FILTER (WHERE category <> 'HUMAN') AS bot_hits,
              sum(hits) FILTER (WHERE category = 'HUMAN') AS human_hits,
              sum(hits) FILTER (WHERE decision = 'QUOTE_402') AS quoted,
              sum(bytes) FILTER (WHERE decision = 'QUOTE_402') AS bytes_saved
         FROM bot_hits WHERE ${where}`,
      params,
    ),
    q.query<{
      bot_name: string;
      category: string;
      decision: string;
      is_simulated: boolean;
      hits: string;
      bytes: string;
      quoted: string;
      last_seen: Date;
    }>(
      `SELECT bot_name, category, decision, is_simulated,
              sum(hits) AS hits, sum(bytes) AS bytes, max(bucket) AS last_seen,
              COALESCE(sum(hits) FILTER (WHERE decision = 'QUOTE_402'), 0) AS quoted
         FROM bot_hits WHERE ${where} AND category <> 'HUMAN'
        GROUP BY bot_name, category, decision, is_simulated
        ORDER BY sum(hits) DESC, bot_name, category, decision, is_simulated
        LIMIT ${BY_BOT_LIMIT}`,
      params,
    ),
    q.query<{ bucket: Date; category: string; hits: string }>(
      // Truncated in UTC so buckets don't depend on the session time zone.
      `SELECT date_trunc($5::text, bucket AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
              category, sum(hits) AS hits
         FROM bot_hits WHERE ${where}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [...params, bucketSize],
    ),
    q.query<{ net: string | null; sim_net: string | null }>(
      `SELECT sum(n.net) AS net, sum(n.net) FILTER (WHERE c.is_simulated) AS sim_net
         FROM api_calls c
         JOIN datasets d ON d.id = c.dataset_id
         JOIN sites s ON s.id = d.site_id
         JOIN publishers p ON p.id = s.publisher_id
         CROSS JOIN LATERAL (SELECT GREATEST(c.price_micros - c.credited_micros, 0) AS kept) k
         CROSS JOIN LATERAL (
           SELECT k.kept - floor(k.kept * COALESCE(c.commission_bps, p.commission_bps) / 10000) AS net
         ) n
        WHERE d.site_id = $1 AND c.created_at >= $2 AND c.created_at < $3
          AND c.status IN ('CHARGED', 'PARTIALLY_CREDITED')
          AND c.hidden_at IS NULL
          AND ($4::bool OR NOT c.is_simulated)`,
      [siteId, weekFrom, now, includeSim],
    ),
    pageValue(q, siteId),
    q.query<{
      bot_name: string;
      category: string;
      decision: string;
      is_simulated: boolean;
      idx: number;
      hits: string;
    }>(
      // Hour slots counted back from `to`, so the last point is always the latest hour.
      `SELECT bot_name, category, decision, is_simulated,
              floor(extract(epoch FROM bucket - $2::timestamptz) / 3600)::int AS idx,
              sum(hits) AS hits
         FROM bot_hits WHERE ${where} AND category <> 'HUMAN'
        GROUP BY 1, 2, 3, 4, 5`,
      [siteId, sparkFrom, to, includeSim],
    ),
  ]);

  const spark = new Map<string, number[]>();
  for (const r of sparkRes.rows) {
    if (r.idx < 0 || r.idx >= SPARKLINE_HOURS) continue;
    const key = botKey(r.bot_name, r.category, r.decision, r.is_simulated);
    let points = spark.get(key);
    if (!points) spark.set(key, (points = new Array<number>(SPARKLINE_HOURS).fill(0)));
    points[r.idx] = num(r.hits);
  }

  const t = totalsRes.rows[0] ?? {};
  const botHits = num(t.bot_hits);
  const humanHits = num(t.human_hits);
  const quoted = num(t.quoted);
  const earned = num(earnedRes.rows[0]?.net);
  const simEarned = num(earnedRes.rows[0]?.sim_net);

  return {
    range: { from: from.toISOString(), to: to.toISOString(), bucketSize },
    includeSim,
    totals: {
      botHits,
      humanHits,
      ratio: botRatioLine(botHits, humanHits),
      quoted402: quoted,
      bytesSavedEstimate: num(t.bytes_saved),
      wouldHaveEarnedMicros: quoted * value.micros,
      estimate: true,
      estimateBasis: { perGatedPageMicros: value.micros, priceSource: value.source },
    },
    byBot: byBotRes.rows.map((r) => ({
      botName: r.bot_name,
      category: r.category,
      hits: num(r.hits),
      decision: r.decision,
      lastSeen: r.last_seen.toISOString(),
      bytes: num(r.bytes),
      wouldHavePaid: num(r.quoted) * value.micros,
      isSimulated: r.is_simulated,
      hits24h:
        spark.get(botKey(r.bot_name, r.category, r.decision, r.is_simulated)) ??
        new Array<number>(SPARKLINE_HOURS).fill(0),
    })),
    series: seriesRes.rows.map((r) => ({
      bucket: r.bucket.toISOString(),
      category: r.category,
      hits: num(r.hits),
    })),
    earnedThisWeek: {
      micros: earned,
      simMicros: simEarned,
      simShare: earned > 0 ? Math.round((simEarned / earned) * 10_000) / 10_000 : 0,
    },
  };
}
