# SP-046: Demo video + Devpost submission (after code freeze)

- **Priority:** P0
- **Wave:** 7
- **Estimate:** 3
- **Depends on:** SP-039, SP-038, SP-044, SP-045, SP-036, SP-037
- **Spec refs:** features/12-buyer-agent-demo.md §Video script, §Rules for the recording, §Acceptance criteria; features/16 §Devpost

## Goal
The video carries the submission: owner problem → AI schema → scraper 402 → PayPal top-up → paid MCP call → payout.

## Files / modules
`docs/demo/video-script.md` (final), YouTube link in README and Devpost.

## Scope
- After deploy (18:00–19:30 IST): `demo:reset`, `seed:demo`, `sim:bots`, `sim:buyers --live` on Render; two full dry runs.
- Record ≤ 3:00 per the script; say which numbers are simulated; keep the PayPal approval screen visible 2 s; no real brands, no copyrighted music.
- Upload public to YouTube; final README links; Devpost submitted by **23:30 IST** (hard deadline 01:30 IST Nov 13 = 12:00 PST Nov 12).

## Acceptance criteria
- [ ] Video < 3:00, public.
- [ ] Every PayPal id on screen exists in the sandbox.
- [ ] Devpost submitted with test accounts and the repo link.

## Test plan
Two dry runs on the deployed services before recording.

## Notes & risks
Human-led (screen, voice, Claude Desktop, PayPal approval). If the P0 freeze slips past 18:00 IST, this window shrinks first; see INDEX §Time budget.
