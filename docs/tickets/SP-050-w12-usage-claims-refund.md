# SP-050: W12 Buyer usage & claims (refund button) + publisher claims tab

- **Priority:** P1 (spec P1 #2–#3)
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** SP-048a, SP-049, SP-032, SP-030b
- **Spec refs:** screens.md §W12, §W08 (claims tab); features/10 §Screens

## Goal
Buyers see every call and claim and can cash out; publishers see claims against their data.

## Files / modules
`apps/web/src/pages/buyer/Usage.tsx`, `CallDrawer.tsx`, `ClaimsList.tsx`, `RefundCard.tsx`; `apps/web/src/pages/ClaimsTab.tsx` (W08).

## Scope
- Usage AG Grid (time, dataset, endpoint, records, charged, channel, replay flag); call drawer with "Report a bad record"; claims list; "Refund unused balance to PayPal" with the allowed amount.
- Publisher claims tab: open claims with AI recommendation, one-click Credit / Reject (SP-048b).
- Money copy: "credited", "refunded to PayPal".

## Acceptance criteria
- [ ] States: empty, claim auto-credited, pending publisher, refund requested / completed.

## Test plan
Component tests; manual sandbox refund.
