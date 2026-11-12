// Throwaway migrated databases for *.db.test.ts (SP-002).
//
// Needs TEST_DATABASE_URL pointing at a server where the user may CREATE DATABASE
// (CI: the postgres service; locally: scripts/dev-db.sh). Each call creates a fresh
// `spigot_test_*` database, runs every migration, and returns its URL plus a drop().

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.mjs';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/**
 * @param {{ migrate?: boolean }} [opts]
 * @returns {Promise<{ url: string, name: string, drop: () => Promise<void> }>}
 */
export async function createTestDatabase({ migrate: runMigrations = true } = {}) {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  const name = `spigot_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(testDatabaseUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  if (runMigrations) await migrate({ connectionString: url });

  return {
    url,
    name,
    async drop() {
      const c = new pg.Client({ connectionString: testDatabaseUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
