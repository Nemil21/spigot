import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-050's buyer-session claims routes (glob-loaded by SP-042's route-table
 * matrix; `routes/buyer-claims.db.test.ts` runs them today).
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/buyer/claims',
    as: 'buyer',
    expect: "lists the caller's own claims only; ?buyerId=<A> is ignored",
  },
  {
    method: 'POST',
    url: '/api/buyer/claims',
    as: 'buyer',
    expect:
      "claims only against the session buyer's calls; B claiming on A's callId → 404, no claim row, no CREDIT",
  },
];
