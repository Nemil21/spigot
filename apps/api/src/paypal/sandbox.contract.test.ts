import { describe, it } from 'vitest';
import { isSandboxPayPalBase } from '../config.js';
import { loadDotenv } from '../env.js';
import { PayPalRestClient } from './client.js';
import { faultyFetch, paypalContract } from './test-harness.js';

/**
 * The contract suite against the real PayPal sandbox. Local / manual only, never in CI:
 *   PAYPAL_MODE=sandbox npx vitest run apps/api/src/paypal/sandbox.contract.test.ts
 * Only a `PAYPAL_MODE` set in the shell enables it (a `.env` value doesn't). Reads credentials from
 * `.env`; never prints them. Refuses a non-sandbox base. Cases that need a buyer to approve in a
 * browser (wallet capture) are fake-only; SP-003 S7 covers them by hand.
 */
const enabled = process.env.PAYPAL_MODE === 'sandbox';

if (enabled) {
  loadDotenv();
  const base = process.env.PAYPAL_API_BASE ?? '';
  if (!isSandboxPayPalBase(base)) {
    throw new Error('the sandbox contract suite runs only against a PayPal sandbox base');
  }
  paypalContract('PayPal sandbox', () => {
    const faults = faultyFetch(globalThis.fetch.bind(globalThis));
    return {
      client: new PayPalRestClient({
        baseUrl: base,
        clientId: process.env.PAYPAL_CLIENT_ID ?? '',
        clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
        fetch: faults.fetch,
        allowRawCard: true,
        allowMockResponse: true,
        timeoutMs: 30_000,
      }),
      fail503: faults.fail503,
      mockResponses: true,
      timeoutMs: 90_000,
    };
  });
} else {
  describe('PayPal contract: sandbox', () => {
    it.skip('set PAYPAL_MODE=sandbox in the shell to run against the PayPal sandbox', () => {});
  });
}
