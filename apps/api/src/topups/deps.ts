import type { Config } from '../config.js';
import { createPayPalClient, type PayPalOrdersClient } from '../paypal/index.js';

/**
 * The PayPal client the top-up code uses. One per process, from `createPayPalClient(config)`
 * (`PAYPAL_MODE=stub` → the shared FakePayPal). Tests swap it with `setTopupPayPal`.
 */
let override: PayPalOrdersClient | undefined;
const cache = new WeakMap<Config, PayPalOrdersClient>();

export function topupPayPal(config: Config): PayPalOrdersClient {
  if (override) return override;
  let pp = cache.get(config);
  if (!pp) {
    pp = createPayPalClient(config);
    cache.set(config, pp);
  }
  return pp;
}

/** Tests: use `pp` for every top-up call (`undefined` restores the config's client). */
export function setTopupPayPal(pp: PayPalOrdersClient | undefined): void {
  override = pp;
}

/** Where PayPal sends the buyer back after approving (or cancelling) a wallet order. */
export function walletUrls(config: Config): { returnUrl: string; cancelUrl: string } {
  const base = config.APP_BASE_URL.replace(/\/+$/, '');
  return {
    returnUrl: `${base}/topups/return`,
    cancelUrl: `${base}/topups/return?cancelled=1`,
  };
}
