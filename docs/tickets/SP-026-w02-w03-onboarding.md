# SP-026: W02 sign up + connect and W03 install + verify + first crawl

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-024b, SP-008b, SP-009b
- **Spec refs:** screens.md §W02, §W03; features/03 §User stories

## Goal
A site owner signs up, connects their site, installs the gate, verifies and watches the first crawl.

## Files / modules
`apps/web/src/pages/onboarding/SignUp.tsx`, `ConnectSite.tsx`, `InstallVerify.tsx`.

## Scope
- W02 two-step card: account (name, email, password, **PayPal payout email** with "This is where PayPal Payouts send your earnings"); site URL with live origin check; states: checking, unreachable, no sitemap (editable sitemap URL), success → W03.
- W03 stepper Verify → Install gate → First crawl: verify box (path + content, copy, "Check now" pill); install box (`npm i @spigot/gate` + 3-line Express snippet, `SPIGOT_GATE_KEY`/`SPIGOT_CRAWL_KEY` shown once with copy); live gate-status pill (poll gate-status every 5 s: "Waiting for first hit" → "Installed · last hit 4 s ago"); "Fails open: if Spigot is down, your site keeps working"; "Start first crawl" → progress bar from crawl SSE; failed state with reason + retry; done → W05.

## Acceptance criteria
- [ ] Fresh publisher completes W02 → W03 → crawl against the local demo site with no DB edits.
- [ ] Keys are shown once; a reload shows "rotate in Settings" instead.
- [ ] Every state in screens.md renders (fixture mode).

## Test plan
Component tests per state (fixtures); manual end to end.

## Notes & risks
- On camera (features/12 video 0:20–0:45, "Owner connects the site"), so it is tagged **D** and dispatched ahead of SP-034/SP-043.
- Owns its fixtures under `src/fixtures/`; replaces only its own page files.
