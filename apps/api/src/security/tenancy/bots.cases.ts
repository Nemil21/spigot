import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-027a's W04 routes (glob-loaded by SP-042's route-table matrix).
 * `bots/bots.db.test.ts` runs them today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/sites/:id/bots',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; A's report never counts B's bot_hits or api_calls",
  },
  {
    method: 'GET',
    url: '/api/publishers/me/activity',
    as: 'publisher',
    expect:
      "A's session (with ?publisherId=<B> ignored) returns A's events and A's buyers' top-ups only; never B's",
  },
];
