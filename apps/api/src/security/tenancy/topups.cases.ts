import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-018a's top-up routes (glob-loaded by SP-042's route-table matrix).
 * `topups/topups.db.test.ts` runs them today: buyer B's session against buyer A's top-up.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/buyer/topups',
    as: 'buyer',
    expect: 'creates a top-up for the caller only; a buyerId in the body is ignored',
  },
  {
    method: 'POST',
    url: '/api/buyer/topups/:id/capture',
    as: 'buyer',
    expect: "B's session on A's top-up id → 404 NOT_FOUND, PayPal not called, nothing credited",
  },
  {
    method: 'GET',
    url: '/api/buyer/topups',
    as: 'buyer',
    expect: "lists the caller's top-ups only; ?buyerId=<A> is ignored",
  },
  {
    method: 'GET',
    url: '/topups/return',
    as: 'none',
    expect:
      'keyed by the PayPal order token, not a session: captures that order and credits only the buyer who created it',
  },
];
