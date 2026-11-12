# SP-048c: Claims STALE / REMOVED targeted re-fetch + MCP `report_bad_record`

- **Priority:** P1
- **Wave:** 7
- **Estimate:** 1.5
- **Depends on:** SP-048a, SP-013, SP-004b, SP-022a, SP-009a2
- **Spec refs:** features/10 §Claims 1–2; api.md §MCP tools (`report_bad_record`)

## Goal
The claim that matters most to buyers ("this listing is already leased") checked against the live page, and the MCP tool that lets an agent file it.

## Files / modules
`apps/api/src/claims/refetchCheck.ts`; MCP tool `report_bad_record` in `apps/api/src/mcp/tools/claims.ts` (new file; SP-022a's tool registry glob-loads `mcp/tools/*.ts`).

## Scope
- `STALE` / `REMOVED`: one targeted `fetchPage` of the record's source page (crawl key, SSRF-guarded), then `extractPage` + `publishWatermark` (SP-013) so the change lands in the feed as usual. Fresh extraction differs from the served record on a **visible** field, or the page is gone → `AUTO_CREDITED` via SP-048a's credit path. Matches → stays `OPEN` for the publisher (SP-048b).
- Rate limit: 1 targeted re-fetch per record per 10 min (repeat claims reuse the result).
- MCP `report_bad_record {callId, recordKey, reason, note}` → same service; free.

## Acceptance criteria
- [ ] Fetch a listing → `demo:mutate` leases it (no crawl) → claim STALE → AUTO_CREDITED; CREDIT posted; publisher payable reduced; the `status` change appears in the changes feed.
- [ ] A STALE claim on an unchanged listing stays OPEN, and no version is written.
- [ ] `report_bad_record` over MCP returns the claim status and credit.

## Race / idempotency tests
Same STALE claim from MCP and REST at once → one re-fetch, one claim, one CREDIT.

## Test plan
Integration with the demo site in-process (`*.db.test.ts`).
