import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-047b's auto top-up settings (glob-loaded by SP-042's route-table matrix;
 * `routes/buyer-auto-topup.db.test.ts` runs them today).
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/buyer/auto-topup',
    as: 'buyer',
    expect:
      "A's session reads A's settings and saved method only (?buyerId=<B> ignored); never the vault id; no session → 401",
  },
  {
    method: 'PUT',
    url: '/api/buyer/auto-topup',
    as: 'buyer',
    expect:
      "A's session changes A's settings only (a buyerId in the body is rejected, B unchanged); no session → 401",
  },
];
