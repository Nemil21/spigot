# SP-018b: Top-up helpers: server-side SIM card top-up (deterministic id) and agent approval-link top-up

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1
- **Depends on:** SP-018a
- **Spec refs:** features/08 §Manual top-up, §MCP `top_up`; features/15 §Seed script 6; spikes/s7-results.md §RECONCILE mapping

## Goal
The two top-up paths that aren't the buyer clicking the PayPal button: server-side SIM card top-ups for the seed, and wallet orders an agent hands to its human.

## Files / modules
`apps/api/src/topups/serverCardTopup.ts`, `agentTopup.ts`.

## Scope
- `serverCardTopup({topupId, buyerId, amountCents, trigger: 'SIM'})`: raw sandbox test card (round-robin over the five working cards; never 5105…5100), CAPTURE in create, vault ON_SUCCESS → `creditTopup` (SP-018a). **Server-side only, never from request input.**
  - **The caller supplies a deterministic `topupId`** and this function first does `INSERT … ON CONFLICT (id) DO NOTHING`. Only the caller whose insert succeeded calls PayPal; a caller that finds an existing row reconciles it (COMPLETED → done; CREATED with an order id → `getOrder`; CREATED without one and older than 5 min → `needs_reconcile`) and **never creates a second order**. Raw-card create isn't replay-safe (Holdfast S7: same request id → `422 TRANSACTION_REFUSED`), so the DB row is the only dedupe.
- `createTopupForAgent(buyerId, amountCents, idempotencyKey)` (no vault yet) → wallet order returning `approveUrl` with return URL `/topups/return` (SP-022b, `trigger=MCP`).

## Acceptance criteria
- [ ] Sandbox: a SIM card top-up of $20 captures and credits once.
- [ ] Same `topupId` twice → one PayPal order.
- [ ] `createTopupForAgent` returns a sandbox approve URL; approving it and hitting `/topups/return` credits once.

## Race / idempotency tests (FakePayPal)
- 10 parallel `serverCardTopup` with the same `topupId` → one order, one TOPUP txn.
- Raw-card create that returns `TRANSACTION_REFUSED` on a replay → `needs_reconcile`, never a second top-up row.

## Test plan
Integration (`*.db.test.ts`, FakePayPal); sandbox once.
