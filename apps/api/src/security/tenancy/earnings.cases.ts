import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-030a's publisher earnings and ledger routes (glob-loaded by SP-042's
 * route-table matrix). `reports/reports.db.test.ts` runs them today. Neither route takes an id:
 * both read the session publisher's calls and `PUBLISHER_PAYABLE` account only.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/publishers/me/earnings',
    as: 'publisher',
    expect:
      "B's session sees only B's KPIs and rows; A's calls, buyers and payable never appear; ?publisherId=<A> is ignored",
  },
  {
    method: 'GET',
    url: '/api/publishers/me/ledger',
    as: 'publisher',
    expect:
      "B's session lists only entries on B's payable account; A's cursor or ?publisherId=<A> never yields A's rows",
  },
];
