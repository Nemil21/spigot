import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-030a's buyer usage routes (glob-loaded by SP-042's route-table matrix).
 * `reports/reports.db.test.ts` runs them today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/buyer/usage',
    as: 'buyer',
    expect: "lists the caller's calls only; ?buyerId=<A> is ignored",
  },
  {
    method: 'GET',
    url: '/api/buyer/calls/:id',
    as: 'buyer',
    expect: "B's session on A's call id → 404 NOT_FOUND",
  },
];
