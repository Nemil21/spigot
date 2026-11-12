# SP-006b: Gate middleware: fail-open, policy refresher, hit flusher, SIM flag; installed on the demo site

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1.5
- **Depends on:** SP-006a, SP-004a
- **Spec refs:** features/02-gate-middleware.md §Design, §Hit counting, §Edge cases; features/15 §Live simulators; api.md §Gate endpoints

## Goal
`spigotGate(opts)` Express middleware that can never take the publisher's site down, reports hit counts, and is live on Bluebonnet Rentals.

## Files / modules
`packages/gate/src/middleware.ts`, `refresher.ts`, `flusher.ts`, `index.ts`; `apps/demo-site/src/server.ts` (install); `apps/demo-site/.env.example` (`SPIGOT_GATE_KEY`, `SPIGOT_API_BASE`, `SPIGOT_GATE_DEMO`).

## Scope
- Policy refresher: `GET {apiBase}/api/gate/policy` with `Authorization: Bearer gk_…` at boot and every 60 s, 2 s timeout, keeps the last good policy; never loaded → pass everything (logged once).
- Middleware: `try { classify → count → next() or send402 } catch { countFailOpen(); next() }`. JSON 402 by default; HTML (D04) when `Accept` prefers `text/html`. Status 402, never 403.
- Hit flusher: in-memory counters keyed `(minute, category, botName, decision, isSimulated)`; bytes from `content-length` for PASS, estimated for 402; flush every 10 s via `POST /api/gate/hits` (2 s timeout, fire-and-forget); drop after 3 failed tries; max 10k keys. Humans aggregated as (`HUMAN`, `-`), no IP or path stored.
- SIM: when `SPIGOT_GATE_DEMO=1` and the request has `X-Spigot-Sim: 1`, counts go to `isSimulated=true`.
- Installed on the demo site before routes.

## Acceptance criteria
- [ ] With the Spigot API stopped, slow (10 s) or returning 500 for policy, humans get 200 within 1 s on every request.
- [ ] An exception injected into classify → PASS (counted as `FAIL_OPEN`).
- [ ] `curl -A GPTBot /listings/x` → 402 JSON with price and API link; with `Accept: text/html` → D04 page.
- [ ] Flusher memory stays bounded with 50k distinct bot names.
- [ ] Our crawler's requests (valid `X-Spigot-Key`) are never 402.

## Test plan
Integration: demo site + gate with a stub policy server in three failure modes; flush payload shape test against SP-008b's zod schema (import the schema from `@spigot/shared` once SP-008b lands; until then a local copy with a TODO).

## Notes & risks
Gate hit posts are rate-limited server-side to 1 per 5 s per site (SP-008b); the flusher's 10 s interval stays under it.
