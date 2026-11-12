import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { isSandboxPayPalBase, loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { loadDotenv } from '../env.js';
import { PayPalRestClient } from '../paypal/index.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, createTopupForAgent, serverCardTopup, type TopupDeps } from './index.js';

/**
 * SP-018b against the real PayPal sandbox. Local / manual only, never in CI:
 *   PAYPAL_MODE=sandbox TEST_DATABASE_URL=… npx vitest run --project db \
 *     apps/api/src/topups/topupHelpers.sandbox.db.test.ts
 * Only a `PAYPAL_MODE` set in the shell enables it (a `.env` value doesn't). Reads credentials
 * from `.env`; never prints them. Refuses a non-sandbox base. Approving the agent's link needs a
 * person in a browser, so that half is checked by hand (see the PR).
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox' && !!testDatabaseUrl;

describe.skipIf(!enabled)('SP-018b top-up helpers: PayPal sandbox', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let deps: TopupDeps;
  const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

  beforeAll(async () => {
    loadDotenv();
    const base = process.env.PAYPAL_API_BASE ?? '';
    if (!isSandboxPayPalBase(base)) throw new Error('runs only against a PayPal sandbox base');
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.ready();
    deps = {
      db: app.db,
      config: { ...app.config, PAYPAL_MODE: 'sandbox', paypalIsSandbox: true },
      pp: new PayPalRestClient({
        baseUrl: base,
        clientId: process.env.PAYPAL_CLIENT_ID ?? '',
        clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
        allowRawCard: true,
        timeoutMs: 30_000,
      }),
    };
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  async function newBuyer(): Promise<string> {
    const res = await request(app.server)
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'SIM', email: `sim-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return res.body.buyerId as string;
  }

  it('$20 SIM card top-up captures and credits once; the same id again makes no new order', async () => {
    const buyerId = await newBuyer();
    const input = { topupId: randomUUID(), buyerId, amountCents: 2000, trigger: 'SIM' as const };
    const first = await serverCardTopup(deps, input);
    expect(first, JSON.stringify(first)).toMatchObject({
      status: 'COMPLETED',
      created: true,
      balanceMicros: 20_000_000,
    });
    const second = await serverCardTopup(deps, input);
    expect(second).toMatchObject({ status: 'COMPLETED', created: false });
    expect(second.topup.paypalOrderId).toBe(first.topup.paypalOrderId);
    expect(await balanceOf(app.db.pool, buyerId)).toBe(20_000_000);
    const { rows } = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM ledger_txns WHERE kind = 'TOPUP' AND ref_id = $1`,
      [input.topupId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  }, 120_000);

  it('createTopupForAgent returns a sandbox approve URL', async () => {
    const buyerId = await newBuyer();
    const t = await createTopupForAgent(deps, buyerId, 2000, randomUUID());
    expect(t).toMatchObject({
      status: 'AWAITING_APPROVAL',
      approveUrl: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\//),
    });
  }, 60_000);
});
