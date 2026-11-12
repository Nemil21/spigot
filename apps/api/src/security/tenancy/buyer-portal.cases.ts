import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-032's buyer portal reads (glob-loaded by SP-042's route-table matrix;
 * `routes/buyer-portal.db.test.ts` runs them today).
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/buyer/balance',
    as: 'buyer',
    expect: "A's session reads A's balance only (?buyerId=<B> ignored); no session → 401",
  },
  {
    method: 'GET',
    url: '/api/buyer/paypal-config',
    as: 'buyer',
    expect: 'public client id only (never the secret); same for every buyer; no session → 401',
  },
];
