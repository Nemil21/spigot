# SP-057: W01 Landing page

- **Priority:** P1 (spec P1 #9)
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-024b
- **Spec refs:** screens.md §W01; features/16 §Landing

## Goal
A one-page explanation for judges and visitors.

## Files / modules
`apps/web/src/pages/Landing.tsx` (route `/`).

## Scope
Hero ("Turn your site into a paid API for AI agents" + "Scrapers pay Bright Data. Spigot makes them pay you."), CTAs (Connect your site → W02, I'm an agent builder → W11), stat "1 AI bot for every 31 human visits" (sourced), 4-step how-it-works, mini proposal card visual, "for agents" block (MCP config, sample JSON), honest-limits strip, footer. Responsive to 375 px.

## Acceptance criteria
- [ ] Lighthouse accessibility ≥ 90; both CTAs work.

## Test plan
Manual at 375 / 1280 px.
