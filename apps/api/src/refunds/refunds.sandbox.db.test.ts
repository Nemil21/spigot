import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { isSandboxPayPalBase, loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { loadDotenv } from '../env.js';
import { ledgerCheck } from '../ledger/check.js';
import { PayPalRestClient } from '../paypal/index.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, serverCardTopup, type TopupDeps } from '../topups/index.js';
import { setRefundDeps } from './deps.js';

/**
 * SP-049 against the real PayPal sandbox (S9 through the endpoint). Local / manual only, never in CI:
 *   PAYPAL_MODE=sandbox TEST_DATABASE_URL=… npx vitest run --project db \
 *     apps/api/src/refunds/refunds.sandbox.db.test.ts
 * Only a `PAYPAL_MODE` set in the shell enables it (a `.env` value doesn't). Reads credentials
 * from `.env`; never prints them. Refuses a non-sandbox base. The $20 top-up is a server-side SIM
 * card capture (SP-018b), so no browser approval is needed.
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox' && !!testDatabaseUrl;

describe.skipIf(!enabled)('SP-049 refund of unused balance: PayPal sandbox', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let deps: TopupDeps;
  let pp: PayPalRestClient;
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
    pp = new PayPalRestClient({
      baseUrl: base,
      clientId: process.env.PAYPAL_CLIENT_ID ?? '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      allowRawCard: true,
      timeoutMs: 30_000,
    });
    deps = {
      db: app.db,
      config: { ...app.config, PAYPAL_MODE: 'sandbox', paypalIsSandbox: true },
      pp,
    };
    setRefundDeps({ db: app.db, pp });
  });
  afterAll(async () => {
    setRefundDeps(undefined);
    await app?.close();
    await db?.drop();
  });

  it('refunds $7.40 of a $20 top-up: refund id stored, balance −$7.40, PARTIALLY_REFUNDED; a replay refunds nothing more', async () => {
    const signup = await request(app.server)
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'S9', email: `s9-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(signup.status).toBe(201);
    const buyerId = signup.body.buyerId as string;
    const cookie = (signup.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';', 1)[0])
      .join('; ');

    const topup = await serverCardTopup(deps, {
      topupId: randomUUID(),
      buyerId,
      amountCents: 2000,
      trigger: 'SIM',
    });
    expect(topup, JSON.stringify(topup)).toMatchObject({ status: 'COMPLETED' });
    const captureId = topup.topup.paypalCaptureId!;

    const key = randomUUID();
    const send = () =>
      request(app.server)
        .post('/api/buyer/refunds')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .send({ amountCents: 740 });
    const res = await send();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const r = res.body.refunds[0];
    expect(r).toMatchObject({ amountCents: 740, status: 'COMPLETED' });
    expect(r.paypalRefundId).toMatch(/\S/);
    expect(await balanceOf(app.db.pool, buyerId)).toBe(12_600_000);
    const { rows } = await app.db.pool.query(
      `SELECT status, refunded_cents AS refunded FROM topups WHERE id = $1`,
      [topup.topup.id],
    );
    expect(rows[0]).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 740 });

    // Same Idempotency-Key → the stored refund; same PayPal-Request-Id → PayPal's original refund.
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.refunds[0].paypalRefundId).toBe(r.paypalRefundId);
    const again = await pp.refundCapture(captureId, 740, r.refundId);
    expect(again).toMatchObject({ refundId: r.paypalRefundId, replayed: true });
    expect(await balanceOf(app.db.pool, buyerId)).toBe(12_600_000);

    expect((await ledgerCheck(app.db.pool)).mismatches).toEqual([]);
  }, 120_000);
});
