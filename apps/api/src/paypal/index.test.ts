import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { REQUIRED_ENV } from '../test/env.js';
import { createPayPalClient, FAKE_PAYPAL_BASE, FakePayPal, sharedFakePayPal } from './index.js';

const config = (extra: Record<string, string> = {}) => loadConfig({ ...REQUIRED_ENV, ...extra });

describe('createPayPalClient', () => {
  it('PAYPAL_MODE=stub → the real client over FakePayPal (shared fake by default)', async () => {
    const pp = createPayPalClient(config({ PAYPAL_MODE: 'stub' }));
    expect(pp.http.baseUrl).toBe(FAKE_PAYPAL_BASE);
    expect(pp.settings.allowRawCard).toBe(true);
    const r = await pp.createTopupOrder({
      topupId: 'idx-1',
      amountCents: 500,
      source: { kind: 'none' },
    });
    expect(r.status).toBe('AWAITING_APPROVAL');
    expect(sharedFakePayPal().order(r.orderId!)).toBeDefined();
  });

  it('stub mode can use a given fake', async () => {
    const fake = new FakePayPal();
    const pp = createPayPalClient(config({ PAYPAL_MODE: 'stub' }), { fake });
    await pp.createTopupOrder({ topupId: 'idx-2', amountCents: 500, source: { kind: 'none' } });
    expect(fake.orders()).toHaveLength(1);
  });

  it('sandbox mode → REST against PAYPAL_API_BASE; raw cards allowed on sandbox only', () => {
    const pp = createPayPalClient(config());
    expect(pp.http.baseUrl).toBe('https://api-m.sandbox.paypal.com');
    expect(pp.settings.allowRawCard).toBe(true);
    const live = createPayPalClient(
      config({
        PAYPAL_API_BASE: 'https://api-m.paypal.com',
        PAYPAL_ENV: 'live',
        ALLOW_MOCK_DECLINE: 'true',
        DEMO_MODE: 'true',
      }),
    );
    expect(live.settings).toMatchObject({ allowRawCard: false, allowMockResponse: false });
  });

  it('mock responses need sandbox + DEMO_MODE + ALLOW_MOCK_DECLINE', () => {
    expect(createPayPalClient(config()).settings.allowMockResponse).toBe(false);
    expect(
      createPayPalClient(config({ ALLOW_MOCK_DECLINE: 'true' })).settings.allowMockResponse,
    ).toBe(false);
    expect(
      createPayPalClient(config({ ALLOW_MOCK_DECLINE: 'true', DEMO_MODE: 'true' })).settings
        .allowMockResponse,
    ).toBe(true);
    expect(
      createPayPalClient(
        config({ PAYPAL_MODE: 'stub', ALLOW_MOCK_DECLINE: 'true', DEMO_MODE: 'true' }),
      ).settings.allowMockResponse,
    ).toBe(true);
  });
});
