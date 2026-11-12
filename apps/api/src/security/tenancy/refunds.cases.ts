import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-049's refund routes (glob-loaded by SP-042's route-table matrix).
 * `refunds/refunds.db.test.ts` runs them today: buyer B can't refund or see buyer A's balance.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/buyer/refunds',
    as: 'buyer',
    expect:
      "refunds the caller's own balance against the caller's own captures only; a buyerId / topupId in the body is ignored",
  },
  {
    method: 'GET',
    url: '/api/buyer/refunds',
    as: 'buyer',
    expect: "lists the caller's refunds and refundable amount only; ?buyerId=<A> is ignored",
  },
];
