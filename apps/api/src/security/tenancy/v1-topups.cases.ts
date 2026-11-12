import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-022b's `POST /v1/topups` (glob-loaded by SP-042's route-table matrix;
 * `mcp/balance.db.test.ts` runs them today). Like `/mcp`'s `top_up`, it takes no buyer id: the
 * top-up is always the API key's own buyer's, and idempotency keys are scoped per buyer.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/v1/topups',
    as: 'buyer',
    expect:
      "creates a top-up for the key's own buyer only; a buyerId in the body is ignored; B reusing A's Idempotency-Key gets B's own new top-up, never A's link",
  },
];
