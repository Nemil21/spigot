import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy case for SP-023's `GET /v1/openapi.yaml` (glob-loaded by SP-042's route-table matrix).
 * A static document rendered at boot from the Zod schemas: no tenant data at all.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/v1/openapi.yaml',
    as: 'none',
    expect: 'public: the same static document for every caller, no buyer or publisher data',
  },
];
