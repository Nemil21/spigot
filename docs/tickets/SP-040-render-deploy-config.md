# SP-040: Render deploy config: `render.yaml`, paid Postgres, env, migrate on deploy, demo site service

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a, SP-002, SP-004a
- **Spec refs:** README §Tech stack, §Sponsors (Render); features/01 §Edge cases; features/03 §Render Workflows layout
- **Holdfast reference (read-only):** `render.yaml`, `scripts/smoke-deploy.mjs`

## Goal
A blueprint that deploys the API (serving the web app), the demo site and a paid Postgres, so the deploy after 18:00 IST is one click.

## Files / modules
`render.yaml`, `scripts/smoke-deploy.mjs`, `docs/deploy.md` (env var list, which are secrets, sandbox accounts).

## Scope
- Services: `spigot-api` (web, Node, build all, `npm run migrate && npm start`, health `/api/healthz`), `bluebonnet-rentals` (web, demo site, paid starter so it doesn't sleep, env `SPIGOT_GATE_KEY`, `SPIGOT_API_BASE`, `SPIGOT_VERIFY_TOKEN`, `SPIGOT_GATE_DEMO=1`), Postgres **paid** plan (free expires before judging ends Dec 21).
- Env groups; secrets `sync: false`; `PAYPAL_API_BASE` sandbox; `WORKFLOWS_MODE=inproc` default.
- Workflows service stub entry (SP-041 completes it).
- Smoke script: healthz, catalog, a gate 402 from the demo site, policy fetch.
- Auto-deploy off for the recording window (documented).

## Acceptance criteria
- [ ] `render blueprint validate` (or the dashboard preview) accepts the file.
- [ ] Local `node scripts/smoke-deploy.mjs <base>` passes against the local stack.
- [ ] No secret values in `render.yaml`.

## Test plan
Validate the blueprint; smoke locally. Real deploy happens after code freeze (needs the human's Render account).

## Notes & risks
Render deploy itself is post-freeze; any blueprint error found then costs video time, so validate early.
