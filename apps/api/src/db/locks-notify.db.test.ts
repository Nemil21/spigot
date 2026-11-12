import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { tryAdvisoryLock, tryAdvisoryXactLock, withAdvisoryXactLock } from './locks.js';
import { notify } from './notify.js';
import { drainNotifications, twoPools, testDatabaseUrl, type TwoPools } from './test-db.js';
import { createDb } from './tx.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!testDatabaseUrl)('advisory locks', () => {
  let pools: TwoPools;
  beforeAll(async () => {
    pools = await twoPools();
  });
  afterAll(async () => {
    await pools?.close();
  });

  test('tryAdvisoryLock: one holder across processes until release', async () => {
    const first = await tryAdvisoryLock(pools.a, 'payout');
    expect(first).not.toBeNull();
    expect(await tryAdvisoryLock(pools.b, 'payout')).toBeNull();
    const other = await tryAdvisoryLock(pools.b, 'other'); // different name, different lock
    expect(other).not.toBeNull();
    await other!.release();
    await first!.release();
    await first!.release(); // idempotent
    const second = await tryAdvisoryLock(pools.b, 'payout');
    expect(second).not.toBeNull();
    await second!.release();
  });

  test('withAdvisoryXactLock: shared holders coexist; exclusive waits for them to commit', async () => {
    const a = createDb(pools.a);
    const b = createDb(pools.b);
    const key = 'dataset:00000000-0000-0000-0000-000000000001';
    const order: string[] = [];

    let releaseShared!: () => void;
    const sharedHeld = new Promise<void>((r) => (releaseShared = r));
    let acquired!: () => void;
    const shared1Acquired = new Promise<void>((r) => (acquired = r));
    const shared1 = a.tx(async (tx) => {
      await withAdvisoryXactLock(tx, key, { shared: true });
      order.push('shared1');
      acquired();
      await sharedHeld;
      order.push('shared1-commit');
    });
    let exclusive: Promise<void> | undefined;
    try {
      await shared1Acquired;
      // A second shared holder gets in while shared1 holds the lock.
      await b.tx(async (tx) => {
        await withAdvisoryXactLock(tx, key, { shared: true });
        order.push('shared2');
        expect(await tryAdvisoryXactLock(tx, 'unrelated')).toBe(true);
      });
      exclusive = b.tx(async (tx) => {
        await withAdvisoryXactLock(tx, key);
        order.push('exclusive');
      });
      await sleep(50);
      expect(order).toEqual(['shared1', 'shared2']); // exclusive still waiting on shared1
    } finally {
      releaseShared();
    }
    await Promise.all([shared1, exclusive]);
    expect(order).toEqual(['shared1', 'shared2', 'shared1-commit', 'exclusive']);
  });
});

describe.skipIf(!testDatabaseUrl)('notify', () => {
  let pools: TwoPools;
  let listener: pg.Client;
  const received: Array<{ channel: string; payload: unknown }> = [];

  beforeAll(async () => {
    pools = await twoPools();
    listener = new pg.Client({ connectionString: pools.db.url });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === 'publisher_events')
        received.push({ channel: n.channel, payload: JSON.parse(n.payload ?? 'null') });
    });
    await listener.query('LISTEN publisher_events');
  });
  afterAll(async () => {
    await listener?.end();
    await pools?.close();
  });

  test('fires on COMMIT, not before, and never on ROLLBACK', async () => {
    const db = createDb(pools.a);
    await db.tx(async (tx) => {
      await notify(tx, 'publisher_events', { type: 'hits', publisherId: 'p1' });
      await drainNotifications(listener, pools.b); // commits after our NOTIFY was queued
      expect(received).toEqual([]);
    });
    await drainNotifications(listener, pools.b);
    expect(received).toEqual([
      { channel: 'publisher_events', payload: { type: 'hits', publisherId: 'p1' } },
    ]);

    await expect(
      db.tx(async (tx) => {
        await notify(tx, 'publisher_events', { type: 'rolled-back' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await drainNotifications(listener, pools.b);
    expect(received).toHaveLength(1);
  });

  test('rejects bad channels and oversized payloads', async () => {
    await expect(notify(pools.a, 'Bad-Channel', {})).rejects.toThrow(/bad channel/);
    await expect(notify(pools.a, 'publisher_events', { blob: 'x'.repeat(8_000) })).rejects.toThrow(/exceeds/);
  });
});
