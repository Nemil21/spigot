import type { FastifyPluginAsync } from 'fastify';
import { createDb, createPool, type Db } from '../db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The request-traffic pool and `tx()` helper (SP-002), for every route (SP-007a). */
    db: Db;
  }
}

/**
 * `app.db`: one pool per app, from `DATABASE_URL`. pg connects lazily, so building the app (and
 * unit tests without Postgres) never opens a connection; the pool closes with the app.
 */
const dbPlugin: FastifyPluginAsync = async (app) => {
  const pool = createPool(app.config.DATABASE_URL, { applicationName: 'spigot-api' });
  app.decorate('db', createDb(pool));
  app.addHook('onClose', async () => {
    await pool.end();
  });
};

export default dbPlugin;
