import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-048b's publisher claim routes (glob-loaded by SP-042's route-table matrix;
 * `claims/triage.db.test.ts` runs them today). A claim belongs to the publisher whose site's
 * dataset holds the claimed record: B never sees A's claims in the list, and B deciding A's claim
 * gets the same 404 as an unknown id, with no status change and no CREDIT.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/claims',
    as: 'publisher',
    expect:
      "lists only claims on the caller's own sites' records; B's list never contains A's claims",
  },
  {
    method: 'POST',
    url: '/api/claims/:id/decide',
    as: 'publisher',
    expect: "B deciding A's claim → 404, claim stays OPEN, no CREDIT, no audit row",
    ids: (b) => [b.claimId],
  },
];
