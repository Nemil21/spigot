# SP-051: Gate reverse-DNS verification for search crawlers (async, cached)

- **Priority:** P1 (spec P1 #4)
- **Wave:** 3
- **Estimate:** 1
- **Depends on:** SP-006b
- **Spec refs:** features/02 §Classification rules 5

## Goal
Fake "Googlebot" UAs stop getting a free pass, without any DNS on the request path.

## Files / modules
`packages/gate/src/verifySearch.ts` (`node:dns/promises`, no deps).

## Scope
- SEARCH UA first seen from an IP → pass, queue async reverse + forward-confirm (`*.googlebot.com`, `*.google.com`, `*.search.msn.com`, Apple, DuckDuckGo, Yandex domains); cache per IP 24 h (bounded LRU); failed → reclassify that IP as SCRAPER_TOOL.
- Never awaited in the middleware.

## Acceptance criteria
- [ ] Spoofed Googlebot from an unverified IP → 402 after verification completes; genuine (mocked resolver) stays PASS.
- [ ] Bench unchanged (p50 < 1 ms).

## Test plan
Unit with a mocked resolver.
