# SP-039b: Local end-to-end dry run with Claude Desktop (human-led, before the freeze)

- **Priority:** P0
- **Wave:** 7
- **Estimate:** 1
- **Depends on:** SP-035, SP-032, SP-030b, SP-038, SP-022a, SP-039a
- **Spec refs:** features/12-buyer-agent-demo.md §Video script, §Acceptance criteria

> **Change of plan (Nov 12, the human):** there is no Claude Desktop. The buyer agent is **Claude Code CLI** (`claude mcp add --transport http spigot <api>/mcp --header "Authorization: Bearer <key>"`, then `claude` / `claude -p` with the prompt card); see [docs/demo/claude-code-cli.md](../demo/claude-code-cli.md). `npm run demo:dry-run` automates every step it can; what still needs a person is in [docs/MANUAL-STEPS.md](../MANUAL-STEPS.md). Read "Claude Desktop" below as "Claude Code CLI".

## Goal
Prove the whole video script works end to end on the local stack before the freeze, with a person at Claude Desktop and the PayPal approval, so the recording slot isn't spent debugging.

## Files / modules
`docs/demo/dry-run-checklist.md` (filled in: ids, timings, failures, links to issues).

## Scope
- Follow SP-039a's checklist on the local stack: `seed:demo` → crawl → approve (W05/W06) → `demo:mutate --focus …` → top-up $20 with PayPal (W11, sandbox Personal account) → Claude Desktop prompt card → W08 row flashes → `demo:payout` → W09 Sent → Paid out → `demo:reset` → repeat once.
- Confirm the SP-022a human check (Claude Desktop lists the tools).
- File every failure as a fix ticket or a comment on the owning ticket; note what the video must avoid.

## Acceptance criteria
- [ ] Two full runs in a row, with `demo:reset` between them, recorded in the checklist with PayPal ids.
- [ ] Ledger check (`POST /admin/ledger/check`) = 0 after each run.

## Test plan
Manual (human-led: Claude Desktop and the PayPal approval need a person).

## Notes & risks
Human-in-the-loop. SP-046 repeats this on Render after deploy.
