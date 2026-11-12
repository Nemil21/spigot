# SP-059: PayPal webhooks: verify, dedupe, handlers; spike S11

- **Priority:** P1 (features 08/09 reconcile backup)
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-018, SP-021, SP-040
- **Spec refs:** api.md §Webhooks; data-model.md rule 12; features/09 §Logic 7; README §New PayPal spikes (S11)

## Goal
Every PayPal event lands in our books, idempotently; pollers stay as the backup.

## Files / modules
`apps/api/src/webhooks/paypal.ts`, route `POST /webhooks/paypal`; `scripts/spikes-spigot.mjs s11` run against the Render URL.

## Scope
- Verify via `pp.verifyWebhook` (bad → 401, nothing processed); insert `webhook_events` (PK = event id; conflict → 200 skip); 200 fast; process async.
- Handlers: `CHECKOUT.ORDER.APPROVED` → capture (`capture:<id>`); `PAYMENT.CAPTURE.COMPLETED` → `creditTopup(custom_id)`; `DENIED/DECLINED` → FAILED (+ disable auto top-up if AUTO); `PAYMENT.CAPTURE.REFUNDED` → refund COMPLETED; payouts batch/item events → SP-021 `applyItemStatus`; `CUSTOMER.DISPUTE.CREATED` → audit only.
- Register webhook on the sandbox app for the Render URL; `PAYPAL_WEBHOOK_ID` env.

## Acceptance criteria
- [ ] S11: real sandbox `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` verified and processed on Render.
- [ ] Same event delivered twice → processed once.

## Race / idempotency tests (FakePayPal)
Webhook + capture endpoint + poller for one top-up in parallel → one TOPUP txn; webhook + poller for one payout item → one PAYOUT_SETTLED.

## Test plan
Integration with the fake verifier; S11 on Render.
