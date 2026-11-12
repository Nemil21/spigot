# Spigot PayPal spike results (SP-003: S7–S11)

Run in the PayPal sandbox on Nov 12 2026 with the same app, `.env` and **US** sandbox business account (merchant) as `spikes/paypal-spikes.mjs` and Holdfast's S7. Payouts go to the separate sandbox business account Holdfast proved for payouts (`PAYPAL_BRAND_EMAIL`, used as the demo publisher's `DEMO_PUBLISHER_PAYOUT_EMAIL`). Script: `scripts/spikes-spigot.mjs` (`node scripts/spikes-spigot.mjs s7a|s7b|s8a|s8b|s8c|s9|s10|s11|all|resume|check|render`). Raw evidence is in `spikes/spigot-evidence/` (git-ignored); the tables at the end are rendered from it. Every request id, HTTP status, body `status`, issue code and PayPal debug id is there. No secrets, emails, card numbers or full vault ids are recorded.

Request ids follow features/08 and 09: order create `PayPal-Request-Id` = `custom_id` = `invoice_id` = top-up id; order capture `capture:<topupId>`; refund = `balance_refunds.id`; payout `sender_batch_id` = batch id.

## Result table (feeds CP1)

| # | Step | Result | Decision / fallback |
|---|---|---|---|
| S7a | Card `intent: CAPTURE` order, captured in the create call | **PASS.** 201, order `COMPLETED`, `purchase_units[0].payments.captures[0]` `COMPLETED` in the create response. No separate capture call. | Card top-ups (test-card button / card fields) and every MIT top-up are one call. `creditTopup` takes the capture id from the create response. |
| S7b | Wallet CAPTURE order → buyer approves → `POST /orders/{id}/capture` (`capture:<id>`) + replay | **PENDING-HUMAN.** Order create → **200** `PAYER_ACTION_REQUIRED` with a `rel=payer-action` link; create replay with the same id → 200, same order. Nobody approved with the sandbox Personal account within the 15-minute window, so the order was left `PAYER_ACTION_REQUIRED` (expires on its own; nothing to clean up). The capture and its replays are not yet observed. | Ticket fallback until a person runs it: **card top-up is the demo path** (S7a PASS; card fields via SP-063). Wallet create is proven; SP-018a builds capture with `capture:<topupId>` and the FakePayPal assumes the RECONCILE rows marked *expected* below. To finish: `node scripts/spikes-spigot.mjs s7b` with someone at the browser (≈ 1 min), or approve a pending order and run `resume`. |
| S8a | Card CAPTURE + `store_in_vault: ON_SUCCESS`, then MIT CAPTURE from `vault_id` + `stored_credential{MERCHANT,UNSCHEDULED,SUBSEQUENT}`; replay | **PASS.** First order: capture `COMPLETED`, vault `VAULTED` (in the create response). MIT #1: 201, capture `COMPLETED` at create, no buyer. MIT #1 replay with the same id: **200, same order and same capture** (no second charge). MIT #2 (new id): 201 `COMPLETED`. | Auto top-up (SP-047a) and MCP `top_up` use card `vault_id` + `stored_credential` with `intent: CAPTURE`. Retrying with the same top-up id is safe. |
| S8b | Wallet vault (`paypal.attributes.vault`, `usage_type: MERCHANT`) on a CAPTURE order, then MIT `paypal.vault_id` CAPTURE | **PENDING-HUMAN.** Order create with `paypal.attributes.vault{store_in_vault: ON_SUCCESS, usage_type: MERCHANT, customer_type: CONSUMER}` → **200** `PAYER_ACTION_REQUIRED` (vault attributes accepted on a CAPTURE order); replay → same order. Not approved within 15 minutes, so the vault and the wallet MIT CAPTURE are not observed. | **`PAYPAL_WALLET_VAULT` stays `off`**; auto top-up uses the card vault (S8a PASS). Holdfast proved wallet vault + wallet MIT for AUTHORIZE, so this is likely to pass; flip the flag only after `node scripts/spikes-spigot.mjs s8b` passes. |
| S8c | MIT CAPTURE with `PayPal-Mock-Response {"mock_application_codes":"INSTRUMENT_DECLINED"}` | **PASS.** **422** `UNPROCESSABLE_ENTITY`, `details[0].issue: INSTRUMENT_DECLINED` (body has `name, details, message, debug_id, links`). **No order is created** (no `id`). Unlike Holdfast's mocked decline on *authorization capture* (403, empty body), the create-time decline has an issue code. | SP-047a: a 422 `INSTRUMENT_DECLINED` on the MIT create → top-up FAILED, `auto_topup_enabled=false`, 402 "auto top-up declined". Nothing to reconcile: no order exists. |
| S9 | Partial refund with `PayPal-Request-Id`; replay; refund above remaining | **PASS.** $20 capture: refund $7.40 → 201 `COMPLETED`. Replay same id → **200, same refund id**. Replay same id with a *different* amount ($3.00) → **200, same refund, amount still $7.40** (the body is ignored on replay). Second refund $5.00 (new id) → 201 `COMPLETED`. $10.00 (new id, $7.60 left) → **422 `REFUND_AMOUNT_EXCEEDED`**. Capture → `PARTIALLY_REFUNDED`. | Refund unused balance (SP-049) is in. Several partial refunds per capture work. Insert `balance_refunds` before the call and always retry with the same id. |
| S10 | One Payouts batch, 3 items; poll to terminal; resubmit the same `sender_batch_id` | **PASS.** POST 201 `PENDING` → `PROCESSING` → `SUCCESS` in ≈ 33 s (polled every 10 s). Items: publisher `SUCCESS`, publisher 2nd item `SUCCESS`, unregistered `UNCLAIMED` with `errors.name: RECEIVER_UNREGISTERED` (batch is still `SUCCESS`). $0.25 fee per item. Resubmitting the same `sender_batch_id` → **400 `USER_BUSINESS_ERROR`**, issue `Batch with given sender_batch_id already exists`, both **immediately with the same `PayPal-Request-Id`** and after the batch was terminal with a new one. | SP-020: `UNCLAIMED` is in flight ("waiting for publisher to claim"), batch `SUCCESS` does not mean every item paid. A duplicate `sender_batch_id` is never replayed, even with the same request id; on that 400 the batch already exists, so stay SUBMITTED and find it (see RECONCILE). |
| S11 | `POST /v1/notifications/verify-webhook-signature` call shape | **SCRIPT ONLY** (runs for real in SP-059 once the Render URL and `PAYPAL_WEBHOOK_ID` exist). Dry run with synthetic headers: **HTTP 200 with `verification_status: FAILURE`**. A `webhook_id` with non-alphanumerics is rejected earlier: 400 `INVALID_REQUEST` (`must match ^[a-zA-Z0-9]+$`). | SP-059: verification failure is **200 + `FAILURE`**, so check the field, never the HTTP status. Body: `auth_algo, cert_url, transmission_id, transmission_sig, transmission_time` from the `paypal-*` headers, `webhook_id`, `webhook_event` = the parsed raw body. Run `node scripts/spikes-spigot.mjs s11 <delivery.json>` with `{headers, rawBody}`. |
| – | Nothing left to clean up | **PASS.** All 8 orders GET-checked: 5 `COMPLETED` (captured), 2 `PAYER_ACTION_REQUIRED` (S7b/S8b wallet, never approved), 1 `CREATED` (S7a no-source replay order, never approved). None approved-but-uncaptured; no cleanup needed. | – |

