# SP-058: Log in with PayPal for publishers

- **Priority:** P1 (spec P1 #10)
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** SP-007a, SP-026
- **Spec refs:** features/14 §Auth; data-model.md §publishers.paypal_payer_id; screens.md §W16 ("Connect with PayPal")
- **Holdfast reference (read-only):** HF-010 brand sign-in with Log in with PayPal

## Goal
Publishers sign in with PayPal and get a verified payout email in one step.

## Files / modules
`apps/api/src/auth/paypalOidc.ts`, routes `GET /api/auth/paypal/start`, `/api/auth/paypal/callback`; W02 button, W16 "Connect with PayPal".

## Scope
OIDC auth-code flow against sandbox (state + nonce), userinfo email → `payout_email`, `paypal_payer_id` unique; link to an existing password account when signed in.

## Acceptance criteria
- [ ] Sandbox login creates or links a publisher; payout email filled from PayPal.

## Test plan
Integration with a stubbed OIDC provider; one sandbox run.

## Notes & risks
Needs "Log in with PayPal" enabled on the sandbox app with the return URL (human step in the developer dashboard).
