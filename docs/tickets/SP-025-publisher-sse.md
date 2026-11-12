# SP-025: Publisher SSE event bus (`/api/publishers/me/events`)

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1
- **Depends on:** SP-007a
- **Spec refs:** api.md §`GET /api/publishers/me/events`; features/13 §Edge cases (SSE reconnect)

## Goal
Live dashboard updates (hits, charges, payouts, proposals, crawl progress) for the signed-in publisher only.

## Files / modules
`apps/api/src/events/bus.ts` (one `LISTEN publisher_events` connection per process, fan-out by `publisherId`), route `GET /api/publishers/me/events`.

## Scope
- Payload `{publisherId, type, ids, at}`; types `hits`, `call.charged`, `payout.updated`, `proposal.ready`, `crawl.progress`.
- Event ids monotonic per process; `Last-Event-ID` → events since that id from a 5-min in-memory ring, else a `resync` event (client refetches).
- Heartbeat every 15 s; tenancy: only the session publisher's events.
- Producers already call `notify('publisher_events', …)` (SP-008b, SP-012a, SP-016, SP-021, SP-009a).

## Acceptance criteria
- [ ] A charge committed in another process reaches the stream within 2 s.
- [ ] Publisher B never receives publisher A's events.
- [ ] A rolled-back transaction emits nothing.

## Test plan
Integration with two API processes (as Holdfast HF-008).
