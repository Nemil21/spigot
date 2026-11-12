import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-031's payout statements route (glob-loaded by SP-042's route-table
 * matrix). `routes/payout-statements.db.test.ts` runs them today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/publishers/me/payouts/statements',
    as: 'publisher',
    expect:
      "B sees only B's items and B's ledger figures (never A's item ids or amounts); buyer or no session → 401",
  },
];
