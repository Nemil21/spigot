# SP-065: DOM-fingerprint cluster confirmation

- **Priority:** P1 (feature 04 P1)
- **Wave:** 2
- **Estimate:** 1
- **Depends on:** SP-010
- **Spec refs:** features/04 §1 (P1: DOM fingerprint, Jaccard ≥ 0.8)

## Goal
Catch URL patterns that mix two layouts before the AI sees them.

## Files / modules
`packages/shared/src/cluster.ts` (`fingerprint(html)` tag-path shingles; `confirmCluster`).

## Scope
For each URL cluster, compare sample fingerprints; Jaccard < 0.8 → split into sub-templates.

## Acceptance criteria
- [ ] A fixture cluster mixing listing and agent layouts under one pattern splits in two; demo-site clusters stay unchanged.

## Test plan
Unit on fixtures.
