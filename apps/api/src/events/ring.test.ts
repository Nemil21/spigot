import { describe, expect, it } from 'vitest';
import { publisherEvent } from '@spigot/shared/events';
import { EventRing, RING_MS } from './bus.js';

const A = '3f2b9c1e-6a4d-4e8f-9b0a-1c2d3e4f5a6b';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ev = (publisherId: string, id = 'x') => publisherEvent(publisherId, 'call.charged', [id]);

describe('EventRing', () => {
  it('ids are <boot>-<seq>, monotonic in the process', () => {
    const r = new EventRing(RING_MS, 100, 'abcd1234');
    expect(r.currentId()).toBe('abcd1234-0');
    expect(r.push(ev(A), 0).id).toBe('abcd1234-1');
    expect(r.push(ev(B), 0).id).toBe('abcd1234-2');
    expect(r.currentId()).toBe('abcd1234-2');
  });

  it("replays only the publisher's own events after the given id", () => {
    const r = new EventRing(RING_MS, 100, 'aa');
    r.push(ev(A, 'a1'), 0);
    r.push(ev(B, 'b1'), 0);
    r.push(ev(A, 'a2'), 0);
    expect(r.since(A, 'aa-1', 0)?.map((e) => e.event.ids[0])).toEqual(['a2']);
    expect(r.since(A, 'aa-0', 0)?.map((e) => e.event.ids[0])).toEqual(['a1', 'a2']);
    expect(r.since(B, 'aa-0', 0)?.map((e) => e.event.ids[0])).toEqual(['b1']);
    expect(r.since(A, 'aa-3', 0)).toEqual([]);
  });

  it.each([
    ['another process / an old boot', 'bb-1'],
    ['a malformed id', 'nonsense'],
    ['an id from the future', 'aa-99'],
    ['an empty-ish id', ' '],
  ])('answers resync (null) for %s', (_why, id) => {
    const r = new EventRing(RING_MS, 100, 'aa');
    r.push(ev(A), 0);
    expect(r.since(A, id, 0)).toBeNull();
  });

  it('events older than 5 minutes age out; asking from before them is a resync', () => {
    const r = new EventRing(RING_MS, 100, 'aa');
    r.push(ev(A, 'old'), 0);
    r.push(ev(A, 'new'), RING_MS);
    expect(r.since(A, 'aa-0', RING_MS)?.length).toBe(2);
    // One ms later the first is gone: a client that last saw seq 0 can't be replayed.
    expect(r.since(A, 'aa-0', RING_MS + 1)).toBeNull();
    expect(r.since(A, 'aa-1', RING_MS + 1)?.map((e) => e.event.ids[0])).toEqual(['new']);
  });

  it('the size cap evicts the oldest, which also forces a resync for clients behind it', () => {
    const r = new EventRing(RING_MS, 3, 'aa');
    for (let i = 1; i <= 5; i++) r.push(ev(A, `e${i}`), 0);
    expect(r.size).toBe(3);
    expect(r.since(A, 'aa-1', 0)).toBeNull();
    expect(r.since(A, 'aa-2', 0)?.map((e) => e.event.ids[0])).toEqual(['e3', 'e4', 'e5']);
  });

  it('a LISTEN gap makes everything before it a resync; later events replay', () => {
    const r = new EventRing(RING_MS, 100, 'aa');
    r.push(ev(A), 0);
    r.gap();
    // A client that saw seq 1 (the newest before the drop) may have missed events in the gap.
    expect(r.since(A, 'aa-0', 0)).toBeNull();
    expect(r.since(A, 'aa-1', 0)).toBeNull();
    // The gap's own id (what the resync frame carries) is a complete resume point.
    expect(r.currentId()).toBe('aa-2');
    expect(r.since(A, 'aa-2', 0)).toEqual([]);
    r.push(ev(A, 'after'), 0);
    expect(r.since(A, 'aa-2', 0)?.map((e) => e.event.ids[0])).toEqual(['after']);
  });
});
