# 16: Landing Page, Catalog Page, README & Devpost

**Priority:** P0 (catalog page W13, README, Devpost copy) · P1 (landing page W01) · **Owner:** A (pages), B (README/Devpost) · **Effort:** 2.5 h

## Purpose
Every 402 points somewhere useful (the catalog page), judges understand the product from the README without running it, and PayPal + AI are impossible to miss in the Devpost description and "Built With".

## Screens
W13 Public catalog `/c/:site` (P0) · W01 Landing (P1)

## Catalog page (P0)
- Site name, "Data sold by the site owner through Spigot", dataset cards (type, record count, fields, price per 1,000, freshness), quick-start tabs (curl, MCP config, SDK P1), "Get an API key and top up with PayPal" → W11, terms (license: contract terms for factual data; no resale; attribution optional).
- Server-rendered, no login, < 50 KB, works for curl users (`Accept: application/json` returns the catalog JSON).

## Landing (P1)
Content in W01 (screens.md). Keep it one page; reuse W05 card and W08 grid screenshots.

## README (P0) sections
1. One line + pitch line.
2. Problem and persona (the small directory/listings owner; numbers from the research doc with sources: 1 bot per 31 humans, TollBit; Bright Data revenue; Apify Maps actor pricing).
3. How it works (diagram from the spec README).
4. **PayPal APIs used** table: Orders v2 (CAPTURE top-ups), JS SDK v6, Vault (card / PayPal wallet, merchant-initiated auto top-up), Payouts (batched), Refunds (P1), Webhooks, `PayPal-Request-Id` idempotency; why not micropayments; why not Agent Toolkit for the buyer agent; production path = multiparty.
5. **AI used:** Claude API schema agent (proposes record types, writes the extractor, self-checks and repairs), claims triage (P1), Claude Desktop as the buyer agent over MCP. State the "zero AI calls per page after approval" design.
6. Sponsors: Render (services + Postgres + Workflows), AG Grid (dashboard), APIMatic (Context Plugin; SDK if done).
7. Setup: env vars (`.env.example`), sandbox accounts (merchant, publisher business, buyer personal), `npm run seed:demo`, Claude Desktop config.
8. **Test accounts** for judges (sandbox personal buyer login, demo publisher login) — sandbox only.
9. What's real vs simulated (15).
10. Honest limits (spec README).
11. What's next: Web Bot Auth, multiparty, Subscriptions for flat-rate feeds, WordPress plugin for the gate.
12. License: MIT (detectable in the repo About).
13. Built during the hackathon (new repo, Nov 11–12).

## Devpost
- Title: "Spigot: turn your site into a paid API for AI agents".
- Built With: PayPal Orders v2, PayPal Vault, PayPal Payouts, PayPal Refunds, PayPal Webhooks, PayPal JS SDK v6, Claude API, Claude Desktop, MCP, Render, Render Workflows, AG Grid, APIMatic, Node.js, TypeScript, Postgres.
- Tick sponsors: Render, AG Grid, APIMatic (only those actually used).
- Mention it's our second, substantially different submission (Holdfast is the other).

## Acceptance criteria
- [ ] Every 402 link resolves to a working catalog page.
- [ ] README has every section above and no secrets.
- [ ] Devpost draft saved by Nov 12 08:00 PST; submitted by 10:00 PST.

## Test plan
Fresh-clone run-through of the README setup on a clean machine (or a teammate) on Nov 11 night.
