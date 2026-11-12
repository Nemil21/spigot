import { z } from 'zod';

/**
 * Publisher dashboard events (api.md `GET /api/publishers/me/events`). Producers publish with
 * `pg_notify(PUBLISHER_EVENTS_CHANNEL, encodePublisherEvent(e))` inside their business transaction,
 * so a rollback emits nothing; SP-025 LISTENs on the channel and fans out by `publisherId`.
 * Payloads carry ids only (the client refetches): never emails, amounts or PayPal payer ids.
 *
 * Producers: `hits` SP-008b · `crawl.progress` SP-009a2 · `proposal.ready` SP-012a ·
 * `dataset.extract.progress` SP-014a · `call.charged` SP-016 · `payout.updated` SP-021 ·
 * `dataset.stale` SP-052a (drift: the dataset went LIVE_STALE; ids = dataset, crawl run).
 */
export const PUBLISHER_EVENTS_CHANNEL = 'publisher_events';

export const PUBLISHER_EVENT_TYPES = [
  'hits',
  'call.charged',
  'payout.updated',
  'proposal.ready',
  'crawl.progress',
  'dataset.extract.progress',
  'dataset.stale',
] as const;
export type PublisherEventType = (typeof PUBLISHER_EVENT_TYPES)[number];

/**
 * Most ids per event. Keeps the JSON well under Postgres' 8,000-byte NOTIFY payload limit
 * (100 UUIDs ≈ 3.9 KB); a producer with more sends several events or an empty list (refetch all).
 */
export const MAX_EVENT_IDS = 100;
/** Postgres rejects NOTIFY payloads of 8,000 bytes or more. */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7_999;

const base = {
  publisherId: z.string().min(1),
  /** Ids of the rows that changed (site, call, batch, dataset, crawl run…), for the client to refetch. */
  ids: z.array(z.string().min(1)).max(MAX_EVENT_IDS),
  /** ISO timestamp, server time. */
  at: z.iso.datetime({ offset: true }),
};

const eventOf = <T extends PublisherEventType>(type: T) =>
  z.object({ type: z.literal(type), ...base });

export const publisherEventSchema = z.discriminatedUnion('type', [
  eventOf('hits'),
  eventOf('call.charged'),
  eventOf('payout.updated'),
  eventOf('proposal.ready'),
  eventOf('crawl.progress'),
  eventOf('dataset.extract.progress'),
  eventOf('dataset.stale'),
]);

export type PublisherEvent = z.infer<typeof publisherEventSchema>;

export function publisherEvent(
  publisherId: string,
  type: PublisherEventType,
  ids: readonly string[],
  at: Date = new Date(),
): PublisherEvent {
  return publisherEventSchema.parse({ publisherId, type, ids: [...ids], at: at.toISOString() });
}

// No TextEncoder: this package compiles without DOM or Node types.
function utf8Length(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** JSON payload for `pg_notify`. Throws if the event is invalid or too large to NOTIFY. */
export function encodePublisherEvent(event: PublisherEvent): string {
  const json = JSON.stringify(publisherEventSchema.parse(event));
  if (utf8Length(json) > MAX_NOTIFY_PAYLOAD_BYTES) {
    throw new RangeError(`publisher event payload exceeds ${MAX_NOTIFY_PAYLOAD_BYTES} bytes`);
  }
  return json;
}

/** Parses a NOTIFY payload; returns null for anything malformed (the listener logs and drops it). */
export function parsePublisherEvent(payload: string): PublisherEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = publisherEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}
