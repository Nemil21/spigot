# SP-056: APIMatic TypeScript + Python SDK from `openapi.yaml`

- **Priority:** P1 (spec P1 #8)
- **Wave:** 7
- **Estimate:** 1.5
- **Depends on:** SP-023, SP-040
- **Spec refs:** features/11 §Logic 10; README §Sponsors (APIMatic)

## Goal
Developers `npm i` a typed client instead of hand-writing fetch calls; APIMatic sponsor fit.

## Files / modules
`packages/sdk/typescript/`, `packages/sdk/python/` (generated, committed), `packages/sdk/README.md`, CI smoke test.

## Scope
- Import `openapi.yaml` into APIMatic, generate TS + Python; commit; README 5-line example; smoke test runs the example against a local server (TS) in CI.

## Acceptance criteria
- [ ] The README example runs against the deployed API.

## Test plan
CI smoke (TS); manual Python run.

## Notes & risks
Needs the human's APIMatic account (generation is a web/CLI step).
