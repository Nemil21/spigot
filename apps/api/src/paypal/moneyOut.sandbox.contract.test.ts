import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { fetchTransport } from './fake/extras.js';
import { moneyOut } from './moneyOut.js';
import { describeMoneyOutContract } from './moneyOutContract.js';

/**
 * The SP-001c contract against the real PayPal sandbox. Never in CI. Run it locally once:
 *   PAYPAL_MODE=sandbox npx vitest run apps/api/src/paypal/moneyOut.sandbox.contract.test.ts
 * Needs PAYPAL_API_BASE (sandbox host), PAYPAL_CLIENT_ID / _SECRET and a payout receiver that
 * isn't the merchant (DEMO_PUBLISHER_PAYOUT_EMAIL, else PAYPAL_BRAND_EMAIL) in .env. Moves sandbox
 * money only: a $20 card capture (partly refunded) and a $1 payout.
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox';

if (!enabled) {
  describe.skip('SP-001c contract: PayPal sandbox (set PAYPAL_MODE=sandbox)', () => {
    it('skipped', () => {});
  });
} else {
  const envFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const base = (process.env.PAYPAL_API_BASE ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(base)) {
    throw new Error('PAYPAL_API_BASE must be the PayPal sandbox for this test');
  }
  const payoutEmail = process.env.DEMO_PUBLISHER_PAYOUT_EMAIL ?? process.env.PAYPAL_BRAND_EMAIL;
  if (!payoutEmail) throw new Error('set DEMO_PUBLISHER_PAYOUT_EMAIL (or PAYPAL_BRAND_EMAIL)');
  // An alphanumeric id PayPal accepts; with no real PAYPAL_WEBHOOK_ID the answer is FAILURE (S11).
  const webhookId = process.env.PAYPAL_WEBHOOK_ID ?? 'SPIGOTCONTRACTTEST';

  let token: Promise<string> | undefined;
  const getToken = () =>
    (token ??= (async () => {
      const basic = Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
      ).toString('base64');
      const res = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const json = (await res.json()) as { access_token?: string };
      if (!res.ok || !json.access_token) throw new Error(`token: HTTP ${res.status}`);
      return json.access_token;
    })());

  const authedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${await getToken()}`);
    return fetch(input, { ...init, headers });
  };

  describeMoneyOutContract(
    'PayPal sandbox',
    async () => ({
      pp: moneyOut(fetchTransport(authedFetch, base, { timeoutMs: 30_000 }), webhookId),
      payoutEmail,
      async makeCapture(amountCents) {
        // S9's setup: a raw sandbox test card, CAPTURE intent, captured at create.
        const res = await authedFetch(`${base}/v2/checkout/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            'PayPal-Request-Id': randomUUID(),
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
              {
                amount: {
                  currency_code: 'USD',
                  value: `${Math.trunc(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`,
                },
                description: 'Spigot SP-001c contract test',
              },
            ],
            payment_source: {
              card: {
                number: '4111111111111111',
                expiry: '2030-12',
                security_code: '123',
                name: 'Spigot Contract',
              },
            },
          }),
        });
        const json = (await res.json()) as {
          purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[];
        };
        const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
        if (!res.ok || capture?.status !== 'COMPLETED') {
          throw new Error(`card capture failed: HTTP ${res.status} ${capture?.status ?? ''}`);
        }
        return capture.id;
      },
    }),
    120_000,
  );
}
