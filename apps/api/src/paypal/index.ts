import { mockDeclinesAllowed, type Config } from '../config.js';
import { PayPalRestClient, type PayPalLogger } from './client.js';
import { FakePayPal } from './fake/core.js';

/**
 * The PayPal client. Every money ticket imports from here: `const pp = createPayPalClient(config)`.
 * Orders (SP-001b) and refunds / payouts / webhook verify (SP-001c, moneyOut.ts) share one client.
 */

export * from './types.js';
export * from './errors.js';
export { moneyOut, type MoneyOutClient } from './moneyOut.js';
export {
  PayPalCallError,
  type MoneyOutCall,
  type PayPalErrorClass,
  type PayPalRequestOptions,
  type PayPalTransport,
} from './transport.js';
export * from './refunds.js';
export * from './payouts.js';
export * from './webhooks.js';
export { FakePayPalExtras } from './fake/extras.js';
export { FAKE_WEBHOOK_ID } from './fake/webhooks.js';
export { assertCents, centsToDecimal, decimalToCents, paypalAmount } from './money.js';
export {
  PayPalHttp,
  PayPalRestClient,
  redact,
  issueOf,
  type PayPalHttpOptions,
  type PayPalRestClientOptions,
  type PayPalLogEntry,
  type PayPalLogger,
  type PayPalResponse,
  type RequestOptions,
} from './client.js';
export {
  captureRequestId,
  paymentSourceBody,
  readOrder,
  topupResultOf,
  TOPUP_DESCRIPTION,
} from './orders.js';
export {
  FakePayPal,
  FAKE_PAYPAL_BASE,
  fakeError,
  fakeFeeCents,
  type FakeAnswer,
  type FakeCall,
  type FakeCapture,
  type FakeFault,
  type FakeOp,
  type FakeOrder,
  type FakePayPalOptions,
} from './fake/core.js';

let sharedFake: FakePayPal | undefined;

/** The process-wide `FakePayPal` used when `PAYPAL_MODE=stub` (dev seeds share its state). */
export function sharedFakePayPal(): FakePayPal {
  sharedFake ??= new FakePayPal({ latencyMs: 5 });
  return sharedFake;
}

export interface CreatePayPalClientOptions {
  logger?: PayPalLogger;
  /** Use this fake in stub mode instead of the shared one. */
  fake?: FakePayPal;
}

/**
 * The PayPal client for this process. `PAYPAL_MODE=stub` → the real client over `FakePayPal`;
 * otherwise REST against `PAYPAL_API_BASE`. Raw test cards (SIM top-ups) only on a sandbox base;
 * `PayPal-Mock-Response` only when `mockDeclinesAllowed(config)` (sandbox base + `DEMO_MODE` +
 * `ALLOW_MOCK_DECLINE`). The client re-checks the base itself, so neither can reach live PayPal.
 */
export function createPayPalClient(
  config: Config,
  opts: CreatePayPalClientOptions = {},
): PayPalRestClient {
  const allowMockResponse = mockDeclinesAllowed(config);
  const logger = opts.logger ? { logger: opts.logger } : {};
  if (config.PAYPAL_MODE === 'stub') {
    return (opts.fake ?? sharedFakePayPal()).client({
      allowMockResponse,
      allowRawCard: true,
      ...logger,
    });
  }
  return new PayPalRestClient({
    webhookId: config.PAYPAL_WEBHOOK_ID,
    baseUrl: config.PAYPAL_API_BASE,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    allowRawCard: config.paypalIsSandbox,
    allowMockResponse,
    ...logger,
  });
}
