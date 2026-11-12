# Manual steps (what still needs a person)

Everything else in the demo dry run is automated: `npm run demo:dry-run -- --runs 2` (SP-039b) runs crawl → publish → 402s → `demo:mutate --focus` → re-crawl → `sim:buyers` → top-up → **Claude Code CLI** over MCP with the prompt card → W08 `call.charged` → payout run → Paid out → ledger check, then `demo:reset`, a ledger check and the same again, and prints a report for [demo/dry-run-checklist.md](demo/dry-run-checklist.md). The buyer agent is Claude Code CLI, not Claude Desktop ([demo/claude-code-cli.md](demo/claude-code-cli.md)).

The steps below are the ones a script can't or mustn't do. Never paste a key, password or PayPal secret into a doc, chat, ticket or screenshot.

## 1. Before the first run (once per machine)

| # | Step | Why a person |
|---|---|---|
| 1.1 | Complete the repo `.env` from `.env.example`. The SP-039b rehearsal found the shared `.env` **without `SESSION_SECRET`** (`seed:demo` refused to boot). Also set `DEMO_MODE=true`, `DEMO_ADMIN_TOKEN`, `ALLOW_LOCAL_ORIGINS=true`, `DEMO_SITE_URL`, `DEMO_PUBLISHER_PAYOUT_EMAIL`, and `ADMIN_EMAILS=owner@bluebonnet-rentals.example.com` (the demo publisher must be an admin for `POST /admin/ledger/check`) | Secrets: only the owner writes them |
| 1.2 | `DATABASE_URL` / `TEST_DATABASE_URL`: run `npm run dev:db` and paste the two lines it prints | The `.env` is shared by every worktree; each checkout has its own database |
| 1.3 | Sandbox accounts at hand: the **Personal** buyer login (W11 approval) and the separate **US business** publisher account behind `DEMO_PUBLISHER_PAYOUT_EMAIL` (payouts to the merchant itself fail `SELF_PAY_NOT_ALLOWED`) | Account logins; agents never create accounts |
| 1.4 | Claude Code CLI installed and signed in on the recording machine (`claude --version`) | Uses the person's Claude account |

## 2. Each sandbox dry run (the SP-039b acceptance run)

1. Start the stack: `npm run migrate`, `npm run build -w @spigot/gate`, `npm run build -w @spigot/web`, `npm run dev` (API), and the demo site with the env `seed:demo` prints (`npm run dev -w @spigot/demo-site`).
2. `npm run seed:demo` (first time only). Keep its output private: it prints passwords and keys.
3. Export the two passwords it printed **without echoing them** and run the automation with the real wallet top-up:

   ```bash
   read -rs DRY_RUN_PUBLISHER_PASSWORD; export DRY_RUN_PUBLISHER_PASSWORD
   read -rs DRY_RUN_BUYER_PASSWORD; export DRY_RUN_BUYER_PASSWORD
   npm run demo:dry-run -- --runs 2 --topup wallet --out /tmp/dry-run.md
   ```

4. **When it prints "Open …/buyers"** (step 5.2, once per run): sign in to W11 as Acme, pick $20, "Top up with PayPal", approve as the sandbox Personal account, **hold the approval screen 2 s**. The script waits up to 10 minutes (`--topup-wait-min`), then reads the order and capture ids.
5. If a payout item ends **UNCLAIMED**, log in as the publisher business account in the sandbox and claim it (step 8.2 then turns Paid out).
6. In the sandbox web UI, confirm each PayPal id from the report exists: the $20 capture in the merchant's activity (5.3) and the payout in the publisher account (8.3).
7. Paste the report into the checklist (ids, timings) and file every failure (checklist §Failures).

## 3. What only eyes can check (screens)

The automation checks the API behind each screen, not the pixels. Before recording, look at: W03 verified + gate pill, W04 bot report with SIM chips, W05 "I found 3 kinds of records" cards streaming, W06 publish → live card, W08 row **flash** on the Claude Code call (the script sees the `call.charged` event; the flash itself is visual), W09 Sent → Paid out, W14 audit search for each PayPal id.

## 4. The camera take (SP-046)

- Claude Code setup and the B6 shot: [demo/claude-code-cli.md](demo/claude-code-cli.md). `claude mcp add` with Acme's **current** key (`demo:reset` rotates it), then `/mcp` must list 7 Spigot tools: that is the SP-022a human check.
- Use the interactive `claude` session on camera; `--allowedTools` keeps permission prompts out of the shot.
- Narrate the run's real numbers, not the spec's placeholders ([demo/prompt-card.md](demo/prompt-card.md)).

## 5. Follow-ups for other tickets (not changed in SP-039b)

- **Re-takes have nothing to pay out** (SP-038 / SP-036): `demo:reset` leaves the 20 SIM buyers drained, so `sim:buyers` adds $0 and W09 "Run payout now" returns `NO_ITEMS`. `demo:dry-run` re-funds them itself; for the camera, record the payout beat on the first take or run the dry run first.
- **Listing count drifts after `demo:reset`** (SP-038): 2,341 → 2,344, because records of listings `demo:mutate --new` added aren't marked removed when the site reset deletes them.
- **Site slug is the host** (SP-035 / SP-008a): locally `localhost`, so the 402 and endpoint read `/v1/localhost/…`; the prompt card and scraper text assume `bluebonnet`.

- README (SP-044) and Devpost draft (SP-045) still call the buyer agent "Claude Desktop" (README §Claude Desktop, architecture line, Devpost "Built with"). Switch them to Claude Code CLI, or say "any MCP client (Claude Code in the video)".
- W11 "Connect Claude Desktop" snippet (SP-032) can stay as an option; consider adding the `claude mcp add` line next to it.
- Seed / reset name Acme's key "Claude Desktop (demo)" (`DEMO_KEY_NAME`); harmless, but it shows in W11's keys table on camera.
