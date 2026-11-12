import { PUBLISHER_EVENTS_CHANNEL, publisherEvent, type GateHits } from '@spigot/shared';
import { notify, type Db } from '../db/index.js';
import type { GateSite } from './gateAuth.js';

/**
 * `POST /api/gate/hits` (api.md §Gate endpoints; data-model §bot_hits; SP-008b). Upserts the
 * gate's minute buckets into `bot_hits`, summing into an existing row:
 * `hits = hits + EXCLUDED.hits`, `bytes = bytes + EXCLUDED.bytes`. `is_simulated` is part of the
 * key, so SIM and real hits never merge. In the same transaction it stamps
 * `sites.last_gate_seen_at` (the W03 "gate installed" signal) and notifies `publisher_events`
 * `{ type: 'hits' }` (delivered on COMMIT only).
 */

/** Largest `bot_hits.hits` (Postgres int); a sum is clamped rather than failing the whole post. */
export const MAX_INT4 = 2_147_483_647;

/** Largest request body the route accepts (ticket: 1 MB; well over a 10-s flush). */
export const GATE_HITS_BODY_LIMIT = 1_048_576;

interface Row {
  bucket: string;
  category: string;
  botName: string;
  decision: string;
  isSimulated: boolean;
  hits: number;
  bytes: number;
}

/**
 * One row per upsert key: a post may repeat a key (two flush buffers merged on retry, or a
 * backfill), and `INSERT … ON CONFLICT` can't update the same row twice in one statement.
 */
export function aggregateBuckets(buckets: GateHits['buckets']): Row[] {
  const byKey = new Map<string, Row>();
  for (const b of buckets) {
    const bucket = new Date(b.bucket).toISOString();
    const key = JSON.stringify([bucket, b.category, b.botName, b.decision, b.isSimulated]);
    const row = byKey.get(key);
    if (row) {
      row.hits = Math.min(MAX_INT4, row.hits + b.hits);
      row.bytes += b.bytes;
    } else {
      byKey.set(key, {
        bucket,
        category: b.category,
        botName: b.botName,
        decision: b.decision,
        isSimulated: b.isSimulated,
        hits: Math.min(MAX_INT4, b.hits),
        bytes: b.bytes,
      });
    }
  }
  return [...byKey.values()];
}

export async function recordHits(db: Db, site: GateSite, body: GateHits): Promise<number> {
  const rows = aggregateBuckets(body.buckets);
  await db.tx(async (tx) => {
    if (rows.length > 0) {
      await tx.query(
        `INSERT INTO bot_hits AS h
           (site_id, bucket, category, bot_name, decision, is_simulated, hits, bytes)
         SELECT $1, u.bucket, u.category, u.bot_name, u.decision, u.is_simulated, u.hits, u.bytes
           FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::bool[],
                       $7::int[], $8::bigint[])
             AS u(bucket, category, bot_name, decision, is_simulated, hits, bytes)
         ON CONFLICT (site_id, bucket, category, bot_name, decision, is_simulated) DO UPDATE
           SET hits = LEAST(h.hits::bigint + EXCLUDED.hits, ${MAX_INT4})::int,
               bytes = h.bytes + EXCLUDED.bytes,
               updated_at = now()`,
        [
          site.id,
          rows.map((r) => r.bucket),
          rows.map((r) => r.category),
          rows.map((r) => r.botName),
          rows.map((r) => r.decision),
          rows.map((r) => r.isSimulated),
          rows.map((r) => r.hits),
          rows.map((r) => String(r.bytes)),
        ],
      );
    }
    await tx.query(`UPDATE sites SET last_gate_seen_at = now() WHERE id = $1`, [site.id]);
    await notify(tx, PUBLISHER_EVENTS_CHANNEL, publisherEvent(site.publisherId, 'hits', [site.id]));
  });
  return rows.length;
}