## RECONCILE mapping for CAPTURE-intent calls (hand-off to SP-001b / SP-001c / SP-018a / SP-020 / SP-047a / SP-049)

These are the responses SP-001b / SP-001c's FakePayPal should return, and how the callers classify them.

| Call | Situation | Response (sandbox) | Classify as |
|---|---|---|---|
| order create, raw card, CAPTURE | same `PayPal-Request-Id` again | **200, same order, same capture id**, `COMPLETED` | replay → SUCCEEDED (differs from Holdfast's AUTHORIZE: there it was 422 `TRANSACTION_REFUSED`) |
| order create, card `vault_id` MIT, CAPTURE | same id again | **200, same order, same capture** | replay → SUCCEEDED (no second charge) |
| order create, no source / wallet (`payment_source.paypal`) | same id again | **200, same order**, same status (`CREATED` / `PAYER_ACTION_REQUIRED`) | replay → AWAITING_APPROVAL |
| order create | same `invoice_id`, new request id | 422 `DUPLICATE_INVOICE_ID` | RECONCILE: an order for this top-up already exists; use the stored order id (our `topups` row is the dedupe) |
| order create, MIT | mocked `INSTRUMENT_DECLINED` | **422 `INSTRUMENT_DECLINED`**, no order created | TERMINAL (FAILED); disable auto top-up |
| order create, wallet | (first call) | **200** (not 201) `PAYER_ACTION_REQUIRED`, `rel=payer-action` link | AWAITING_APPROVAL; send the buyer to the link |
| order capture | order already captured at create (card) | 422 `ORDER_ALREADY_CAPTURED` | RECONCILE → GET order (`COMPLETED`, 1 capture) → SUCCEEDED with that capture id |
| order capture (wallet) | same `capture:<id>` again | *Expected* **200, same capture id** (not observed: S7b PENDING-HUMAN; Holdfast saw this for authorize and authorization-capture replays) | replay → SUCCEEDED (confirm when S7b runs) |
| order capture (wallet) | new request id after a capture | *Expected* 422 `ORDER_ALREADY_CAPTURED` (observed in S7a on a card order captured at create; wallet not yet observed) | RECONCILE → GET order → take its capture → SUCCEEDED |
| order capture (wallet) | buyer has not approved | order stays `PAYER_ACTION_REQUIRED` (GET) | keep AWAITING_APPROVAL; poller / webhook retries with the same `capture:<id>` |
| refund | same `PayPal-Request-Id` again | **200, same refund id** `COMPLETED` (body ignored, even a different amount) | replay → COMPLETED |
| refund | amount above the remaining capture | **422 `REFUND_AMOUNT_EXCEEDED`** | TERMINAL; our slicing is wrong → alert, re-read the capture |
| refund | partial | 201 `COMPLETED`; capture → `PARTIALLY_REFUNDED` | COMPLETED |
| payout | same `sender_batch_id` (same or new `PayPal-Request-Id`) | **400 `USER_BUSINESS_ERROR`**, `details[0].issue: "Batch with given sender_batch_id already exists"`; no `payout_batch_id` returned | RECONCILE: the batch exists. If we stored `payout_batch_id`, poll it; if not (crash before the 201 was saved), mark the batch SUBMITTED-unknown and alert: the duplicate error carries no `payout_batch_id` and Payouts v1 documents no lookup by `sender_batch_id` (not tested here), so save `payout_batch_id` in the same transaction as the 201 and treat a missing one as needs-attention; the webhook `PAYMENT.PAYOUTSBATCH.*` carries it (SP-059) |
| payout item | unregistered receiver | item `UNCLAIMED`, `errors.name: RECEIVER_UNREGISTERED`; batch `SUCCESS` | item UNCLAIMED (in flight; RETURNED after 30 days → back to payable) |
| payout | above the available balance | 422 `INSUFFICIENT_FUNDS`, no batch (Holdfast S7) | RETRY later + alert, new `sender_batch_id` |
| payout | receiver is the merchant itself | batch DENIED / item FAILED `SELF_PAY_NOT_ALLOWED` (Holdfast S7) | PAYOUT_FAILED (config error) |
| verify-webhook-signature | bad / forged signature | **200 `verification_status: FAILURE`** | reject the delivery (401), don't process |

## Notes and deviations

- **S10 second valid email.** Only one non-merchant sandbox business account is available (`PAYPAL_BRAND_EMAIL`), so the "second valid sandbox email" item is a second item to the publisher account (different `sender_item_id`). Set `SPIKE_SECOND_PAYOUT_EMAIL` in `.env` to rerun S10 with a distinct receiver. Items were $12.34 / $5.00 / $3.21 (≤ $50 each, per the ticket).
- **Wallet approval (S7b / S8b).** The script prints the `payer-action` URL and polls `GET /v2/checkout/orders/{id}` every 10 s for up to 15 minutes while the other steps run. `return_url` is `https://example.com/…` (nothing listens; the poll sees `APPROVED`). If nobody approves in time the step is **PENDING-HUMAN** and the order is left un-approved (it expires on its own). After approving later, `node scripts/spikes-spigot.mjs resume` captures it and records the step.
- `invoice_id` = top-up id is added next to `custom_id`, so a second order for the same top-up is refused (`DUPLICATE_INVOICE_ID`) — recommended for SP-018a.

<!-- spigot-evidence:start -->
_Generated by `node scripts/spikes-spigot.mjs render` from spikes/spigot-evidence/ (git-ignored)._

### S7a: card CAPTURE, captured in the create call

Last run 2026-11-12T01:55:29.140Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create (card CAPTURE) | `157dc87c-679f-4c13-981b-b1eaa922ba38` | 201 | COMPLETED | – | f866269e29a71 | 4149 | capture 5PX5… COMPLETED; order COMPLETED |
| order create replay same id | `157dc87c-679f-4c13-981b-b1eaa922ba38` | 200 | COMPLETED | – | f3366604e6816 | 4577 | same order: true; capture 5PX5… COMPLETED; same capture: true |
| order create same invoice_id, new request id | `92c81535-cfb9-45db-a000-decec578b084` | 422 | – | DUPLICATE_INVOICE_ID | f471088d1f93f | 3986 | rejected |
| capture order on COMPLETED order | `capture:157dc87c-679f-4c13-981b-b1eaa922ba38` | 422 | – | ORDER_ALREADY_CAPTURED | f3632106f1e1b | 1801 | – |
| GET order | – | 200 | COMPLETED | – | f826027486db6 | 1600 | order COMPLETED, captures: 1 |
| order create no source | `577c3bad-1327-44e6-98a6-172c829e577f` | 201 | CREATED | – | f427277ada7bd | 1475 | – |
| order create no source replay same id | `577c3bad-1327-44e6-98a6-172c829e577f` | 200 | CREATED | – | f1364190d317f | 607 | same order: true |

```json
{
  "createHttp": 201,
  "orderStatus": "COMPLETED",
  "captureStatus": "COMPLETED",
  "captureId": "5PX57801F11401515",
  "rawCardReplay": "same order",
  "sameInvoiceNewId": "DUPLICATE_INVOICE_ID",
  "captureOnCompleted": "ORDER_ALREADY_CAPTURED",
  "noSourceReplaySame": true
}
```

### S7b: wallet CAPTURE → approve → capture `capture:<id>` + replays

Last run 2026-11-12T02:10:07.072Z: **PENDING-HUMAN**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create (wallet) | `e0a8f42c-d8a5-43dd-8366-930cd213a172` | 200 | PAYER_ACTION_REQUIRED | – | f2972850404dd | 873 | – |
| order create replay same id | `e0a8f42c-d8a5-43dd-8366-930cd213a172` | 200 | PAYER_ACTION_REQUIRED | – | f407774b294b0 | 1086 | same order: true |
| GET order | – | 200 | PAYER_ACTION_REQUIRED | – | ca591ff978915 | 668 | order state after waiting 898 s |

```json
{
  "orderStatus": "PAYER_ACTION_REQUIRED",
  "note": "not approved in time; order left un-approved (expires on its own). Run `resume` after approving."
}
```

### S8a: card vault on CAPTURE, then MIT CAPTURE from vault_id

Last run 2026-11-12T01:55:43.994Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create card CAPTURE + vault | `cc414bde-be66-455c-9b00-058ba42a153f` | 201 | COMPLETED | – | f136419929d57 | 3960 | capture 9UD0… COMPLETED; vault VAULTED 0hp1… |
| MIT CAPTURE #1 (vault_id + stored_credential) | `bf6ddb86-c7ad-4805-8fe8-f58f1e2afd65` | 201 | COMPLETED | – | f996798f359e7 | 4598 | capture 1J95… COMPLETED |
| MIT CAPTURE #1 replay same id | `bf6ddb86-c7ad-4805-8fe8-f58f1e2afd65` | 200 | COMPLETED | – | f16754770a074 | 3118 | same order: true, same capture: true |
| MIT CAPTURE #2 new id | `2ae6a7d0-94f7-4081-a55a-985bbf904a90` | 201 | COMPLETED | – | f151108109c1a | 3174 | capture 5AK5… COMPLETED |

```json
{
  "firstCapture": "COMPLETED",
  "vaultStatus": "VAULTED",
  "mit1": "COMPLETED",
  "mit1ReplayHttp": 200,
  "mit1ReplaySame": true,
  "mit2": "COMPLETED",
  "vaultId": "0hp1…"
}
```

### S8b: wallet vault (usage_type MERCHANT) on CAPTURE, then wallet MIT CAPTURE

Last run 2026-11-12T02:10:07.509Z: **PENDING-HUMAN**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create (wallet + vault) | `8eb53a6f-ce5d-4518-b81e-9d5b67530a1b` | 200 | PAYER_ACTION_REQUIRED | – | f869160804e1c | 1156 | – |
| order create replay same id | `8eb53a6f-ce5d-4518-b81e-9d5b67530a1b` | 200 | PAYER_ACTION_REQUIRED | – | f6936221595f8 | 1163 | same order: true |
| GET order | – | 200 | PAYER_ACTION_REQUIRED | – | ca591ff9b4bb9 | 436 | order state after waiting 897 s |

```json
{
  "orderStatus": "PAYER_ACTION_REQUIRED",
  "note": "not approved in time; order left un-approved (expires on its own). Run `resume` after approving."
}
```

### S8c: MIT CAPTURE with mock INSTRUMENT_DECLINED

Last run 2026-11-12T01:55:44.672Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| MIT CAPTURE + mock INSTRUMENT_DECLINED | `3bd76b9b-9bc1-4540-9532-f6d6e3022060` | 422 | – | INSTRUMENT_DECLINED | 70c28ae654da | 677 | order id: none; capture –; body keys: name,details,message,debug_id,links |

```json
{
  "http": 422,
  "name": "UNPROCESSABLE_ENTITY",
  "issue": "INSTRUMENT_DECLINED",
  "description": "The instrument presented  was either declined by the processor or bank, or it can't be used for this payment.",
  "emptyBody": false,
  "orderId": null,
  "captureStatus": null
}
```

### S9: partial refund + replays + refund above remaining

Last run 2026-11-12T01:55:58.610Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create card CAPTURE $20 | `926eafa4-023c-4d61-a334-69883335a397` | 201 | COMPLETED | – | f757669d308f5 | 4216 | capture 2UB6… COMPLETED |
| refund $7.40 | `3e652fc7-6125-45af-b654-e60f87e80173` | 201 | COMPLETED | – | f1317262c2fc0 | 3228 | partial refund |
| refund $7.40 replay same id | `3e652fc7-6125-45af-b654-e60f87e80173` | 200 | COMPLETED | – | f6534802ad104 | 1373 | same refund id: true |
| refund replay same id, different amount ($3.00) | `3e652fc7-6125-45af-b654-e60f87e80173` | 200 | COMPLETED | – | f98681349fcf7 | 931 | same refund id: true; amount 7.40 |
| refund $5.00 new id | `1d2468be-b37c-4adf-b560-0e7ca40d4cfe` | 201 | COMPLETED | – | f1481287ed8a6 | 1764 | second partial refund |
| refund $10.00 new id (above remaining $7.60) | `dd3a8b08-2232-4c09-8c12-1eb521fc0c74` | 422 | – | REFUND_AMOUNT_EXCEEDED | f872805e8026f | 1345 | above remaining |
| GET capture | – | 200 | PARTIALLY_REFUNDED | – | f957313759b78 | 1078 | capture PARTIALLY_REFUNDED |

```json
{
  "refund1": "201 COMPLETED",
  "replay": "200 COMPLETED same=true",
  "replayDifferentAmount": "200 COMPLETED same=true amount=7.40",
  "refund2": "201 COMPLETED",
  "aboveRemaining": "422 REFUND_AMOUNT_EXCEEDED",
  "captureAfter": "PARTIALLY_REFUNDED"
}
```

### S10: Payouts batch with 3 items, poll, duplicate sender_batch_id

Last run 2026-11-12T01:56:38.691Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| POST payouts (3 items) | `a22b0bff-9bd6-412b-804d-5cc054d0efe7` | 201 | PENDING | – | f9085030c3392 | 1370 | sender_batch_id = PayPal-Request-Id = batch id |
| resubmit same sender_batch_id + same request id (immediately) | `a22b0bff-9bd6-412b-804d-5cc054d0efe7` | 400 | – | Batch with given sender_batch_id already exists | f8806292e136f | 1113 | payout_batch_id same: false |
| GET payout batch | – | 200 | SUCCESS | – | f9531948b958f | 593 | batch SUCCESS after 33 s |
| GET payout item (publisher) | – | 200 | SUCCESS | – | f95319476b56a | 1039 | item SUCCESS; fee 0.25 |
| GET payout item (publisher (2nd item)) | – | 200 | SUCCESS | – | f574447f2b0a5 | 1052 | item SUCCESS; fee 0.25 |
| GET payout item (unregistered) | – | 200 | UNCLAIMED | – | f8665190a44df | 1135 | item UNCLAIMED RECEIVER_UNREGISTERED; fee 0.25 |
| resubmit same sender_batch_id, new request id (after terminal) | `ec9567af-a9e1-40cc-aa44-e4b0fac49b3c` | 400 | – | Batch with given sender_batch_id already exists | f163887369ce6 | 1167 | – |

```json
{
  "postHttp": 201,
  "postStatus": "PENDING",
  "payoutBatchId": "ZBQCVA9JUJURL",
  "immediateResubmit": "400 USER_BUSINESS_ERROR same=false",
  "batchFinal": "SUCCESS",
  "items": {
    "publisher": "SUCCESS",
    "publisher (2nd item)": "SUCCESS",
    "unregistered": "UNCLAIMED RECEIVER_UNREGISTERED"
  },
  "duplicateAfterTerminal": "400 USER_BUSINESS_ERROR User business error.",
  "polls": [
    {
      "t": 11202,
      "batch": "PENDING",
      "items": [
        "PENDING",
        "PENDING",
        "PENDING"
      ]
    },
    {
      "t": 22609,
      "batch": "PROCESSING",
      "items": [
        "PENDING",
        "PENDING",
        "PENDING"
      ]
    },
    {
      "t": 33204,
      "batch": "SUCCESS",
      "items": [
        "SUCCESS",
        "SUCCESS",
        "UNCLAIMED"
      ]
    }
  ]
}
```

### S11: verify-webhook-signature call shape

Last run 2026-11-12T01:56:58.305Z: **SCRIPT-ONLY**
Attempts: 2026-11-12T01:56:40.116Z SCRIPT-ONLY · 2026-11-12T01:56:58.305Z SCRIPT-ONLY

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| verify-webhook-signature (dry run) | `a22e0e6c-b8e5-4e41-b47a-927c9303ce83` | 200 | FAILURE | – | f3426932c6db8 | 1078 | verification_status FAILURE |

```json
{
  "http": 200,
  "verificationStatus": "FAILURE",
  "requestKeys": [
    "auth_algo",
    "cert_url",
    "transmission_id",
    "transmission_sig",
    "transmission_time",
    "webhook_id",
    "webhook_event"
  ]
}
```

### Final check: every order created is captured or un-approved

Last run 2026-11-12T02:10:13.154Z: **PASS**

```json
{
  "orders": 8,
  "states": {
    "PAYER_ACTION_REQUIRED": 2,
    "COMPLETED": 5,
    "CREATED": 1
  },
  "needsAction": []
}
```

<!-- spigot-evidence:end -->
