import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-028's W05 progress read (glob-loaded by SP-042's route-table matrix).
 * `routes/proposal-status.db.test.ts` runs them today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/sites/:id/proposal-status',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND, never B's templates or proposal run state",
  },
];
