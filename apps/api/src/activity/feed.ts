import { z } from 'zod';
import {
  ACTIVITY_ACTIONS,
  activityLine,
  type ActivityAction,
  type ActivityFacts,
  type PayoutItemStatus,
} from '@spigot/shared';
import type { Queryable } from '../db/index.js';
import { parse } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';

/**
 * Publisher activity feed (api.md §`GET /api/publishers/me/activity`; SP-027a), shown on W04.
 * The newest `audit_events` for the session's publisher with an `ACTIVITY_ACTIONS` action:
 *
 * - rows whose `publisher_id` is this publisher (proposals, publishes, charged calls, payouts,
 *   crawls), and
 * - `TOPUP_COMPLETED` of **their buyers**: buyers with at least one call on this publisher's
 *   datasets. Top-up rows carry no publisher (a buyer's balance isn't tied to one), so they are
 *   found through `api_calls`. Only the buyer name and amount reach the line; no PayPal id.
 *
 * Each event has `isSimulated` (actor `SIM`, `data.isSimulated`, a SIM top-up, a SIM call or a
 * SIM buyer) and a display `line` from `activityLine` in `@spigot/shared` (the money copy rule).
 * Calls hidden by the demo reset (`api_calls.hidden_at`, SP-038) are left out. Newest first,
 * ties by id.
 */

export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 200;

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_ACTIVITY_LIMIT).default(DEFAULT_ACTIVITY_LIMIT),
});

export interface ActivityEvent {
  id: string;
  at: string;
  action: ActivityAction;
  entity: string | null;
  entityId: string | null;
  isSimulated: boolean;
  line: string;
}

interface Row {
  id: string;
  at: Date;
  action: ActivityAction;
  entity: string | null;
  entity_id: string | null;
  data: Record<string, unknown> | null;
  is_simulated: boolean;
  type_name: string | null;
  record_count: number | null;
  buyer_name: string | null;
  call_price_micros: string | null;
  call_records: number | null;
  topup_cents: number | null;
  payout_net_cents: number | null;
  payout_status: PayoutItemStatus | null;
}

/** A finite number from a jsonb value, else null. */
function n(v: unknown): number | null {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Facts for the line: joined columns first (authoritative), then the audit row's `data`. */
function factsOf(r: Row): ActivityFacts {
  const d = r.data ?? {};
  switch (r.action) {
    case 'SCHEMA_PROPOSED':
    case 'DATASET_PUBLISHED':
      return {
        typeName: r.type_name ?? s(d.typeName),
        records: n(d.records) ?? n(d.recordCount) ?? (r.record_count || null),
      };
    case 'CALL_CHARGED':
      return {
        buyerName: r.buyer_name,
        typeName: r.type_name ?? s(d.typeName),
        priceMicros: n(r.call_price_micros) ?? n(d.priceMicros),
        records: r.call_records ?? n(d.records) ?? n(d.recordsReturned),
      };
    case 'TOPUP_COMPLETED':
      return { buyerName: r.buyer_name, amountCents: r.topup_cents ?? n(d.amountCents) };
    case 'PAYOUT_SENT':
    case 'PAYOUT_SETTLED':
      return {
        amountCents: r.payout_net_cents ?? n(d.netCents),
        payoutStatus: (s(d.status) as PayoutItemStatus | null) ?? r.payout_status,
      };
    case 'CRAWL_RUN_DONE':
      return {
        crawlStatus: s(d.status),
        pagesFetched: n(d.pagesFetched),
        recordsChanged:
          (n(d.recordsAdded) ?? 0) + (n(d.recordsUpdated) ?? 0) + (n(d.recordsRemoved) ?? 0),
      };
  }
}

/** The publisher's last `limit` activity events, newest first. */
export async function activityFeed(
  q: Queryable,
  publisherId: string,
  limit = DEFAULT_ACTIVITY_LIMIT,
): Promise<ActivityEvent[]> {
  // Validates the session id (forPublisher throws on a non-uuid); every branch filters by it.
  forPublisher(publisherId);
  const actions = [...ACTIVITY_ACTIONS];
  const { rows } = await q.query<Row>(
    `WITH my_buyers AS (
       SELECT DISTINCT c.buyer_id
         FROM api_calls c
         JOIN datasets d ON d.id = c.dataset_id
         JOIN sites s ON s.id = d.site_id
        WHERE s.publisher_id = $1
     ),
     picked AS (
       (SELECT e.id FROM audit_events e
         WHERE e.publisher_id = $1 AND e.action = ANY($2::text[])
         ORDER BY e.at DESC, e.id DESC LIMIT $3)
       UNION
       (SELECT e.id FROM audit_events e
          JOIN topups t ON t.id = e.entity_id
         WHERE e.action = 'TOPUP_COMPLETED' AND e.entity IN ('topups', 'topup')
           AND t.buyer_id IN (SELECT buyer_id FROM my_buyers)
         ORDER BY e.at DESC, e.id DESC LIMIT $3)
     )
     SELECT e.id::text AS id, e.at, e.action, e.entity, e.entity_id, e.data,
            (e.actor_type = 'SIM'
              OR COALESCE(e.data->>'isSimulated', '') = 'true'
              OR COALESCE(t.trigger = 'SIM', false)
              OR COALESCE(c.is_simulated, false)
              OR COALESCE(b.is_simulated, false)) AS is_simulated,
            ds.type_name, ds.record_count,
            b.name AS buyer_name,
            c.price_micros AS call_price_micros, c.records_returned AS call_records,
            t.amount_cents AS topup_cents,
            pi.net_cents AS payout_net_cents, pi.status AS payout_status
       FROM picked
       JOIN audit_events e ON e.id = picked.id
       LEFT JOIN topups t
              ON e.entity IN ('topups', 'topup') AND t.id = e.entity_id
       LEFT JOIN api_calls c
              ON e.entity IN ('api_calls', 'api_call') AND c.id = e.entity_id
       LEFT JOIN payout_items pi
              ON e.entity IN ('payout_items', 'payout_item') AND pi.id = e.entity_id
                 AND pi.publisher_id = $1
       LEFT JOIN schema_versions sv
              ON e.entity IN ('schema_versions', 'schema_version') AND sv.id = e.entity_id
       LEFT JOIN datasets ds
              ON ds.id = CASE
                   WHEN e.entity IN ('datasets', 'dataset') THEN e.entity_id
                   WHEN sv.id IS NOT NULL THEN sv.dataset_id
                   WHEN c.id IS NOT NULL THEN c.dataset_id
                   WHEN e.data ? 'datasetId' AND (e.data->>'datasetId') ~* '^[0-9a-f-]{36}$'
                     THEN (e.data->>'datasetId')::uuid
                 END
             AND EXISTS (SELECT 1 FROM sites so WHERE so.id = ds.site_id AND so.publisher_id = $1)
       LEFT JOIN buyers b ON b.id = COALESCE(t.buyer_id, c.buyer_id)
      WHERE c.hidden_at IS NULL
      ORDER BY e.at DESC, e.id DESC
      LIMIT $3`,
    [publisherId, actions, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    isSimulated: r.is_simulated,
    line: activityLine(r.action, factsOf(r)),
  }));
}

export function parseActivityQuery(query: unknown): number {
  return parse(activityQuery, query, 'query').limit;
}
