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

export interface EarningsQuery extends Range {
  publisherId: string;
  groupBy: GroupBy;
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

export interface EarningsRow {
  /** Display key: buyer name, `site/dataset`, or `YYYY-MM-DD` (UTC). */
  key: string;
  /** Stable id for grouping: buyer id, dataset id, or the day. */
  id: string;
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
const GROUP_SQL: Record<GroupBy, { id: string; key: string; order: string }> = {
  buyer: {
    id: `c.buyer_id::text`,
    key: `coalesce(c.buyer_name, 'Buyer ' || left(c.buyer_id::text, 8))`,
    order: `"grossMicros" DESC, key, id`,
  },
  dataset: {
    id: `c.dataset_id::text`,
    key: `coalesce(c.site_slug, c.site_origin) || '/' || c.dataset_slug`,
    order: `"grossMicros" DESC, key, id`,
  },
  day: {
    id: `to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    key: `to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    order: `id, "isSimulated"`,
  },
};

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

  const g = GROUP_SQL[q.groupBy];
  const rowParams: unknown[] = [];
  const rows = await client.query<{
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
  }>(
    `WITH c AS (${chargedCalls(q, rowParams)})
     SELECT key, id, "isSimulated", calls, records, changes, "grossMicros", "netMicros",
            "restCalls", "restGross", "mcpCalls", "mcpGross"
     FROM (
       SELECT ${g.key} AS key,
              ${g.id} AS id,
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
       GROUP BY 1, 2, 3
     ) g
     ORDER BY ${g.order}`,
    rowParams,
  );

  return {
    kpis: { ...kpi.rows[0]!, payableMicros: payable.rows[0]!.payable },
    rows: rows.rows.map((r) => ({
      key: r.key,
      id: r.id,
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
