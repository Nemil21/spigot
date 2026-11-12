import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-022a's MCP endpoint (glob-loaded by SP-042's route-table matrix;
 * `mcp/mcp.db.test.ts` runs them today). `/mcp` takes no buyer id: every tool acts for the
 * buyer of the request's API key, checked on every request. A session id is bound to the key
 * that opened it; any other key presenting it gets the same 404 as an unknown session.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/mcp',
    as: 'buyer',
    expect:
      "A's key with B's Mcp-Session-Id → 404 (session not found); tools charge and quote A's balance only",
  },
  {
    method: 'GET',
    url: '/mcp',
    as: 'buyer',
    expect: "A's key with B's Mcp-Session-Id → 404; no stream from B's session",
  },
  {
    method: 'DELETE',
    url: '/mcp',
    as: 'buyer',
    expect: "A's key with B's Mcp-Session-Id → 404; B's session stays open",
  },
];
