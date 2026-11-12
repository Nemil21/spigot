# SP-059: PayPal webhooks: verify (raw body), dedupe, durable processing, handlers; spike S11

- **Priority:** P1 (features 08/09 reconcile backup)
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-018a, SP-021, SP-040, SP-001c, SP-049, SP-047a
- **Spec refs:** api.md §Webhooks; data-model.md rule 12; features/09 §Logic 7; README §New PayPal spikes (S11)

## Goal
Every PayPal event lands in our books, idempotently; pollers stay as the backup.

## Files / modules
`apps/api/src/webhooks/paypal.ts`, route `POST /webhooks/paypal`; `scripts/spikes-spigot.mjs s11` run against the Render URL.

## Scope
- Verify via `pp.verifyWebhook` against the **raw request body** (Fastify raw-body for this route; re-serialised JSON can fail verification); bad → 401, nothing stored.
- Insert `webhook_events` (PK = event id; conflict → 200 skip) and return 200 fast.
- **Durable processing:** a `webhook-process.job.ts` (`runEvery` 5 s) picks `webhook_events WHERE processed_at IS NULL ORDER BY received_at FOR UPDATE SKIP LOCKED`, runs the handler, and sets `processed_at` **in the handler's transaction**. A process that dies after the insert loses nothing: the dedupe row blocks the redelivery, and the job still processes it.
- Handlers are files in `webhooks/handlers/*.ts` (glob-loaded): top-ups and payouts here; refunds from SP-049, AUTO-decline from SP-047a. Unknown types are marked processed with an audit row.
- Payout events carry `sender_batch_id`, which resolves SP-020's `needs_reconcile` batches.
- Handler behaviour: `CHECKOUT.ORDER.APPROVED` → capture (`capture:<id>`); `PAYMENT.CAPTURE.COMPLETED` → `creditTopup(custom_id)`; `DENIED/DECLINED` → FAILED (+ disable auto top-up if AUTO); `PAYMENT.CAPTURE.REFUNDED` → refund COMPLETED; payouts batch/item events → SP-021 `applyItemStatus`; `CUSTOMER.DISPUTE.CREATED` → audit only.
- Register webhook on the sandbox app for the Render URL; `PAYPAL_WEBHOOK_ID` env.

## Acceptance criteria
- [ ] S11: real sandbox `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` verified and processed on Render.
- [ ] Same event delivered twice → processed once.
- [ ] Kill the process right after the insert → the event is processed on restart, exactly once.
- [ ] A `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` for a `needs_reconcile` batch fills its `paypal_batch_id` and settles the item.

## Race / idempotency tests (FakePayPal)
Webhook + capture endpoint + poller for one top-up in parallel → one TOPUP txn; webhook + poller for one payout item → one PAYOUT_SETTLED.

## Test plan
Integration with the fake verifier; S11 on Render.
