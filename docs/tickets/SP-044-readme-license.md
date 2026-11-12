# SP-044: README + LICENSE (MIT)

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1.5
- **Depends on:** SP-040
- **Spec refs:** features/16-landing-and-docs.md §README sections; README §Honest limits, §P2, §Where PayPal shows up, §Where AI shows up; research/15-gstack-spigot.md (numbers with sources)

## Goal
Judges understand Spigot from the README without running it.

## Files / modules
`README.md`, `LICENSE` (MIT, detectable by GitHub), `docs/architecture.md` (diagram from the spec README).

## Scope
All 13 sections of features/16: pitch; problem + persona with sourced numbers (TollBit 1 bot per 31 humans; Bright Data > $300M ARR; Apify Maps ~$2.10 / 1,000); how it works; **PayPal APIs used** table (Orders v2 CAPTURE, JS SDK v6, Vault card/wallet + MIT auto top-up, Payouts batched, Refunds, Webhooks, `PayPal-Request-Id`), why not micropayments, why not Agent Toolkit for the buyer agent, production path = multiparty; **AI used** (schema agent, claims triage, Claude Desktop over MCP; zero AI calls per page after approval); sponsors (Render, AG Grid, APIMatic); setup (`.env.example`, three sandbox accounts: merchant, **separate publisher business account**, buyer personal; `seed:demo`; Claude Desktop config); test accounts (sandbox only); real vs simulated table; honest limits; what's next incl. every P2 item (Web Bot Auth, Subscriptions for feeds, Elastic `/search`, canary records, JS tag analytics, multi-site UI, Playwright/KERNEL, multiparty `platform_fees`); license; built during the hackathon; PayPal sandbox gotchas (SELF_PAY_NOT_ALLOWED, INSUFFICIENT_FUNDS on large payouts).
- Mention the APIMatic PayPal Context Plugin used while coding the PayPal path.
- Update the deployed URLs after deploy (post-freeze, same ticket owner or SP-046).

## Acceptance criteria
- [ ] Every section present; no secrets (gitleaks).
- [ ] GitHub detects MIT.
- [ ] Every claim of "real" in the real-vs-simulated table matches the code.

## Test plan
Fresh-clone run-through of the setup section by someone other than the author.

## Notes & risks
Draft starts in Wave 3; deployed URL and the "which mode ran the demo" line land after deploy. Include the gstack assignment answers (2 site owners, 2 agent builders) only if any arrive before recording.
