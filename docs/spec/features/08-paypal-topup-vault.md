# 08: PayPal Top-up, Vault & Auto Top-up

**Priority:** P0 (manual top-up with PayPal wallet via JS SDK v6, card vault on first top-up) · P1 (auto top-up via merchant-initiated vault order; MCP `top_up` from vault) · **Owner:** B · **Effort:** 3 h (+1.5 h P1)

## Purpose
Agents can't pay $0.0015 per call with a card: PayPal's fixed fee per capture would eat it. So the human behind the agent funds a **prepaid balance with PayPal**, and the agent spends it call by call. With the payment method saved in **PayPal Vault**, the agent can top itself up mid-session, within a monthly cap the human set. This is the moment PayPal powers the agent.

## User stories
- As an agent builder, I click "Top up $20 with PayPal", approve in the PayPal sandbox, and see $20.00 in my balance.
- As an agent builder, I tick "save for auto top-up" and set "$20 when below $2, max $100/month".
- As my agent, I keep working when my balance runs out mid-task, because Spigot charges my saved PayPal method within my cap.
- As my agent without a saved method, I get an approval link to hand to my human.

## Screens
W11 Buyer portal (balance, top-up, auto top-up, top-ups table) · W15 error copy

## PayPal pieces (and proof status)
| Step | Call | Proof |
|---|---|---|
| Create top-up order | `POST /v2/checkout/orders` `intent: CAPTURE`, `custom_id: topupId`, `PayPal-Request-Id: topupId` | Orders create proven (S1, AUTHORIZE). **S7** for CAPTURE |
| Wallet approval | JS SDK v6 (`paypal-payments` component) with our `orderId`; sandbox Personal account approves | **S7b** |
| Capture | `POST /v2/checkout/orders/{id}/capture`, `PayPal-Request-Id: capture:<topupId>` | **S7** |
| Save method | Card: `attributes.vault.store_in_vault: ON_SUCCESS` (proven S2). PayPal wallet: `payment_source.paypal.attributes.vault{ store_in_vault: ON_SUCCESS, usage_type: MERCHANT, customer_type: CONSUMER }` | Card proven (S2). Wallet: **S8b** |
| Auto top-up | `POST /v2/checkout/orders` `intent: CAPTURE`, `payment_source.card.vault_id` + `stored_credential{payment_initiator: MERCHANT, payment_type: UNSCHEDULED, usage: SUBSEQUENT}` (or `paypal.vault_id`) | Pattern proven for AUTHORIZE (S2). **S8a** for CAPTURE |

## Logic
### Manual top-up (P0)
1. W11: buyer picks $5 / $20 / $50 (min $5, max $500; demo uses $20).
2. `POST /api/buyer/topups { amountCents, method: 'PAYPAL_WALLET', saveForAutoTopup }` → insert `topups` (CREATED) → `pp.createTopupOrder` with the wallet source (+ vault attributes if `saveForAutoTopup` and S8b passed) → `AWAITING_APPROVAL`, return `orderId`.
3. Browser: JS SDK v6 PayPal button `createOrder: () => orderId`; `onApprove` → `POST /api/buyer/topups/:id/capture`.
4. Server: `pp.captureOrder` → status `COMPLETED` → `creditTopup(topupId)` in one transaction: conditional update `→ COMPLETED`, save `paypal_capture_id`, post ledger `TOPUP` (`PAYPAL_CASH −`, `BUYER_BALANCE +`, key `topup:<id>`). Save `vault_id`/`vault_kind` if returned.
5. W11 balance animates up; audit `TOPUP_COMPLETED` with order + capture ids.
6. Backups: `/topups/return` redirect (for approval links opened outside W11); webhook `PAYMENT.CAPTURE.COMPLETED`; poller (30 s, 30 min). All call the same idempotent `creditTopup`.
7. Fallback if S7b (wallet) fails: card top-up using the sandbox test card through JS SDK v6 card fields (still a PayPal payment, still vaulted).

### Auto top-up (P1)
Called from `chargeAndRecord` (07) when a charge fails on balance:
1. `SELECT … FROM buyers WHERE id=$1 FOR UPDATE`.
2. Skip unless: `auto_topup_enabled`, `vault_id` set, no AUTO top-up `CREATED` in flight, and `month_auto_sum + amount ≤ monthly_topup_cap_cents`. Also require `balance + amount ≥ price` (else it wouldn't help → 402).
3. Insert `topups` (trigger AUTO, method VAULT_MIT) → `pp.createTopupOrder` with `vault_id` + `stored_credential` → card captures in the create call (`COMPLETED`) → `creditTopup`.
4. Retry the charge once. The response carries `Spigot-Auto-Topup: 2000` and the MCP result mentions it ("Topped up $20 from your saved PayPal method").
5. On decline (`INSTRUMENT_DECLINED`, testable with `PayPal-Mock-Response`): top-up FAILED, set `auto_topup_enabled=false`, return 402 with "auto top-up declined", notify the buyer (W11 banner).
6. Timebox: the PayPal call has a 10 s timeout; on timeout return 402 and let the poller/webhook credit later (idempotent).

### MCP `top_up` (P1; P0 returns the approval link)
- With a vaulted method and the amount within the cap → steps 3–4 above, `trigger=MCP`.
- Otherwise → create a wallet order and return `approveUrl` (`https://www.sandbox.paypal.com/checkoutnow?token=…`) with return URL `/topups/return`. The agent shows the link to its human.

## Fees (README note)
In sandbox we're merchant of record. On a $20 top-up, PayPal's standard fee (~3.49% + $0.49) is ours to absorb, so the minimum top-up is $5. Production: publisher-as-merchant via multiparty, or pass fees to buyers.

## Edge cases
| Case | Handling |
|---|---|
| Buyer closes PayPal popup | Top-up stays AWAITING_APPROVAL → ABANDONED after 30 min (cron) |
| Approval done but our capture call failed | Webhook `CHECKOUT.ORDER.APPROVED` or poller captures (same request id) |
| Capture PENDING | No credit until `PAYMENT.CAPTURE.COMPLETED` |
| Double click on Top up | Idempotency-Key on the endpoint → same topup |
| Agent loops on `top_up` | Monthly cap + one AUTO in flight + MCP rate limit |
| Vault id revoked by buyer at PayPal | MIT fails → auto top-up disabled → 402 with re-approve link |
| Buyer in an unsupported country/currency | USD only; error copy |

## Acceptance criteria
- [ ] A sandbox Personal account tops up $20 via the PayPal button; balance shows $20.00; ledger TOPUP posted once; order and capture ids in audit.
- [ ] Replaying the capture endpoint, the webhook and the poller for the same top-up credits once.
- [ ] (P1) With auto top-up on and $0.01 left, an MCP `search_records` costing $0.06 triggers one MIT top-up of $20, then succeeds; the W11 table shows trigger AUTO.
- [ ] (P1) Monthly cap reached → 402 `AUTO_TOPUP_CAP_REACHED`, no PayPal call.
- [ ] (P1) Injected decline disables auto top-up and returns 402.

## Test plan
Spikes S7/S8 first (scripted). Integration in sandbox: wallet top-up (manual browser step, recorded early), card + vault, MIT top-up, mock decline. Unit: cap math across months.
