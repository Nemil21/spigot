import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createPool } from './pool.js';

export { testDatabaseUrl } from '@spigot/db/testing.mjs';

/**
 * A fresh migrated database plus two independent pools, standing in for two API processes
 * in *.db.test.ts concurrency tests.
 */
export interface TwoPools {
  a: pg.Pool;
  b: pg.Pool;
  db: TestDatabase;
  close(): Promise<void>;
}

export async function twoPools(): Promise<TwoPools> {
  const db = await createTestDatabase();
  const a = createPool(db.url, { max: 8, applicationName: 'test-a' });
  const b = createPool(db.url, { max: 8, applicationName: 'test-b' });
  return {
    a,
    b,
    db,
    async close() {
      await Promise.all([a.end(), b.end()]);
      await db.drop();
    },
  };
}

const DRAIN_CHANNEL = 'spigot_test_drain';

/**
 * Wait until `listener` has received every notification committed before this call, instead of
 * sleeping and hoping. Postgres keeps one notification queue per database and delivers it to
 * each listener in commit order, so once a sentinel sent now arrives, everything before it has.
 */
export async function drainNotifications(
  listener: pg.ClientBase,
  sender: pg.Pool | pg.ClientBase,
): Promise<void> {
  await listener.query(`LISTEN ${DRAIN_CHANNEL}`);
  const token = randomUUID();
  const arrived = new Promise<void>((resolve) => {
    const on = (n: pg.Notification) => {
      if (n.channel !== DRAIN_CHANNEL || n.payload !== token) return;
      listener.off('notification', on);
      resolve();
    };
    listener.on('notification', on);
  });
  await sender.query('SELECT pg_notify($1, $2)', [DRAIN_CHANNEL, token]);
  await arrived;
}
