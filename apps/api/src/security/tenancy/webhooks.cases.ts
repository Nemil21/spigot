import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy case for SP-059's `POST /webhooks/paypal` (glob-loaded by SP-042's route-table matrix).
 * No session: the PayPal signature over the raw body is the authentication. A verified event acts
 * only on the rows its PayPal ids (`custom_id` = top-up id, `sender_item_id` = payout item id)
 * point at, and returns no tenant data.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/webhooks/paypal',
    as: 'none',
    expect:
      'PayPal-signed, not a session: a bad or missing signature → 401 and nothing stored; the answer carries no tenant data',
  },
];
