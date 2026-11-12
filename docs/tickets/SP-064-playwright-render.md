# SP-064: Playwright render for JS-heavy templates

- **Priority:** P1 (feature 03 P1)
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-009a2
- **Spec refs:** features/03 §Logic 9; README §P2 (KERNEL cloud browsers stay P2)

## Goal
Sites that render listings in the browser can still be crawled, for the templates that need it only.

## Files / modules
`apps/api/src/crawl/render.ts` (Playwright Chromium, optional dependency), template flag `render: 'html' | 'browser'`.

## Scope
Heuristic on sample pages (little text, much `<script>`) → mark template `browser`; `fetchPage` renders those through headless Chromium (same crawl key header, no cookies, concurrency 1); snapshot = rendered HTML.

## Acceptance criteria
- [ ] A fixture SPA page yields the same records as its server-rendered twin.
- [ ] The demo site (server-rendered) never triggers browser mode.

## Test plan
Integration with a fixture SPA; Playwright installed only in that test job.

## Notes & risks
Chromium is heavy on the 16 GB laptop and on Render; keep it off by default.
