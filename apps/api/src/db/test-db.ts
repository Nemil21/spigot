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
