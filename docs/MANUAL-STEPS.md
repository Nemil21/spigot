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

## 5. Follow-ups from SP-039b (fixed in PR #95)

- **Re-takes have nothing to pay out**: after `demo:reset`, run `npm run sim:buyers -- --retake`. If the week is already at its target, it re-funds each drained SIM buyer with a $30 SIM card top-up and adds ~$300 SIM gross, so W09 "Run payout now" has an item.
- **Listing count after `demo:reset`**: the reset now retires the records of listings `demo:mutate --new` added, so W05 shows 2,341 again (it prints "N record(s) of removed listings retired").
- **Site slug**: `seed:demo` connects the demo site as `bluebonnet` on any host, so the 402 and endpoint read `/v1/bluebonnet/…` like the prompt card and scraper. A database seeded before this change keeps its old slug: re-seed into a fresh database.
- ~~README / Devpost say "Claude Desktop"~~: done in SP-046.
- **W11 card**: now "Connect your agent", with the `claude mcp add` command first and the Claude Desktop config second. Acme's key is named "Claude Code (demo)". Keep the keys and the command out of frame anyway: they show the key prefix.

## 6. Recording runbook (SP-046)

Human-led, on the deployed Render services. Nothing here is automated, uploaded or submitted by an agent. Script and voiceover: [demo/video-script.md](demo/video-script.md); Devpost text: [devpost.md](devpost.md).

**A. Deploy is up (after the 18:00 IST freeze).** [deploy.md §First deploy](deploy.md#first-deploy-human-after-the-freeze) steps 1–8, then `node scripts/smoke-deploy.mjs https://<spigot-api> --site https://<bluebonnet-rentals> --strict` passes. Note the two Render URLs: they fill every `[[fill]]` URL in the README and devpost.md.

**B. Seed and warm up** (`spigot-api` → Shell; output stays in the Shell, it prints passwords and keys):

1. `npm run seed:demo` (first time only), then `DEMO_MODE=true npm run demo:reset -- --yes` for a clean take. Note Acme's **new** key from the reset output without pasting it anywhere.
2. `npm run sim:buyers -- --live` (the SIM earnings rows in W08 and the payout amount).
3. From the laptop: `npm run sim:bots -- --target https://<bluebonnet-rentals> --backfill 7d` once, then `npm run sim:bots -- --target https://<bluebonnet-rentals>` left running for B2. `render.yaml` sets `SPIGOT_GATE_DEMO=1` on the demo site, so this traffic is counted as SIM.
4. Claude Code on the laptop: [demo/claude-code-cli.md](demo/claude-code-cli.md) §1 with `https://<spigot-api>/mcp` and the key from step 1; `/mcp` lists 7 tools.

**C. Two dry runs before recording** (the ticket's test plan). Either run `SPIGOT_API_BASE=https://<spigot-api> DEMO_SITE_URL=https://<bluebonnet-rentals> npm run demo:dry-run -- --runs 2 --topup wallet --agent sdk --out /tmp/dry-run.md` from the `spigot-api` Shell (export the two passwords with `read -rs` as in §2; `--agent sdk` because the Shell has no Claude Code), or walk [demo/dry-run-checklist.md](demo/dry-run-checklist.md) by hand with "Stack: Render" ticked. Either way, approve the $20 wallet top-up yourself in W11, and check in the sandbox web UI that the capture and the payout ids exist (checklist 5.3, 8.3). Paste the ids into the checklist. Fix or file every failure before recording. If the runs leave the SIM buyers drained, run `sim:buyers -- --retake` (§5).

**D. Record (≤ 3:00).**

- `demo:reset` right before the take, then re-add the rotated key to Claude Code (`claude mcp remove spigot`, `claude mcp add …`).
- Order of shots: record **B6 (Claude Code) and B7 (payout) first**, while there is something to pay out; then B2–B5; B1 and B8 are slides and site footage.
- Hold the **PayPal sandbox approval page for 2 s** in B5.
- Say which numbers are simulated: bot traffic, the other buyers, and the SIM part of the payout. Use the voiceover in [demo/video-script.md](demo/video-script.md#voiceover-final) and the take's real numbers ({N} records, {$X}, the batch id), never the spec's placeholders.
- Off screen: API keys (W11 keys table, the Shell, `claude mcp add`), passwords, `.env`, W11's "Connect your agent" card, any browser tab or bookmark with a real brand. No copyrighted music.
- Write down every PayPal id shown on screen (order, capture, payout batch, payout item) and confirm each exists in the sandbox web UI after the take.

**E. Publish and submit (by 23:30 IST; hard deadline 01:30 IST Nov 13).**

1. Edit to under 3:00; upload to YouTube as **Public** (not Unlisted); check it plays logged out.
2. Replace `[[fill]]` in README.md and docs/devpost.md: the two Render URLs, the catalog URL, the video URL, screenshots. Commit through a PR as usual.
3. Paste docs/devpost.md section by section into Devpost. Put the test-account passwords (from `seed:demo` on Render, and the sandbox Personal buyer) **only** in Devpost's private testing-instructions field. Tick sponsors Render and AG Grid only.
4. Submit on Devpost, then open the public project page and check the video, the repo link and that no password is visible.
