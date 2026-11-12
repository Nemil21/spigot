import type pg from 'pg';
import { rangeSql, type Range } from './query.js';

/**
 * Publisher earnings (api.md §`GET /api/publishers/me/earnings`; features/07 §Display; W08).
 *
 * Read from charged `api_calls` of the publisher's datasets, with each call's net taken from its
 * own CHARGE entry on the publisher's `PUBLISHER_PAYABLE` account. So `netMicros` is exactly the
 * "charges (net)" term of `ledgerCheck`'s per-publisher invariant, and `commissionMicros`
 * (gross − net) carries the floor-rounding remainder exactly as posted. `payableMicros` is the
 * payable account itself (all time: it is "payable now", not a period figure).
 *
 * `includeSim=false` drops SIM calls and SIM txns (payable is then the sum of non-SIM entries).
 * Calls hidden by the demo reset (`hidden_at`, SP-038) are not counted.
 */

export const GROUP_BY = ['buyer', 'dataset', 'day'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/**
 * Dimensions for `groupBy=a,b,…` (SP-030b): W08 asks for buyer × dataset × channel × day in one
 * read, so its grid (Buyer → Dataset, channel leaves) and its per-day bars sum the same rows the
 * KPIs come from. A single dimension still answers exactly as before.
 */
export const GROUP_DIMS = ['buyer', 'dataset', 'day', 'channel'] as const;
export type GroupDim = (typeof GROUP_DIMS)[number];

export interface EarningsQuery extends Range {
  publisherId: string;
  /** One dimension, or several in order (no repeats). */
  groupBy: GroupBy | readonly GroupDim[];
  includeSim: boolean;
}

export interface EarningsKpis {
  grossMicros: number;
  commissionMicros: number;
  netMicros: number;
  payableMicros: number;
  calls: number;
  recordsSold: number;
  changesSold: number;
  buyers: number;
}

export interface ChannelSplit {
  calls: number;
  grossMicros: number;
}

/** The value of each grouped dimension for one row; only the requested ones are set. */
export interface EarningsDims {
  buyer?: { id: string; name: string };
  dataset?: { id: string; key: string };
  /** `YYYY-MM-DD` (UTC). */
  day?: string;
  channel?: 'REST' | 'MCP';
}

export interface EarningsRow {
  /**
   * Display key: buyer name, `site/dataset`, or `YYYY-MM-DD` (UTC); with several dimensions,
   * their keys joined by ` · `.
   */
  key: string;
  /** Stable id for grouping: buyer id, dataset id, or the day; with several, joined by `|`. */
  id: string;
  dims: EarningsDims;
  isSimulated: boolean;
  calls: number;
  records: number;
  changes: number;
  grossMicros: number;
  commissionMicros: number;
  netMicros: number;
  channels: { REST: ChannelSplit; MCP: ChannelSplit };
}

export interface Earnings {
  kpis: EarningsKpis;
  rows: EarningsRow[];
}

/** Group expressions over the `chargedCalls` CTE (aliased `c`). */
const DIM_SQL: Record<GroupDim, { id: string; key: string }> = {
  buyer: {
    id: `c.buyer_id::text`,
    key: `coalesce(c.buyer_name, 'Buyer ' || left(c.buyer_id::text, 8))`,
  },
  dataset: {
    id: `c.dataset_id::text`,
    key: `coalesce(c.site_slug, c.site_origin) || '/' || c.dataset_slug`,
  },
  day: {
    id: `to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    key: `to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
  },
  channel: { id: `c.channel::text`, key: `c.channel::text` },
};

/** `buyer` → `['buyer']`; a list is used as given (the route has already checked it). */
export function groupDims(groupBy: EarningsQuery['groupBy']): readonly GroupDim[] {
  return typeof groupBy === 'string' ? [groupBy] : groupBy;
}

/**
 * The charged calls in scope, one row each, as a CTE body. `$1` is the publisher id and
 * `$2` includeSim; the range bounds follow.
 */
function chargedCalls(q: EarningsQuery, params: unknown[]): string {
  params.push(q.publisherId, q.includeSim);
  const range = rangeSql('c.created_at', q, params);
  return `
    SELECT c.id, c.buyer_id, c.dataset_id, c.channel, c.is_simulated, c.created_at,
           coalesce(c.records_returned, 0)::bigint AS records,
           coalesce(c.changes_returned, 0)::bigint AS changes,
           c.price_micros AS gross,
           coalesce(n.net, 0)::bigint AS net,
           b.name AS buyer_name, s.slug AS site_slug, s.origin AS site_origin, d.slug AS dataset_slug
    FROM api_calls c
    JOIN datasets d ON d.id = c.dataset_id
    JOIN sites s ON s.id = d.site_id
    JOIN buyers b ON b.id = c.buyer_id
    LEFT JOIN LATERAL (
      SELECT sum(e.amount_micros) AS net
      FROM ledger_entries e
      JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.txn_id = c.charge_txn_id AND a.kind = 'PUBLISHER_PAYABLE' AND a.owner_id = s.publisher_id
    ) n ON true
    WHERE s.publisher_id = $1
      AND c.charge_txn_id IS NOT NULL
      AND c.hidden_at IS NULL
      AND ($2::bool OR NOT c.is_simulated)
      AND ${range}`;
}

export async function earnings(pool: pg.Pool, q: EarningsQuery): Promise<Earnings> {
  const client = await pool.connect();
  try {
    // One snapshot: KPIs, rows and payable agree even while charges land.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await read(client, q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function read(client: pg.PoolClient, q: EarningsQuery): Promise<Earnings> {
  const kpiParams: unknown[] = [];
  const kpi = await client.query<Omit<EarningsKpis, 'payableMicros'>>(
    `WITH calls AS (${chargedCalls(q, kpiParams)})
     SELECT coalesce(sum(gross), 0)::bigint AS "grossMicros",
            coalesce(sum(gross - net), 0)::bigint AS "commissionMicros",
            coalesce(sum(net), 0)::bigint AS "netMicros",
            count(*)::int AS calls,
            coalesce(sum(records), 0)::bigint AS "recordsSold",
            coalesce(sum(changes), 0)::bigint AS "changesSold",
            count(DISTINCT buyer_id)::int AS buyers
     FROM calls`,
    kpiParams,
  );

  const payable = await client.query<{ payable: number }>(
    `SELECT coalesce(sum(e.amount_micros), 0)::bigint AS payable
     FROM ledger_accounts a
     JOIN ledger_entries e ON e.account_id = a.id
     JOIN ledger_txns t ON t.id = e.txn_id
     WHERE a.kind = 'PUBLISHER_PAYABLE' AND a.owner_id = $1 AND ($2::bool OR NOT t.is_simulated)`,
    [q.publisherId, q.includeSim],
  );

  const dims = groupDims(q.groupBy);
  if (dims.length === 0 || new Set(dims).size !== dims.length) {
    throw new RangeError('groupBy needs one or more distinct dimensions');
  }
  // Day-first reads are a time series (oldest first); anything else ranks by gross.
  const order = dims[0] === 'day' ? `id, "isSimulated"` : `"grossMicros" DESC, key, id`;
  const dimCols = dims
    .map((d) => `${DIM_SQL[d].id} AS "${d}Id", ${DIM_SQL[d].key} AS "${d}Key"`)
    .join(',\n              ');
  const idExpr = dims.map((d) => `"${d}Id"`).join(` || '|' || `);
  const keyExpr = dims.map((d) => `"${d}Key"`).join(` || ' · ' || `);
  const dimOut = dims.map((d) => `"${d}Id", "${d}Key"`).join(', ');
  const groupCols = dims.map((_, i) => `${2 * i + 1}, ${2 * i + 2}`).join(', ');
  const rowParams: unknown[] = [];
  const rows = await client.query<
    {
      key: string;
      id: string;
      isSimulated: boolean;
      calls: number;
      records: number;
      changes: number;
      grossMicros: number;
      netMicros: number;
      restCalls: number;
      restGross: number;
      mcpCalls: number;
      mcpGross: number;
    } & Record<string, string>
  >(
    `WITH c AS (${chargedCalls(q, rowParams)})
     SELECT ${keyExpr} AS key, ${idExpr} AS id, ${dimOut},
            "isSimulated", calls, records, changes, "grossMicros", "netMicros",
            "restCalls", "restGross", "mcpCalls", "mcpGross"
     FROM (
       SELECT ${dimCols},
              c.is_simulated AS "isSimulated",
              count(*)::int AS calls,
              sum(c.records)::bigint AS records,
              sum(c.changes)::bigint AS changes,
              sum(c.gross)::bigint AS "grossMicros",
              sum(c.net)::bigint AS "netMicros",
              (count(*) FILTER (WHERE c.channel = 'REST'))::int AS "restCalls",
              coalesce(sum(c.gross) FILTER (WHERE c.channel = 'REST'), 0)::bigint AS "restGross",
              (count(*) FILTER (WHERE c.channel = 'MCP'))::int AS "mcpCalls",
              coalesce(sum(c.gross) FILTER (WHERE c.channel = 'MCP'), 0)::bigint AS "mcpGross"
       FROM c
       GROUP BY ${groupCols}, c.is_simulated
     ) g
     ORDER BY ${order}`,
    rowParams,
  );

  return {
    kpis: { ...kpi.rows[0]!, payableMicros: payable.rows[0]!.payable },
    rows: rows.rows.map((r) => ({
      key: r.key,
      id: r.id,
      dims: dimsOf(dims, r),
      isSimulated: r.isSimulated,
      calls: r.calls,
      records: r.records,
      changes: r.changes,
      grossMicros: r.grossMicros,
      commissionMicros: r.grossMicros - r.netMicros,
      netMicros: r.netMicros,
      channels: {
        REST: { calls: r.restCalls, grossMicros: r.restGross },
        MCP: { calls: r.mcpCalls, grossMicros: r.mcpGross },
      },
    })),
  };
}

function dimsOf(dims: readonly GroupDim[], r: Record<string, unknown>): EarningsDims {
  const out: EarningsDims = {};
  for (const d of dims) {
    const id = String(r[`${d}Id`]);
    const key = String(r[`${d}Key`]);
    if (d === 'buyer') out.buyer = { id, name: key };
    else if (d === 'dataset') out.dataset = { id, key };
    else if (d === 'day') out.day = id;
    else out.channel = id as 'REST' | 'MCP';
  }
  return out;
}
