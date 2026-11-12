# SP-031: W09 Payouts (master/detail grid, Run payout now, SIM in statements)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-024b, SP-021
- **Spec refs:** screens.md §W09; features/13 §5; features/09 §User stories; features/12 video 2:25–2:40

## Goal
Every PayPal payout visible with ids and status, and the demo's "Run payout now".

## Files / modules
`apps/web/src/pages/Payouts.tsx`, `grids/PayoutsGrid.tsx` (master/detail), `RunPayoutModal.tsx`, `StatementDrawer.tsx`.

## Scope
- Card: "Next PayPal payout Monday · $412.75 payable · threshold $10".
- "Run payout now" (demo publisher only, labelled "demo control"); confirm modal with payable, commission already taken, net, threshold.
- AG Grid master/detail: batch date, amount, PayPal batch id → items (item id, status pill Sent / Paid out / Waiting for you to claim / Failed → retrying next batch), PayPal id copy cells; live via SSE `payout.updated`.
- Statement drawer: period, records sold, gross, commission, net, rounding carried forward.
- States: none yet, sent (polling), paid out, unclaimed warning ("Log in to PayPal with publisher@… to claim"), failed with reason; INSUFFICIENT_FUNDS alert copy from SP-020.
- **SIM labelling (feature 15):** the statement drawer shows the SIM share of gross and records ("incl. $X / N records simulated"), and a payout row whose period includes SIM charges carries a SIM chip with a tooltip. The payout itself is real money to the sandbox account; the chip labels the source of the earnings.

## Acceptance criteria
- [ ] Run now → row appears as Sent → flips to Paid out without reload (sandbox).
- [ ] Ids match the sandbox.
- [ ] Copy follows the money copy rule exactly.
- [ ] A payout covering SIM charges shows the SIM chip and the SIM share in its statement.

## Test plan
Component tests per status; manual sandbox run.
