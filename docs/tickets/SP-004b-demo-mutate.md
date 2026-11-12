# SP-004b: `demo:mutate` + demo-site admin endpoints (mutate / reset over HTTP, mutation log, `--focus`)

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-004a
- **Spec refs:** features/01-demo-site.md §Logic 6; features/05 §Acceptance criteria; features/12 §Pieces 5

## Goal
Make the "changed today" beat real and repeatable, locally **and on Render**: a known set of listings changes, the next crawl emits exactly those JSON Patch changes, and a reset puts everything back.

## Files / modules
`apps/demo-site/src/scripts/mutate.ts`, `apps/demo-site/src/admin.ts` (routes), `apps/demo-site/src/data/store.ts` (write path + mutation log), root script `demo:mutate`.

## Scope
- `npm run demo:mutate -- --prices 30 --leased 5 --new 3 [--seed 42] [--focus "bedrooms>=3,price_usd<2000,city=Austin"] [--target <url>]`:
  - changes `--prices N` rents by ±3–8% (staying inside the focus filter when given), marks `--leased N` listings leased, adds `--new N` listings (inside the focus population when given); **disjoint** sets;
  - bumps `updated_at` and sitemap `lastmod` for touched pages only;
  - prints the slugs changed and writes them to the mutation log.
- Demo-site admin endpoints, token-authenticated (`Authorization: Bearer $DEMO_ADMIN_TOKEN`, disabled when unset):
  - `POST /admin/mutate` (same options as the CLI; the CLI with `--target` calls it);
  - `POST /admin/reset`: rebuild from the seed, clear the mutation log, and set `lastmod = now` on every page the reset reverted, so the next crawl re-fetches them and Spigot's records revert too;
  - `GET /admin/state` (mutation log, counts).
- State = seed + an append-only mutation log in `DEMO_DATA_DIR`; on boot the site replays it (a restart or redeploy keeps mutations).
- `--ping` flag accepted but a no-op until SP-055.

## Acceptance criteria
- [ ] `--prices 30 --leased 5 --new 3` changes exactly 30 rents, 5 statuses, adds 3 listings; sets are disjoint; same seed → same slugs.
- [ ] With `--focus`, all 30 price changes and 3 new listings match the filter.
- [ ] Only touched pages get a new lastmod and ETag.
- [ ] Restarting the demo site keeps the mutations.
- [ ] `POST /admin/reset` restores seed data, and reverted pages have `lastmod` newer than before the reset.
- [ ] Admin endpoints return 401 without the token and 404 when `DEMO_ADMIN_TOKEN` is unset.

## Test plan
Unit: diff counts, disjointness, focus filter. Integration: admin endpoints + restart. The mutate → crawl → changes test is in SP-014a.

## Notes & risks
Mutations are labelled "demo mutation" in the README, and SP-038 triggers a `MANUAL` crawl after a reset.
