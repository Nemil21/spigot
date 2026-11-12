import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-052b's re-inference route (glob-loaded by SP-042's route-table matrix).
 * `schema-agent/reinfer.demo.db.test.ts` also runs it: tenant A's session against B's dataset.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/datasets/:id/reinfer',
    as: 'publisher',
    expect: "B's dataset id → 404 NOT_FOUND; no schema_versions row is added, no model call",
  },
];
