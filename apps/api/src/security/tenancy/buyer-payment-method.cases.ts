import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-063's saved-method read (glob-loaded by SP-042's route-table matrix;
 * `topups/cardFieldsTopup.db.test.ts` runs them today).
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/buyer/payment-method',
    as: 'buyer',
    expect:
      "A's session reads A's saved method only (?buyerId=<B> ignored); never the vault id; no session → 401",
  },
];
