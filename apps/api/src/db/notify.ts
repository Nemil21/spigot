import type { Queryable } from './pool.js';

/**
 * `pg_notify` a JSON payload (SP-002). Called inside a transaction, Postgres delivers it only
 * on COMMIT (and drops it on ROLLBACK), so listeners never see an event for a write that
 * didn't happen. Channels in use: `publisher_events` (SP-025's SSE bus), `crawl_progress`.
 */
const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// Postgres rejects payloads of 8000 bytes or more.
const MAX_PAYLOAD_BYTES = 7999;

export async function notify(tx: Queryable, channel: string, payload: unknown): Promise<void> {
  if (!CHANNEL_RE.test(channel)) throw new Error(`notify: bad channel ${channel}`);
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`notify: payload for ${channel} exceeds ${MAX_PAYLOAD_BYTES} bytes; send ids, not rows`);
  }
  await tx.query('SELECT pg_notify($1, $2)', [channel, text]);
}
