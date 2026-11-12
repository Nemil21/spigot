# SP-004b: `demo:mutate` script (prices, leased, new; reproducible seed)

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1
- **Depends on:** SP-004a
- **Spec refs:** features/01-demo-site.md §Logic 6; features/05 §Acceptance criteria; features/12 §Pieces 5

## Goal
Make the "changed today" beat real: a command that changes a known set of listings so the next crawl emits exactly those JSON Patch changes.

## Files / modules
`apps/demo-site/src/scripts/mutate.ts`, root script `demo:mutate` (`npm run demo:mutate -- --prices 30 --leased 5 --new 3 [--seed 42]`), `apps/demo-site/src/data/store.ts` (write path), an admin-only reload hook so the running site picks up the new data.

## Scope
- Changes `--prices N` listing rents by ±3–8%, marks `--leased N` listings as leased (status), adds `--new N` listings; **disjoint** listing sets.
- Bumps `updated_at` and sitemap `lastmod` for touched pages only.
- Prints a summary (slugs changed) and writes `data/last-mutation.json` (used by tests and by SP-052a/SP-055).
- Reproducible with `--seed`.
- `--ping` flag accepted but a no-op until SP-055.

## Acceptance criteria
- [ ] `--prices 30 --leased 5 --new 3` changes exactly 30 rents, 5 statuses, adds 3 listings; sets are disjoint.
- [ ] Same seed → same slugs.
- [ ] Only touched pages get a new lastmod and ETag.

## Test plan
Unit: diff counts and disjointness. Integration with SP-013 lands in that ticket's mutate → crawl → changes test.

## Notes & risks
Mutations are labelled "demo mutation" in the README and in the crawl run `trigger=DEMO_MUTATE` when SP-009b's API is called with that trigger.
