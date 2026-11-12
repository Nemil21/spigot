import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-014a's dataset write routes (glob-loaded by SP-042's route-table matrix).
 * `datasets/datasets.db.test.ts` runs them today: tenant A's session against tenant B's dataset.
 */
export const cases: TenancyCase[] = [
  {
    method: 'PATCH',
    url: '/api/datasets/:id',
    as: 'publisher',
    expect:
      "B's dataset id → 404 NOT_FOUND; no schema_versions row is added, B's prices and slug unchanged",
  },
  {
    method: 'POST',
    url: '/api/datasets/:id/approve',
    as: 'publisher',
    expect:
      "B's dataset id (with B's schema version id) → 404 NOT_FOUND; B's dataset stays PROPOSED, no APPROVE run",
  },
  {
    method: 'POST',
    url: '/api/datasets/:id/reject',
    as: 'publisher',
    expect: "B's dataset id → 404 NOT_FOUND; B's dataset stays PROPOSED",
  },
  {
    method: 'POST',
    url: '/api/datasets/:id/unpublish',
    as: 'publisher',
    expect: "B's LIVE dataset id → 404 NOT_FOUND; B's dataset stays LIVE, policy_version unchanged",
  },
];
