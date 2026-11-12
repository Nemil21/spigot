# SP-006a: Gate core: pure `classify`, UA table, 402 body builder (JSON + D04 HTML), bench

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1
- **Depends on:** SP-001a
- **Spec refs:** features/02-gate-middleware.md §Design, §Classification rules, §402 response, §Performance budget; api.md §The 402 contract; screens.md §D04

## Goal
One deep, pure function that decides PASS / QUOTE / SPIGOT_CRAWLER locally in under 1 ms, and a static 402 body built once per policy.

## Files / modules
`packages/gate/src/classify.ts`, `bots.ts` (UA token table), `policy.ts` (types + parser), `body402.ts` (`build402(policy) → {json, html, headers}`), `robots.ts` (robots.txt helper listing `Google-Extended` etc.), `bench.ts`. **Zero runtime dependencies.**

## Scope
- `classify({ua, ip, path, headers}, policy) → {decision, category, botName}` with rules in order:
  1. `X-Spigot-Key` whose SHA-256 equals `policy.crawlKeySha256` (constant-time compare, `node:crypto`) → `SPIGOT_CRAWLER`.
  2. Path not matching any `gatedPaths` → PASS.
  3. UA token table (case-insensitive) → category: SEARCH (`Googlebot`, `Bingbot`, `DuckDuckBot`, `Applebot` not `Applebot-Extended`, `YandexBot`), AI_TRAINING (`GPTBot`, `ClaudeBot`, `anthropic-ai`, `CCBot`, `Applebot-Extended`, `Bytespider`, `Amazonbot`, `meta-externalagent`, `cohere-ai`), AI_AGENT (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, `PerplexityBot`, `OAI-SearchBot`), SCRAPER_TOOL (`python-requests`, `python-urllib`, `aiohttp`, `Scrapy`, `curl/`, `Wget`, `Go-http-client`, `node-fetch`, `axios`, `HeadlessChrome`, `Apify`), else UNKNOWN/HUMAN.
  4. Decision = `policy.decisions[category]`.
- `build402(policy)`: body and headers exactly as api.md (`Link` alternate + payment, `Cache-Control: no-store`, `Spigot-Price`), and the D04 HTML variant (< 2 KB, no JS, links to catalog and MCP). Built once; `classify` never builds strings.
- Export the 402 JSON **shape** type so SP-017a can assert parity.

## Acceptance criteria
- [ ] Fixture table (≥ 30 UAs): Googlebot → PASS; GPTBot → QUOTE; `python-requests/2.32` → QUOTE; Chrome desktop → PASS; valid `X-Spigot-Key` → SPIGOT_CRAWLER; non-gated path + GPTBot → PASS; `Applebot-Extended` → AI_TRAINING; wrong crawl key → classified by UA.
- [ ] Bench in CI: 10k mixed requests, p50 < 1 ms, max < 50 ms.
- [ ] `packages/gate/package.json` has no `dependencies`.
- [ ] D04 HTML < 2 KB.

## Test plan
Unit fixture table; bench test in `check` job.

## Notes & risks
Stealth scrapers with browser UAs pass, by design; README states it (SP-044).
