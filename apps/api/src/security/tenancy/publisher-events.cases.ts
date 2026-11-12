import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-025's publisher event stream (glob-loaded by SP-042's route-table matrix).
 * The route takes no id: it subscribes by the session publisher only. `publisher-events.db.test.ts`
 * runs these today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/publishers/me/events',
    as: 'publisher',
    expect:
      "A's stream (with ?publisherId=<B> smuggled in) never carries B's events, live or replayed via Last-Event-ID; no session → 401",
  },
];
