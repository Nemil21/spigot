# SP-055: CMS ping `POST /api/sites/:id/ping` + `demo:mutate --ping`

- **Priority:** P1 (spec P1 #7)
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-009b, SP-004b
- **Spec refs:** api.md §`POST /api/sites/:id/ping`; features/05 §Logic 8; features/01 §Logic 6

## Goal
A publisher's CMS says "these URLs changed" and only those are re-crawled, seconds later.

## Files / modules
`apps/api/src/routes/ping.ts`; `crawlSite` targeted mode (`trigger=PING`, url list); `demo:mutate --ping`.

## Scope
- Auth: crawl key (`ck_…`) as Bearer; ≤ 500 URLs, on-origin only, in the sitemap; 1 ping / 10 s / site (429); 202 with run id; joins the live run if one exists.

## Acceptance criteria
- [ ] `demo:mutate --prices 3 --ping` → 3 update changes within 30 s, no full crawl.

## Test plan
Integration with the demo site.
