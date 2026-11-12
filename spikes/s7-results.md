# Spike S7 results (HF-063)

Run in the PayPal sandbox on Nov 11 2026, 12:40–13:40 UTC (04:40–05:40 PST), with the same app, `.env` and US sandbox business account (merchant) as `spikes/paypal-spikes.mjs`. Step 2 was approved by a human as a sandbox buyer in the harness. Script: `spikes/paypal-s7.mjs`; browser harness: `spikes/s7-browser.html` (`node spikes/paypal-s7.mjs serve`). Every request id, HTTP status, body `status`, issue code and PayPal debug id is in the evidence tables below.

## Result table (feeds CP1)

| # | Step | Result | Decision / fallback |
|---|---|---|---|
| 1 | Card fields (JS SDK v6) → `authorize` (`authz-<bid>`) → vault | **PASS.** The browser `submit()` succeeded. Authorize returned 201 with authorization CREATED and the card VAULTED (`store_in_vault: ON_SUCCESS`, `SCA_WHEN_REQUIRED`; no 3DS challenge on 4111…). | **HF-014b builds card fields after the test-card button**, which stays as the labelled demo backup (HF-019 Part 1). |
| 2 | Wallet approve → return → authorize (+ vault) | **PASS.** Order create with `paypal.attributes.vault.store_in_vault=ON_SUCCESS` (MERCHANT / CONSUMER) gave PAYER_ACTION_REQUIRED and a `rel=payer-action` link. The buyer approved and was returned; authorize gave 201 with authorization CREATED and the wallet **VAULTED**. The same-id replay returned the same authorization; a new id gave `ORDER_ALREADY_AUTHORIZED`. | **Wallet orders vault.** HF-014b order: **card first** (this was CP1's default while the wallet was unproven); both paths are now proven. M19's "wallet bids can't vault, raises need `approveUrl`" is wrong: raises can use the wallet `vault_id` (step 4). |
| 3 | Replays: order create, authorize, void ×2, capture ×2 | **Recorded** (mapping below). Capture and void replay cleanly with the same id. Order-create replay works for no-source and `vault_id` orders but is **refused for raw-card orders**. | Handed to HF-004 RECONCILE (table below). |
| 4 | Vault: 2 MIT holds from one `vault_id` + CIT hold (+ wallet MIT) | **PASS.** From the card-fields vault: MIT #1, MIT #2 and CIT (`payment_initiator: CUSTOMER`) all CREATED; the MIT replay with the same id returned the same order (200). **Wallet MIT** (`payment_source.paypal.vault_id`, no buyer present): 201, authorization CREATED at order create. | Agents can roll or raise from either vault without the buyer. |
| 5 | Mock `AUTHORIZATION_EXPIRED` on capture | **PASS.** 422 with `issue: AUTHORIZATION_EXPIRED`; the real authorization stays CREATED, so it must still be voided. Control: the mocked `INSTRUMENT_DECLINED` on capture returns **403 with an empty body** (no issue code), and the authorization stays CREATED. | HF-029 can demo the expired path with the mock. HF-004 must not rely on an issue code for the 403 decline (GET the authorization). |
| 6 | 300 holds, 5 test cards, concurrency 20 | **PASS** (run 2: 300/300 CREATED in 46 s, p50 2.8 s, p95 3.8 s; run 3: 300/300, p95 3.6 s; **0 rate limits** in either run). Run 1: 239/300. `5105105105105100` is rejected (`VALIDATION_ERROR` "Invalid card number") and there was one stray `TRANSACTION_REFUSED`. | Seed (HF-045) can use concurrency 20. Cards: Visa 4111…1111, Visa 4012…1881, MC 5555…4444, Amex 3714…8431 (CVV 4 digits), Discover 6011…1117. **Don't use 5105…5100.** |
| 7 | Capture ≥ $50k → ≈ $50k payout → GET batch + item | **FAIL (funds).** Two runs each captured 240 × $229, all COMPLETED (`disbursement_mode: INSTANT`, no `status_details`): $54,960 gross, $1,540.80 fees, $53,419.20 net per run (≈ $106.8k net in total). The payable balance did **not** rise with the captures: $50k as 1 item, as 6 items of ≤ $9.5k, and as separate ≤ $9.5k batches all returned `422 INSUFFICIENT_FUNDS`, and so did $5k and $2.5k. **$1,000 to the new brand account: batch SUCCESS, item SUCCESS** ($0.25 fee; item SUCCESS at 21 s, batch at 29 s). The earlier `SELF_PAY_NOT_ALLOWED` is fixed by the separate brand account. Balance is still unreadable: `GET /v1/reporting/balances` and `/v1/reporting/transactions` return 403, and a fresh token has no reporting scope (Transaction Search hasn't propagated). | Payouts, polling and item statuses work end to end. **Captured card money did not become payable within ≈ 1 h in this sandbox account**, so the ≈ $50k payout can't be funded by captures alone. HF-032 should treat `INSUFFICIENT_FUNDS` as RETRY-later + alert, not FAILED (M4). The demo payout needs a decision: pre-fund the merchant (the spec backstop) or pay out an amount the balance covers. Splitting does not get around it. |
| – | Nothing left CREATED | **PASS.** All 863 spike authorizations GET-checked: 381 VOIDED, 482 CAPTURED, 0 CREATED. | – |

## RECONCILE mapping for HF-004 (D11, B4, M2)

| Call | Situation | Response | Classify as |
|---|---|---|---|
| capture | same `PayPal-Request-Id` again | **200**, same capture id, COMPLETED | replay → SUCCEEDED |
| capture | new id, auth already captured | 422 `AUTHORIZATION_ALREADY_CAPTURED` | RECONCILE → GET the authorization (CAPTURED) → SUCCEEDED. The GET authorization body has **no capture link**, so take the capture id from the stored first response or `GET /v2/checkout/orders/{id}` |
| capture | auth was voided | 422 `AUTHORIZATION_VOIDED` | RECONCILE → VOIDED → TERMINAL + alert |
| capture | mock expired | 422 `AUTHORIZATION_EXPIRED` (auth still CREATED) | TERMINAL; void it |
| capture | mock decline | **403, empty body** (auth still CREATED) | TERMINAL (`CAPTURE_FAILED`) after a GET shows CREATED; void it |
| void | same id again | **200 VOIDED** (204 without `Prefer: return=representation`) | replay → SUCCEEDED |
| void | new id, already voided | 422 `PREVIOUSLY_VOIDED` | RECONCILE → VOIDED → SUCCEEDED |
| void | auth was captured | 422 `PREVIOUSLY_CAPTURED` | RECONCILE → CAPTURED → alert (money taken on a loser) |
| authorize (card fields or wallet) | same `authz-<bid>` again | **200**, same authorization id | replay → held |
| authorize (card fields or wallet) | new id | 422 `ORDER_ALREADY_AUTHORIZED` | GET the order, take its authorization (M2) |
| authorize with `payment_source` in the body | any second call | 422 `TRANSACTION_REFUSED` | don't use this pattern; authorize with no body only |
| order create, no `payment_source` (card fields / wallet) | same id again | **200**, same order | replay |
| order create, `vault_id` (MIT) | same id again | **200**, same order | replay |
| order create, raw card (test-card button) | same id again | **422 `TRANSACTION_REFUSED`** (also after a 5 s gap) | not a decline: `needs_reconcile`; our DB row (bid → order id) is the dedupe (INV-4) |
| order create | same `invoice_id`, new id | 422 `DUPLICATE_INVOICE_ID` | RECONCILE: a hold for this bid already exists; find it via the stored order id |
| payout | amount above the available balance | 422 `INSUFFICIENT_FUNDS` (at POST; no batch is created) | RETRY later + alert; a new `sender_batch_id` on retry |
| payout | receiver is the merchant itself | 201 PENDING → batch DENIED, item FAILED `SELF_PAY_NOT_ALLOWED` | PAYOUT_FAILED (config error) |

## Open items

1. **Payout funding (decision needed).** Captures did not raise the payable balance within ≈ 1 h, so a ≈ $50k payout funded only by captures has not been shown. Options: pre-fund the merchant sandbox account (the spec's backstop), retry `node spikes/paypal-s7.mjs payout 50000` later in case the captured funds become available, or demo a smaller payout. Once Transaction Search reaches the token, `GET /v1/reporting/balances` will show where the captured money is.
2. Harness note: AO's hidden Browser panel swallowed clicks, so step 1 was submitted with `?auto=40`. That calls the same `placeCardHold()` → `submit()` after the fields are filled. Step 2 was approved by a human in the visible panel.

<!-- s7-evidence:start -->
_Generated by `node spikes/paypal-s7.mjs render` from spikes/s7-evidence/._

### Step 1: card fields (JS SDK v6) + authorize + vault

Last run 2026-11-11T12:58:09.357Z: **PASS**

Browser `submit()` result: `{"state":"succeeded","data":{"orderId":"9DL281081J795823H"}}`

Vault after authorize: **VAULTED** (id 9ff3…)

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create (card fields) | `efa18813-c055-4398-b336-9acb75a48135` | 201 | CREATED | – | ca58d7736fc59 | 1289 | – |
| authorize | `authz-efa18813-c055-4398-b336-9acb75a48135` | 201 | CREATED | – | ca58d775478d6 | 2199 | order COMPLETED; vault VAULTED 9ff3…; 3DS "n/a" |
| authorize replay same id | `authz-efa18813-c055-4398-b336-9acb75a48135` | 200 | COMPLETED | – | ca58d77629cb5 | 1724 | same auth id: true |
| authorize again new id | `authz-efa18813-c055-4398-b336-9acb75a48135-2` | 422 | – | ORDER_ALREADY_AUTHORIZED | ca58d776d09bb | 2203 | – |
| void | `void-efa18813-c055-4398-b336-9acb75a48135` | 200 | VOIDED | – | ca58d777adda9 | 981 | void (spike cleanup; vault id kept) |

### Step 2: wallet approve + authorize (+ vault?)

Last run 2026-11-11T13:20:14.203Z: **PASS**

Vault after authorize: **VAULTED** (id 67m7…)

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create (wallet + vault) | `2ad2e8f8-ad96-41be-b5e6-40160c80262f` | 200 | PAYER_ACTION_REQUIRED | – | ca58d95b4dd7e | 1194 | – |
| GET order | `–` | 200 | APPROVED | – | ca58d97b5fcf3 | 525 | order state on return |
| authorize | `authz-2ad2e8f8-ad96-41be-b5e6-40160c80262f` | 201 | CREATED | – | ca58d97b8e8c5 | 1916 | order COMPLETED; vault VAULTED 67m7…; 3DS "n/a" |
| authorize replay same id | `authz-2ad2e8f8-ad96-41be-b5e6-40160c80262f` | 200 | COMPLETED | – | ca58d97c5281a | 1220 | same auth id: true |
| authorize again new id | `authz-2ad2e8f8-ad96-41be-b5e6-40160c80262f-2` | 422 | – | ORDER_ALREADY_AUTHORIZED | ca58d97cc7f12 | 1011 | – |
| void | `void-2ad2e8f8-ad96-41be-b5e6-40160c80262f` | 200 | VOIDED | – | ca58d97d2d9a3 | 1006 | void (spike cleanup; vault id kept) |

### Step 3: replays (order create, authorize, void ×2, capture ×2)

Last run 2026-11-11T12:41:37.102Z: **FAIL**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create #1 | `7360b2c3-e9ed-4511-ba27-6b3de77792c7` | 201 | CREATED | – | ca58d5e331d94 | 3516 | first create |
| order create #2 same id | `7360b2c3-e9ed-4511-ba27-6b3de77792c7` | 422 | – | TRANSACTION_REFUSED | ca58d5e495d3c | 3193 | replay → same order: false, same auth: false |
| order create, same invoice_id, new request id | `efa45eab-ec34-4952-b7cb-b845d7eb19bc` | 422 | – | DUPLICATE_INVOICE_ID | ca58d5e5d0a0a | 2423 | rejected |
| order create (no source) | `12ebcbf3-9f4c-4530-b7b1-1ce4c5eb87a4` | 201 | CREATED | – | ca58d5e6c2d25 | 1778 | order for authorize replay |
| authorize #1 | `authz-12ebcbf3-9f4c-4530-b7b1-1ce4c5eb87a4` | 201 | COMPLETED | – | ca58d5e775c62 | 2673 | – |
| authorize #2 same id | `authz-12ebcbf3-9f4c-4530-b7b1-1ce4c5eb87a4` | 422 | – | TRANSACTION_REFUSED | ca58d5e880f2f | 2116 | same auth id: false |
| authorize #3 new id | `authz-12ebcbf3-9f4c-4530-b7b1-1ce4c5eb87a4-2` | 422 | – | TRANSACTION_REFUSED | ca58d5e954c48 | 2502 | rejected |
| GET order | `–` | 200 | CREATED | – | ca58d5ea4da69 | 774 | order CREATED, authorizations: 1 |
| void | `void-7360b2c3-e9ed-4511-ba27-6b3de77792c7` | 200 | VOIDED | – | ca58d5ea9b9c0 | 970 | void #1 |
| void | `void-7360b2c3-e9ed-4511-ba27-6b3de77792c7` | 200 | VOIDED | – | ca58d5eafc9b9 | 953 | void #2 same id |
| order create (void-diff hold) | `53e1d34c-75e7-4fd3-b8c0-5dffff149960` | 201 | CREATED | – | ca58d5eb5ca16 | 2934 | – |
| void | `void-53e1d34c-75e7-4fd3-b8c0-5dffff149960` | 200 | VOIDED | – | ca58d5ec88b4d | 1845 | void #1 |
| void | `void-53e1d34c-75e7-4fd3-b8c0-5dffff149960-retry` | 422 | – | PREVIOUSLY_VOIDED | ca58d5ed3ad1d | 775 | void #2 different id |
| GET authorization | `–` | 200 | VOIDED | – | ca58d5ed87de8 | 1403 | state after double void |
| order create (capture-same hold) | `5b16fe8b-f0dc-4f28-976a-dccaa9adb6e3` | 201 | CREATED | – | ca58d5ee13e69 | 2791 | – |
| capture | `3229d263-8b96-4508-af50-db66a527d63a` | 201 | COMPLETED | – | ca58d5ef2afa0 | 2470 | capture #1 |
| capture | `3229d263-8b96-4508-af50-db66a527d63a` | 200 | COMPLETED | – | ca58d5f022ca6 | 916 | capture #2 same id → same capture id: true |
| order create (capture-diff hold) | `766680d1-f158-466c-9355-3ffbb54e314e` | 201 | CREATED | – | ca58d5f07ddd5 | 3045 | – |
| capture | `fff545dc-9a36-4dca-a4ff-f08fbc10bda4` | 201 | COMPLETED | – | ca58d5f1ada87 | 2433 | capture #1 |
| capture | `6471dc47-70dc-42f2-8daf-6a46c7985f97` | 422 | – | AUTHORIZATION_ALREADY_CAPTURED | ca58d5f2a18be | 1134 | capture #2 different id |
| GET authorization | `–` | 200 | CAPTURED | – | ca58d5f312b0b | 634 | state after double capture: CAPTURED, capture link present: false |
| capture | `cc4eab32-88af-4e4d-9aff-ff8888e2b0ea` | 422 | – | AUTHORIZATION_VOIDED | ca58d5f3528a1 | 905 | capture after void |
| void | `void-766680d1-f158-466c-9355-3ffbb54e314e` | 422 | – | PREVIOUSLY_CAPTURED | ca58d5f3aca39 | 444 | void after capture |
| GET authorization | `–` | 200 | VOIDED | – | ca58d5f3d9fa1 | 578 | state of voided auth |
| void | `void-cleanup-38Y54434SC240091R` | 200 | VOIDED | – | ca58d5f413925 | 1027 | cleanup void |

```json
{
  "orderReplaySame": false,
  "captureReplaySame": true,
  "voidReplayHttp": 200
}
```

### Step 3 (cont.): which order-create replays return the same order

Last run 2026-11-11T12:42:27.580Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| no source, invoice_id #1 | `8d313568-acf9-4d76-b137-e2544e3e231d` | 201 | CREATED | – | ca58d5fea095c | 679 | – |
| no source, invoice_id #2 same id | `8d313568-acf9-4d76-b137-e2544e3e231d` | 200 | CREATED | – | ca58d5fee9af7 | 1728 | same order id: true |
| raw card, no invoice_id #1 | `78e68b50-1214-4485-8c49-c54671f2ad2a` | 201 | CREATED | – | ca58d5ff91c5d | 2654 | – |
| raw card, no invoice_id #2 same id | `78e68b50-1214-4485-8c49-c54671f2ad2a` | 422 | – | TRANSACTION_REFUSED | ca58d6009a96d | 3585 | same order id: false |
| raw card, invoice_id #1 | `971e6a15-e3ce-4a56-8fd8-16dba363619a` | 201 | CREATED | – | ca58d60202a50 | 2762 | – |
| raw card, invoice_id #2 same id | `971e6a15-e3ce-4a56-8fd8-16dba363619a` | 422 | – | TRANSACTION_REFUSED | ca58d60315abb | 2279 | same order id: false |
| raw card, invoice_id #1 | `afe78b0b-5c28-4b8a-8f86-ca26d5b977a2` | 201 | CREATED | – | ca58d603fa859 | 2616 | – |
| raw card, invoice_id #2 same id after 5s | `afe78b0b-5c28-4b8a-8f86-ca26d5b977a2` | 422 | – | TRANSACTION_REFUSED | ca58d606f9f3c | 3178 | same order id: false |

```json
{
  "sameOrderOnReplay": {
    "noSourceWithInvoice": true,
    "cardNoInvoice": false,
    "cardWithInvoice": false,
    "cardWithInvoiceGap": false
  }
}
```

### Step 4: vault: MIT ×2 from one vault_id, CIT hold

Last run 2026-11-11T13:20:56.798Z: **PASS**
Attempts: 2026-11-11T12:43:02.148Z PASS · 2026-11-11T12:58:46.695Z PASS · 2026-11-11T13:20:56.798Z PASS


| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| MIT hold #1 | `5c319c86-6ef9-4cbc-8600-d94b1ed7a3c1` | 201 | CREATED | – | ca58d9875d9ef | 3150 | – |
| MIT hold #1 replay same id | `5c319c86-6ef9-4cbc-8600-d94b1ed7a3c1` | 200 | CREATED | – | ca58d9889ccaf | 2417 | same order id: true |
| MIT hold #2 same vault | `57debb37-a5ec-41a7-9b9f-b9c5bab58b45` | 201 | CREATED | – | ca58d9898a964 | 2971 | – |
| CIT hold (payment_initiator CUSTOMER) | `552b25f4-e233-4f82-8a1c-f19f79ae3fc8` | 201 | CREATED | – | ca58d98ab3901 | 2958 | – |
| wallet MIT hold (paypal.vault_id) | `871e28ce-5e1f-48d9-81c3-c26094e2941e` | 201 | CREATED | – | ca58d98bdba5d | 2113 | authorized at create, no buyer |
| void | `void-5c319c86-6ef9-4cbc-8600-d94b1ed7a3c1` | 200 | VOIDED | – | ca58d98caedae | 917 | cleanup void |
| void | `void-57debb37-a5ec-41a7-9b9f-b9c5bab58b45` | 200 | VOIDED | – | ca58d98d0aec7 | 1092 | cleanup void |
| void | `void-552b25f4-e233-4f82-8a1c-f19f79ae3fc8` | 200 | VOIDED | – | ca58d98d77ae2 | 1047 | cleanup void |
| void | `void-871e28ce-5e1f-48d9-81c3-c26094e2941e` | 200 | VOIDED | – | ca58d98de0f4a | 842 | cleanup void |

```json
{
  "vaultSource": "card-fields (step 1)",
  "mit1": "CREATED",
  "mit2": "CREATED",
  "cit": "CREATED",
  "walletMit": "CREATED"
}
```

### Step 5: mock AUTHORIZATION_EXPIRED on capture

Last run 2026-11-11T12:43:11.817Z: **PASS**

| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| order create | `040fcafb-c893-45be-a9bb-71dde507c631` | 201 | CREATED | – | ca58d615e8a08 | 3008 | – |
| capture | `21d428dd-e490-44bf-afde-8e2a683816c2` | 422 | – | AUTHORIZATION_EXPIRED | 70c28ae654da | 503 | capture with mock AUTHORIZATION_EXPIRED |
| GET authorization | `–` | 200 | CREATED | – | ca58d61748859 | 571 | real state after mocked capture |
| order create (control) | `addb470c-505c-4910-9584-192e8802427e` | 201 | CREATED | – | ca58d61781f35 | 2720 | – |
| capture | `3b7c3e44-ac36-4cce-b51f-43d6dcf61adf` | 403 | – | – | ca58d61891db2 | 459 | control: mock INSTRUMENT_DECLINED |
| void | `void-040fcafb-c893-45be-a9bb-71dde507c631` | 200 | VOIDED | – | ca58d618bf8e3 | 1006 | cleanup void |
| void | `void-addb470c-505c-4910-9584-192e8802427e` | 200 | VOIDED | – | ca58d61923e9c | 854 | cleanup void |

```json
{
  "captureHttp": 422,
  "issue": "AUTHORIZATION_EXPIRED",
  "realStateAfter": "CREATED"
}
```

### Step 6: volume: 300 holds, 5 test cards, concurrency 20

Last run 2026-11-11T13:22:08.262Z: **PASS**
Attempts: 2026-11-11T12:43:59.100Z FAIL · 2026-11-11T12:45:55.929Z PASS · 2026-11-11T13:22:08.262Z PASS


```json
{
  "n": 300,
  "conc": 20,
  "wallMs": 47909,
  "latency": {
    "n": 300,
    "p50": 2792,
    "p95": 3649,
    "max": 4788
  },
  "byStatus": {
    "CREATED": 300
  },
  "perCard": [
    {
      "card": "S7 Visa",
      "ok": 60,
      "total": 60
    },
    {
      "card": "S7 Visa B",
      "ok": 60,
      "total": 60
    },
    {
      "card": "S7 Mastercard",
      "ok": 60,
      "total": 60
    },
    {
      "card": "S7 Amex",
      "ok": 60,
      "total": 60
    },
    {
      "card": "S7 Discover",
      "ok": 60,
      "total": 60
    }
  ],
  "rateLimited": 0,
  "retried": 0,
  "failures": []
}
```

### Step 7: capture ≥ $50k → ≈ $50k payout → GET batch + item → void the rest

Last run 2026-11-11T13:22:40.616Z: **FAIL**
Attempts: 2026-11-11T12:46:34.040Z FAIL · 2026-11-11T13:22:40.616Z FAIL


| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |
|---|---|---|---|---|---|---|---|
| GET balances | `–` | 403 | – | NOT_AUTHORIZED | ca58d9aa51d75 | 346 | before: total null, available null |
| GET balances | `–` | 403 | – | NOT_AUTHORIZED | ca58d9b479c85 | 704 | after captures: total null, available null, delta n/a |
| POST payouts | `41372afc-58da-41e3-89a6-abaf134fb0a8` | 422 | – | INSUFFICIENT_FUNDS | ca58d9b4c088c | 984 | payout 50000.00 USD in 1 item(s), sender_batch_id = attempt id; batch – |
| GET balances | `–` | 403 | – | NOT_AUTHORIZED | ca58d9b523e45 | 356 | after payout: total null, available null |

```json
{
  "captured": 240,
  "attempted": 240,
  "capStatus": {
    "COMPLETED": 240
  },
  "gross": 54960,
  "fees": 1540.8,
  "net": 53419.2,
  "captureWallMs": 25659,
  "captureLatency": {
    "n": 240,
    "p50": 1877,
    "p95": 3088,
    "max": 6071
  },
  "balanceBefore": null,
  "balanceAfterCaptures": null,
  "balanceAfterPayout": null,
  "payout": {
    "value": 50000,
    "attemptId": "41372afc-58da-41e3-89a6-abaf134fb0a8",
    "polls": []
  },
  "voided": "60/60"
}
```

### Step 7 (cont.): payout retries

Every payout attempt (UTC time; each uses a fresh `sender_batch_id`):

| time | USD | items | sender_batch_id | POST HTTP | POST issue / status | batch final | item final | debug id |
|---|---|---|---|---|---|---|---|---|
| 12:47:50 | 50000 | 1 | `efb22c5d-54d8-40c2-9ca8-c324cbe08c08` | 422 | INSUFFICIENT_FUNDS | – | – | f348652f2f52c |
| 12:48:07 | 45000 | 1 | `e3ce0622-3376-446a-82a2-e00a6e35bde9` | 422 | INSUFFICIENT_FUNDS | – | – | f684282ccc8df |
| 12:48:09 | 40000 | 1 | `d379aeaa-14a8-4986-9cff-2b29912c6f1e` | 422 | INSUFFICIENT_FUNDS | – | – | f383430a4e742 |
| 12:48:11 | 30000 | 1 | `9c546476-4b66-4f11-ac63-858980b3611f` | 422 | INSUFFICIENT_FUNDS | – | – | f974740741388 |
| 12:48:14 | 20000 | 1 | `2e607de5-8029-4f59-a74c-f733b049e161` | 422 | INSUFFICIENT_FUNDS | – | – | f7669308994a9 |
| 12:48:45 | 10000 | 1 | `f29ba37c-2803-4be9-a61e-dd7126d6c1f0` | 201 | PENDING | DENIED | FAILED SELF_PAY_NOT_ALLOWED | f83521608fd3e |
| 12:49:11 | 15000 | 1 | `8f6f5ff6-3296-4689-a268-4380818fdbc0` | 422 | INSUFFICIENT_FUNDS | – | – | f48678847abba |
| 12:49:13 | 12500 | 1 | `9288a2c0-5fb1-49bd-aba0-0ed75e7c8523` | 422 | INSUFFICIENT_FUNDS | – | – | f4760151c5ff0 |
| 12:49:15 | 11250 | 1 | `f1b3bf77-0b77-440b-bc77-24e46fd5b019` | 422 | INSUFFICIENT_FUNDS | – | – | f4174493c6872 |
| 12:49:18 | 10625 | 1 | `8e9eed78-a685-4b96-b6e0-9f60d3e674e5` | 422 | INSUFFICIENT_FUNDS | – | – | f2610327b8bef |
| 12:49:22 | 10312 | 1 | `cabe5007-15b6-43a9-ab2d-e4da8efc8919` | 422 | INSUFFICIENT_FUNDS | – | – | f330686cc1efc |
| 12:49:37 | 10000.01 | 1 | `9408e484-bde7-440e-9cd0-fb4619a0e3e3` | 422 | INSUFFICIENT_FUNDS | – | – | f589596d1556a |
| 12:49:39 | null | NaN | `0f84e1c4-1550-4b0b-ae5b-3b83df38e773` | 400 | size must be between 1 and 15000 | – | – | f8404013c294b |
| 12:49:52 | 50000 | 5 | `5c22973c-fd50-449f-b63f-ad1505c2a4ef` | 422 | INSUFFICIENT_FUNDS | – | – | f309514aa864d |
| 12:50:06 | 12000 | 2 | `4d288be8-8a5f-42e2-8493-c601a3ff90c8` | 422 | INSUFFICIENT_FUNDS | – | – | f60800753a331 |
| 12:50:08 | 10000 | 1 | `9595534f-7032-4c58-865b-d2004c281c00` | 422 | INSUFFICIENT_FUNDS | – | – | f60983609881e |
| 12:50:11 | 10000 | 1 | `55194c3e-4b2d-4592-b298-847c57ad53b8` | 422 | INSUFFICIENT_FUNDS | – | – | f43163453a600 |
| 12:50:20 | 5000 | 1 | `13b9ef42-7ed2-4f40-926d-3f3c6c57a89d` | 422 | INSUFFICIENT_FUNDS | – | – | f979212da13de |
| 12:50:51 | 2500 | 1 | `103cf65a-e511-4e87-837a-bd4d3070201e` | 201 | PENDING | DENIED | FAILED SELF_PAY_NOT_ALLOWED | f9890389f1048 |
| 12:50:53 | 3750 | 1 | `358e6efa-69f4-4e0a-89d8-a524880106ce` | 422 | INSUFFICIENT_FUNDS | – | – | f359632267b9f |
| 12:50:55 | 3125 | 1 | `5c755c5a-720d-4384-a849-d11875e423cc` | 422 | INSUFFICIENT_FUNDS | – | – | f48412132ad30 |
| 12:50:58 | 2812 | 1 | `c1c2ae71-7705-4397-9836-41effe237af7` | 422 | INSUFFICIENT_FUNDS | – | – | f819962c7843d |
| 12:51:00 | 2656 | 1 | `959f4015-091d-40ba-9ba8-f369bc400ebe` | 422 | INSUFFICIENT_FUNDS | – | – | f292350af147e |
| 13:22:48 | 50000 | 6 | `5f63fa80-f99d-4779-8054-dab356d264b8` | 422 | INSUFFICIENT_FUNDS | – | – | ca58d9b9ba882 |
| 13:22:54 | 9500 | 1 | `2a86ed4d-064c-4288-9b56-0dbd977b71b9` | 422 | INSUFFICIENT_FUNDS | – | – | ca58d9bc01ec1 |
| 13:23:09 | 5000 | 1 | `c1870cf9-9387-4012-939b-7d8447bdafd2` | 422 | INSUFFICIENT_FUNDS | – | – | ca58d9c1accdc |
| 13:23:10 | 2500 | 1 | `4ddd02da-5d27-4253-bef6-ddf0a37f9f01` | 422 | INSUFFICIENT_FUNDS | – | – | ca58d9c2189a3 |
| 13:23:38 | 1000 | 1 | `14b82a8c-12c8-4d1f-a53c-44eb009bca28` | 201 | PENDING | SUCCESS | SUCCESS | ca58d9c27e892 |

### Final check: every spike authorization GET-checked, none left CREATED

Last run 2026-11-11T13:25:08.498Z: **PASS**
Attempts: 2026-11-11T12:45:09.920Z PASS · 2026-11-11T12:59:58.470Z PASS · 2026-11-11T13:25:08.498Z PASS


```json
{
  "authorizations": 863,
  "before": {
    "VOIDED": 381,
    "CAPTURED": 482
  },
  "voidedNow": 0,
  "voidResults": [],
  "after": {
    "VOIDED": 381,
    "CAPTURED": 482
  },
  "leftCreated": 0,
  "openOrders": []
}
```

<!-- s7-evidence:end -->
