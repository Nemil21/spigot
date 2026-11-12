# SP-001d: `packages/shared` contracts: money, error codes, `PublisherEvent`, W15 copy, gate payload schemas

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 1
- **Depends on:** none
- **Spec refs:** README §Repo layout (`packages/shared`); data-model.md §Money units; api.md §Errors, §Gate endpoints; screens.md §W15, money copy rule

## Goal
The shared types and strings every other ticket imports, in their own workspace so they land in Wave 1 next to the skeleton.

## Files / modules
`packages/shared/src/`: `money.ts`, `errors.ts`, `events.ts`, `copy.ts`, `gate.ts`, `index.ts`. No Node-only deps (the web app imports it).

## Scope
- `money.ts`: `centsToMicros`, `microsToCentsFloor`, `commissionSplit(priceMicros, bps)` → `{commission, publisher}` (floor commission, remainder to publisher), `formatMicros` ("$0.0555"), `formatPer1000` ("$1.50 / 1,000 records").
- `errors.ts`: error envelope type and the code union from api.md, plus `IDEMPOTENCY_KEY_EXPIRED` (SP-016).
- `events.ts`: channel name `publisher_events` and the `PublisherEvent` union `{publisherId, type, ids, at}` with types `hits`, `call.charged`, `payout.updated`, `proposal.ready`, `crawl.progress`, `dataset.extract.progress`. Producers (SP-008b, SP-009a2, SP-012a, SP-014a, SP-016, SP-021) import it; SP-025 consumes it.
- `copy.ts`: every W15 string (insufficient balance, price above max, auto top-up cap reached / declined, dataset unpublished, stale data, payout unclaimed, crawl blocked) and the money copy rule words (`charged`, `credited`, `refunded to PayPal`, `sent`, `paid out`, `waiting for you to claim`) as functions taking the numbers. SP-017a/017b, SP-022a, SP-024b, SP-031, SP-032 and SP-033 import them.
- `gate.ts`: zod schemas for the policy response and the hits payload, **including `isSimulated` per bucket** (an api.md amendment; see INDEX §Spec amendments).

## Acceptance criteria
- [ ] Money table tests: `centsToMicros(2000)=20_000_000`, `microsToCentsFloor(12_345_678)=1234`, `commissionSplit(1_500_000, 2000)` = 300,000 / 1,200,000, odd amounts keep the remainder with the publisher.
- [ ] A snapshot test pins every W15 string exactly as screens.md words it.
- [ ] `apps/web` can import the package with no Node polyfills (checked by SP-024a's build).

## Test plan
Unit only.

## Notes & risks
Runs in parallel with SP-001a against the agreed layout and rebases on it before merging.
