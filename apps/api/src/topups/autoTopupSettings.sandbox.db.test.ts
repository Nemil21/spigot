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
import { agentTopUp } from '../services/agentTopUp.js';
import { REQUIRED_ENV } from '../test/env.js';
import { autoTopUp } from './autoTopup.js';
import { getAutoTopupSettings } from './autoTopupSettings.js';
import { balanceOf, SIM_TEST_CARDS, type TopupDeps } from './index.js';

/**
 * SP-047b against the real PayPal sandbox. Local / manual only, never in CI:
 *   PAYPAL_MODE=sandbox TEST_DATABASE_URL=… npx vitest run --project db \
 *     apps/api/src/topups/autoTopupSettings.sandbox.db.test.ts
 * Only a `PAYPAL_MODE` set in the shell enables it (a `.env` value doesn't). Reads credentials
 * from `.env`; never prints them. Refuses a non-sandbox base.
 *
 * Vaults a sandbox test card (card + `store_in_vault`), then: MCP `top_up` from that vault (MIT,
 * `stored_credential`) → COMPLETED and credited; `demo:decline`'s flag → the next AUTO top-up
 * sends `PayPal-Mock-Response INSTRUMENT_DECLINED` → FAILED, auto top-up off, W11 declined state.
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox' && !!testDatabaseUrl;

describe.skipIf(!enabled)('SP-047b vault top-up + mock decline: PayPal sandbox', () => {
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
        allowMockResponse: true,
        timeoutMs: 30_000,
      }),
    };
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('vault a card, top_up from it (MIT) → COMPLETED; mock decline on the next AUTO → FAILED, auto off', async () => {
    const res = await request(app.server)
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({
        name: 'Vault',
        email: `vault-${randomUUID()}@example.com`,
        password: 'correct horse',
      });
    expect(res.status).toBe(201);
    const buyerId = res.body.buyerId as string;

    // A $5 card order with store_in_vault: PayPal captures and returns the vault id.
    const saved = await deps.pp.createTopupOrder({
      topupId: randomUUID(),
      amountCents: 500,
      source: { kind: 'card', card: SIM_TEST_CARDS[0]!, vault: true },
    });
    expect(saved.status, JSON.stringify(saved)).toBe('COMPLETED');
    const vault = saved.status === 'COMPLETED' ? saved.vault : null;
    expect(vault?.id).toBeTruthy();
    await app.db.pool.query(
      `UPDATE buyers SET vault_id = $2, vault_kind = 'CARD', vault_label = 'Visa ••1111' WHERE id = $1`,
      [buyerId, vault!.id],
    );

    const t = await agentTopUp(deps, {
      buyerId,
      apiKeyId: randomUUID(),
      amountCents: 2000,
      idempotencyKey: randomUUID(),
    });
    expect(t, JSON.stringify(t)).toMatchObject({
      status: 'COMPLETED',
      method: 'VAULT_MIT',
      balanceMicros: 20_000_000,
    });
    expect(await balanceOf(app.db.pool, buyerId)).toBe(20_000_000);

    await app.db.pool.query(
      `UPDATE buyers SET auto_topup_enabled = true, mock_decline_next = true WHERE id = $1`,
      [buyerId],
    );
    const out = await autoTopUp(
      { ...deps, timeoutMs: 30_000 },
      { buyerId, priceMicros: 20_000_001 },
    );
    expect(out, JSON.stringify(out)).toMatchObject({ result: 'DECLINED' });
    const settings = await getAutoTopupSettings(app.db.pool, buyerId);
    expect(settings.enabled).toBe(false);
    expect(settings.declinedAt).toEqual(expect.any(String));
    expect(await balanceOf(app.db.pool, buyerId)).toBe(20_000_000);
  }, 120_000);
});
