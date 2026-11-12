import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-048a's `POST /v1/claims` (glob-loaded by SP-042's route-table matrix;
 * `claims/claims.db.test.ts` runs them today). The claim is always the API key's own buyer's:
 * the call is looked up by `(id, buyer_id)`, so B naming A's `callId` gets the same 404 as an
 * unknown id, creates no claim and moves no money.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/v1/claims',
    as: 'buyer',
    expect:
      "claims only against the key's own buyer's calls; B claiming on A's callId → 404, no claim row, no CREDIT, A's call untouched",
  },
];
