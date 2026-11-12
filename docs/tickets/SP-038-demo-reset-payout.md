# SP-038: `demo:reset` + `demo:payout` (no deletes, DEMO_RESET transition, demo-site reset over HTTP)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** SP-035, SP-021, SP-014a, SP-008b, SP-004b
- **Spec refs:** features/12 §Pieces 4; features/15 §Demo hooks, §Acceptance criteria

## Goal
Every take starts clean, and the payout beat is one command.

## Files / modules
`apps/api/src/cli/demo-reset.ts`, `demo-payout.ts`.

## Scope
- `demo:reset` (only for the publisher with `is_demo = true`):
  - datasets → PROPOSED through the **`DEMO_RESET` transition** (SP-002 documents it; the code path checks `is_demo` and refuses otherwise), records kept, then **`bumpPolicyVersion`** (SP-008b) so the gate stops quoting listing pages until the on-camera re-approve;
  - Acme balance → $0 via a `DEMO_RESET` ledger txn (SP-002 kind) into `PLATFORM_REVENUE`, never deleting entries;
  - Acme's foreground `api_calls` get `hidden_at = now()` (never deleted: deleting would free `(api_key_id, idempotency_key)` so a replay charges again, and break `ledger_txns.ref_id` and `claims.api_call_id`); Acme's API key is rotated so the next take starts with a new key and no idempotency collisions;
  - SIM history untouched;
  - demo-site data restored over HTTP with `POST {DEMO_SITE_URL}/admin/reset` (SP-004b, `DEMO_ADMIN_TOKEN`), which works against the Render service too; then a `MANUAL` crawl so Spigot's records revert (the reset bumped those pages' lastmod);
  - never touches PayPal history.
- `demo:payout` = `payoutRun('MANUAL_DEMO', {thresholdCentsOverride: 100})` and print batch/item ids.
- `--yes` required; refuses unless `DEMO_MODE=true`.

## Acceptance criteria
- [ ] Reset → full script → reset → full script works twice in a row.
- [ ] Ledger check passes after reset (no entry deleted).
- [ ] PayPal ids from earlier runs remain in audit.
- [ ] After reset the gate's policy no longer gates `/listings/` (policy version bumped) and the API returns 410 for the dataset until re-approved.
- [ ] No `api_calls` row is deleted; a replay of a pre-reset request with the old key gets 401 (key rotated), never a charge.
- [ ] Reset against a non-demo publisher is refused.
- [ ] Demo-site reset works against a remote demo-site URL (integration with the demo site on another port).

## Test plan
Integration: seed → charges → reset → ledger check.

## Notes & risks
A $0 reset needs a ledger account to absorb the buyer balance (`PLATFORM_REVENUE`, kind `DEMO_RESET`, memo "demo reset"); document it in the README's simulated-vs-real table.
