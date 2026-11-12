# SP-009a1: Crawler I/O: `safeFetch` (SSRF, pinned IP, redirect hops), sitemap / sitemap index, page upsert

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1
- **Depends on:** SP-001a, SP-002
- **Spec refs:** features/03-site-onboarding-crawl.md §Logic 3.1–3.2, §Edge cases; features/14 §Security checklist (SSRF); data-model.md §pages

## Goal
The crawler's I/O layer: fetch safely from a publisher's origin, read its sitemap, and keep `pages` in step with it.

## Files / modules
`apps/api/src/crawl/safeFetch.ts`, `sitemap.ts`, `normalizeUrl.ts`, `pages.ts`.

## Scope
- `safeFetch(url, opts)` (undici): resolve DNS once and **pin the resolved IP** for the connection (no DNS rebinding); block private, loopback, link-local, CGNAT and metadata ranges unless `ALLOW_LOCAL_ORIGINS=true` (dev only); follow redirects manually (max 3) and **re-check every hop** (same origin and same IP rules); no cookies; 10 s timeout; 5 MB body cap.
- `readSitemap(site)`: sitemap or sitemap index (recursive, max depth 2), cap 10k URLs, ignore off-origin URLs, return `{url, lastmod}`.
- `normalizeUrl`: absolute, no fragment, sorted query.
- `upsertPages(siteId, entries)`: upsert `pages` (url, `sitemap_lastmod`), set `removed_at` on URLs no longer listed; returns `{new, changed, removed}`.
- SP-008a uses `safeFetch` for its robots/sitemap/verify checks (no second implementation).

## Acceptance criteria
- [ ] A sitemap URL pointing to `http://169.254.169.254/` is never fetched.
- [ ] **A redirect from a public URL to `169.254.169.254` (or to `127.0.0.1`) is blocked.**
- [ ] A host that resolves to a public IP and then to a private one on the next lookup is still blocked (pinned IP).
- [ ] Sitemap index with two child sitemaps → all URLs; an off-origin URL is ignored; > 10k URLs capped with a flag.
- [ ] Re-running `upsertPages` with the same list changes nothing; a dropped URL gets `removed_at`.

## Test plan
Unit (stub resolver + local HTTP servers for redirects); `pages` upsert as `*.db.test.ts`.
