import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_IDS,
  PUBLISHER_EVENTS_CHANNEL,
  PUBLISHER_EVENT_TYPES,
  encodePublisherEvent,
  parsePublisherEvent,
  publisherEvent,
} from './events.js';

const uuid = '3f2b9c1e-6a4d-4e8f-9b0a-1c2d3e4f5a6b';
const at = new Date('2026-11-12T06:30:00.000Z');

describe('PublisherEvent', () => {
  it('uses the agreed channel and types', () => {
    expect(PUBLISHER_EVENTS_CHANNEL).toBe('publisher_events');
    expect(PUBLISHER_EVENT_TYPES).toEqual([
      'hits',
      'call.charged',
      'payout.updated',
      'proposal.ready',
      'crawl.progress',
      'dataset.extract.progress',
    ]);
  });

  it.each(PUBLISHER_EVENT_TYPES)('round-trips a %s event through the NOTIFY payload', (type) => {
    const e = publisherEvent(uuid, type, [uuid], at);
    expect(e).toEqual({ publisherId: uuid, type, ids: [uuid], at: '2026-11-12T06:30:00.000Z' });
    expect(parsePublisherEvent(encodePublisherEvent(e))).toEqual(e);
  });

  it('rejects unknown types and too many ids', () => {
    // @ts-expect-error not a PublisherEventType
    expect(() => publisherEvent(uuid, 'call.refunded', [], at)).toThrow();
    const ids = Array.from({ length: MAX_EVENT_IDS + 1 }, () => uuid);
    expect(() => publisherEvent(uuid, 'hits', ids, at)).toThrow();
  });

  it('keeps the largest valid event under the 8,000-byte NOTIFY limit', () => {
    const ids = Array.from({ length: MAX_EVENT_IDS }, () => uuid);
    const payload = encodePublisherEvent(publisherEvent(uuid, 'dataset.extract.progress', ids, at));
    expect(payload.length).toBeLessThan(8000);
  });

  it('refuses to encode a payload Postgres would reject', () => {
    const big = 'é'.repeat(4000); // 8,000 UTF-8 bytes in one id
    expect(() =>
      encodePublisherEvent({ publisherId: uuid, type: 'hits', ids: [big], at: at.toISOString() }),
    ).toThrow(RangeError);
  });

  it('returns null for malformed payloads', () => {
    expect(parsePublisherEvent('not json')).toBeNull();
    expect(parsePublisherEvent('{}')).toBeNull();
    expect(
      parsePublisherEvent(
        JSON.stringify({ publisherId: uuid, type: 'hits', ids: [], at: 'yesterday' }),
      ),
    ).toBeNull();
  });
});
