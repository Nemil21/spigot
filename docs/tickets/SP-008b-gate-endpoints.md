# SP-008b: Gate endpoints: `GET /api/gate/policy`, `POST /api/gate/hits`, gate-status

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1
- **Depends on:** SP-008a
- **Spec refs:** api.md §Gate endpoints, §`GET /api/sites/:id/gate-status`; data-model.md §bot_hits, §sites.policy; features/02 §Hit counting

## Goal
The two calls the gate makes (never on the request path), and the "gate installed" signal for W03.

## Files / modules
`apps/api/src/gate/policy.ts`, `hits.ts`, `gateAuth.ts`; routes `GET /api/gate/policy`, `POST /api/gate/hits`, `GET /api/sites/:id/gate-status`; shared zod schemas in `packages/shared/src/gate.ts` (policy + hits payloads, imported by SP-006b's tests).

## Scope
- Gate auth: `Bearer gk_…` → site by hash.
- Policy response exactly as api.md: `siteId`, `policyVersion`, `apiBase`, `catalogUrl`, `crawlKeySha256`, `gatedPaths` (from LIVE datasets' template patterns plus the site's configured regexes), `decisions`, `prices` (LIVE datasets). ETag = `policyVersion`.
- `bumpPolicyVersion(tx, siteId)` helper used by SP-014 (approve/unpublish), SP-034 (settings) and key rotation.
- Hits: validate, upsert `bot_hits` with `hits = hits + EXCLUDED.hits`, `bytes = bytes + …`; update `sites.last_gate_seen_at`; `notify('publisher_events', {type:'hits'})`; 204. Rate limit 1 post / 5 s / site (429 otherwise).
- Gate status `{installed, lastSeenAt, policyVersion}` (`installed` = seen in the last 10 min).

## Acceptance criteria
- [ ] Gate key of site A can't read site B's policy.
- [ ] Two posts with the same bucket/key sum hits.
- [ ] `policyVersion` increments after `bumpPolicyVersion`, and the response changes.
- [ ] With a LIVE dataset on `/listings/:slug` (fixture rows, or the real approve path once SP-014 has merged), `gatedPaths` includes `^/listings/`; after unpublish it doesn't.
- [ ] A post within 5 s of the previous one → 429; the gate drops it (SP-006b).

## Test plan
Integration: policy shape (zod), hits upsert, rate limit, cross-site isolation.

## Notes & risks
`is_simulated` is part of the key, so SIM and real hits never merge.
