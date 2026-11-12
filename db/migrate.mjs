#!/usr/bin/env node
// Spigot migration runner (SP-002), adapted from Holdfast's.
//
// Applies db/migrations/NNN_<topic>.sql in filename order. Idempotent: applied files are
// recorded in schema_migrations with a sha256 checksum and skipped on re-run; an applied
// file whose contents changed is an error (write a new migration instead). Each file runs
// in its own transaction, and the whole run holds an advisory lock, so two concurrent
// deploys never apply the same file twice.
//
// Naming after the schema freeze: NNN_sp0XX_<topic>.sql (e.g. 002_sp049_refund_status.sql).
// Two files with the same NNN are refused before anything runs, so two tickets can't
// collide silently.
//
// Usage:   DATABASE_URL=postgres://... npm run migrate   (or put DATABASE_URL in the repo-root .env)
// Library: import { migrate } from '@spigot/db/migrate.mjs'

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, 'migrations');

// Arbitrary constant; any process migrating this database takes the same lock.
const LOCK_KEY = 7_300_002;

const NAME_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * Read and validate the migration files: every `.sql` must be named `NNN_<topic>.sql`
 * and no two may share `NNN`.
 */
export async function listMigrations(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const byNumber = new Map();
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) {
      throw new Error(
        `migrate: bad migration file name "${name}"; use NNN_sp0XX_<topic>.sql (lowercase, digits, underscores)`,
      );
    }
    const prior = byNumber.get(m[1]);
    if (prior) {
      throw new Error(
        `migrate: duplicate migration number ${m[1]}: "${prior}" and "${name}". ` +
          'Renumber yours to the next free number after rebasing.',
      );
    }
    byNumber.set(m[1], name);
  }

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { name, sql, checksum };
    }),
  );
}

/**
 * Apply pending migrations.
 * @param {{ connectionString?: string, client?: pg.Client, dir?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function migrate({ connectionString, client, dir, log = () => {} } = {}) {
  // Validate files before touching the database.
  const migrations = await listMigrations(dir);

  const own = !client;
  if (own) {
    if (!connectionString) throw new Error('migrate: DATABASE_URL is not set');
    client = new pg.Client({ connectionString });
    await client.connect();
  }

  const applied = [];
  const skipped = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name        text PRIMARY KEY,
          checksum    text NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
      const done = new Map(rows.map((r) => [r.name, r.checksum]));

      for (const m of migrations) {
        const prior = done.get(m.name);
        if (prior !== undefined) {
          if (prior !== m.checksum) {
            throw new Error(
              `migrate: ${m.name} was already applied but its contents changed; add a new migration instead`,
            );
          }
          skipped.push(m.name);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
            m.name,
            m.checksum,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          err.message = `migrate: ${m.name} failed: ${err.message}`;
          throw err;
        }
        applied.push(m.name);
        log(`applied ${m.name}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    if (own) await client.end();
  }
  return { applied, skipped };
}

/**
 * Load the repo-root `.env` (the parent of db/) if it exists, so `npm run migrate` works
 * locally. Variables already set in the environment win (Render sets DATABASE_URL directly
 * and has no .env). Never logs values. Needs Node >= 20.12 for process.loadEnvFile.
 */
export function loadRootDotenv(file = path.join(here, '..', '.env')) {
  if (!existsSync(file) || typeof process.loadEnvFile !== 'function') return null;
  process.loadEnvFile(file);
  return file;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadRootDotenv();
  migrate({ connectionString: process.env.DATABASE_URL, log: (msg) => console.log(`[migrate] ${msg}`) })
    .then(({ applied, skipped }) => {
      console.log(`[migrate] done: ${applied.length} applied, ${skipped.length} already up to date`);
    })
    .catch((err) => {
      // Never print the connection string; pg error messages do not include it.
      console.error(err.message);
      process.exit(1);
    });
}
