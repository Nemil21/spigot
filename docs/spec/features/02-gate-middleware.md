# 02: Gate Middleware (`spigot-gate`)

**Priority:** P0 (UA classification, 402, fail-open, hit counts) · P1 (reverse-DNS verify for search crawlers) · P2 (Web Bot Auth) · **Owner:** A · **Effort:** 2.5 h

## Purpose
Let humans and search crawlers through untouched; answer self-identified AI crawlers and scraper tools with a polite 402 that points to the API. It must never be able to take the publisher's site down. It also gives the owner value on day 1: a report of who is crawling them.

## User stories
- As a site owner, I install one middleware and immediately see which bots hit me.
- As a site owner, I know my site keeps working even if Spigot is down.
- As a scraper author, I get a clear 402 with the price and the API link instead of a silent block.
- As Googlebot, I'm never blocked (SEO is safe).

## Screens
W03 (install + gate status) · W04 (bot report) · W16 (policy) · D04 (402 HTML)

## Design: one deep function
```ts
// packages/gate/src/classify.ts — pure, no I/O, no network
export function classify(req: { ua: string; ip: string; path: string; headers: Record<string,string> },
                         policy: Policy): { decision: 'PASS' | 'QUOTE' | 'SPIGOT_CRAWLER'; category: Category; botName: string }
```
Middleware wraps it:
```ts
export function spigotGate(opts) {
  const state = startPolicyRefresher(opts);       // background, 60 s, 2 s timeout, keeps last good
  const counter = startHitFlusher(opts);          // background, 10 s, 2 s timeout, drops on failure
  return (req, res, next) => {
    try {
      if (!state.policy) return next();                          // never loaded → fail open
      const r = classify(toInput(req), state.policy);
      counter.add(r, req);
      if (r.decision !== 'QUOTE') return next();
      return send402(res, state.policy, req.accepts('html'));    // static body built at policy load
    } catch { counter.addFailOpen(); return next(); }            // any error → fail open
  };
}
```

## Classification rules (in order)
1. `X-Spigot-Key` header whose SHA-256 equals `policy.crawlKeySha256` → `SPIGOT_CRAWLER` (pass). Constant-time compare.
2. Path not matching any `gatedPaths` (e.g. `/robots.txt`, `/sitemap.xml`, `/`, `/static/*`, `/.well-known/*`) → PASS.
3. UA table (`packages/gate/src/bots.ts`, case-insensitive token match):
   | Category | Tokens | Default |
   |---|---|---|
   | SEARCH | `Googlebot`, `Bingbot`, `DuckDuckBot`, `Applebot` (not `Applebot-Extended`), `YandexBot` | PASS |
   | AI_TRAINING | `GPTBot`, `ClaudeBot`, `anthropic-ai`, `CCBot`, `Google-Extended`*, `Applebot-Extended`, `Bytespider`, `Amazonbot`, `meta-externalagent`, `cohere-ai` | QUOTE |
   | AI_AGENT | `ChatGPT-User`, `Claude-User`, `Perplexity-User`, `PerplexityBot`, `OAI-SearchBot` | QUOTE (owner may switch to PASS) |
   | SCRAPER_TOOL | `python-requests`, `python-urllib`, `aiohttp`, `Scrapy`, `curl/`, `Wget`, `Go-http-client`, `node-fetch`, `axios`, `HeadlessChrome`, `Apify` | QUOTE |
   | UNKNOWN / HUMAN | everything else | PASS |

   *`Google-Extended` is a robots.txt token, not a UA; we list it in the robots.txt helper, not the matcher.
4. Decision = `policy.decisions[category]`.
5. P1: SEARCH UAs are only trusted after reverse-DNS + forward-confirm (`*.googlebot.com`, `*.search.msn.com`). Done **asynchronously**: first request passes, the result is cached per IP for 24 h; a failed verification reclassifies that IP as SCRAPER_TOOL. Never a DNS lookup on the request path.

## 402 response
Body and headers as in [api.md](../api.md#the-402-contract), built once per policy load (static string). JSON by default; HTML (D04) if `Accept` prefers `text/html`. `Cache-Control: no-store`. Status 402, never 403, so well-behaved clients know there is a paid path.

## Hit counting
- In-memory counters keyed `(minute, category, botName, decision)`; bytes from `res` `content-length` for PASS.
- Flushed every 10 s via `POST /api/gate/hits` (fire-and-forget, 2 s timeout); on failure the buffer is dropped after 3 tries (bounded memory: 10k keys max).
- Humans are counted as one aggregate row (`HUMAN`, `-`), no IP or path stored (privacy).

## Performance budget
- `classify` < 1 ms p50, < 50 ms worst case (the review's budget); bench in CI with 10k mixed requests.
- Zero runtime dependencies in `packages/gate`.

## Edge cases
| Case | Handling |
|---|---|
| Spigot API down | Policy refresher keeps the last good policy; hits dropped; site unaffected |
| Gate started while Spigot is down | No policy → pass everything (logged once) |
| Exception inside classify | Caught → pass (counted as FAIL_OPEN) |
| Scraper spoofs a browser UA | Passes. Stated in Honest limits; the pitch is "paying is cheaper and better than evading" |
| Googlebot misclassified | Unit test table + CI; SEARCH default PASS |
| Our crawler's key leaked | Rotate in W16; policy refresh picks up the new hash within 60 s |
| Owner turns a category to PASS | `policy_version` bump; gate picks it up within 60 s |

## Acceptance criteria
- [ ] Fixture table test: Googlebot → PASS; GPTBot → 402; `python-requests/2.32` → 402; Chrome desktop UA → PASS; valid `X-Spigot-Key` → PASS; non-gated path with GPTBot → PASS.
- [ ] With the Spigot API stopped, the demo site serves humans and bots normally within 1 s of the next request (fail-open test).
- [ ] An exception thrown from classify (injected) results in PASS.
- [ ] Hits appear on W04 within 15 s.
- [ ] Bench: p50 < 1 ms.

## Test plan
Unit: fixture table (≥ 30 UAs). Integration: start demo site + gate with the API down / slow (10 s) / returning 500 for policy; assert humans always 200. Manual: `curl -A GPTBot …/listings/x` shows the 402 JSON.
