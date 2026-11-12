# Bluebonnet Rentals (demo site)

A fictional rentals site that Spigot crawls in the demo. **Not a real business.** Express + EJS,
server-rendered, no client JS. Its data lives here (JSON in `DEMO_DATA_DIR`), never in Spigot's Postgres.

```sh
npm run dev -w @spigot/demo-site            # http://localhost:4100
npm test -w @spigot/demo-site               # vitest, --maxWorkers=2
npm run seed -w @spigot/demo-site           # write data/bluebonnet.json and print counts
npm run demo:mutate -w @spigot/demo-site -- --prices 30 --leased 5 --new 3 --seed 42 \
  --focus "bedrooms>=3,price_usd<2000,city=Austin" --target http://localhost:4100
```

| Env | Default | |
|---|---|---|
| `PORT` | `4100` | |
| `DEMO_SEED_SCALE` | `1` | Scales counts: 1 → 2,341 listings / 88 agents / 40 open houses; 0.05 → 117 / 4 / 2 |
| `DEMO_DATA_DIR` | `apps/demo-site/data` | Seed snapshot and the mutation log (`mutations.jsonl`). A Render disk in prod |
| `DEMO_ADMIN_TOKEN` | unset | Bearer token for `/admin/*`; every `/admin` path is a 404 when unset |
| `SPIGOT_VERIFY_TOKEN` | unset | Served at `/.well-known/spigot.txt`; 404 when unset |
| `SPIGOT_API_BASE` | unset | Spigot API origin for spigot-gate (policy + hit counts) |
| `SPIGOT_GATE_KEY` | unset | Site gate key `gk_…` from W03. Gate is off until this and `SPIGOT_API_BASE` are set |
| `SPIGOT_GATE_DEMO` | unset | `1`: requests with `X-Spigot-Sim: 1` (sim:bots) count as simulated |

## Pages

| Path | Record type | Structure |
|---|---|---|
| `/`, `/search?beds=&max_rent=&neighbourhood=&page=` | – | HTML only, not gated |
| `/listings/:slug` | Listing | JSON-LD `["Apartment","Product"]` with `offers` (`Offer`: `price`, `priceCurrency`, `availability` = `InStock` / `SoldOut`), `numberOfRooms`, `floorSize`, `address`. HTML-only: `dl.facts dd[data-k=available]` (YYYY-MM-DD), `dd[data-k=pets]`. `.status-badge` "Available"/"Leased", `.agent-card .agent-phone` |
| `/agents/:slug` | Agent | No JSON-LD. `.agent-name`, `.agent-phone`, `.agent-email`, `dl.facts dd[data-k=…]` |
| `/open-houses/:id` | Open House | No JSON-LD. `time.oh-start[datetime]`, `time.oh-end[datetime]` (America/Chicago offset) |
| `/about`, `/blog`, `/blog/:slug` (10) | – | Unstructured |
| `/sitemap.xml`, `/robots.txt`, `/.well-known/spigot.txt`, `/healthz` | – | |

`@type` is multi-typed because schema.org defines `offers` on Product, not on Apartment; read it as `string | string[]`.

Every response has a strong ETag (hash of the body) and answers `If-None-Match` with `304`. Every request
logs one JSON line (`method`, `path`, `status`, `ua`, `inflight`, `ms`); `app.locals.accessLog.stats()`
exposes `maxInFlight` for the crawler's "≤ 2 concurrent" check. `createApp({ gate })` mounts spigot-gate
after the access log and before every route; `server.ts` builds it from the env above (SP-006b). It fails
open: with Spigot down, slow or unconfigured, every request passes. `npm run dev` / `start` need
`@spigot/gate` built (`npm run build -w @spigot/gate`).

The demo query population ("3-bed under $2k in Austin") is every 32nd listing: 74 at scale 1.

## Demo mutations (SP-004b)

A **demo mutation** changes a known set of listings so the next crawl emits exactly those changes
(the "changed today" beat). State = the deterministic seed + an append-only mutation log,
`DEMO_DATA_DIR/mutations.jsonl`, which the site replays on boot, so a restart or redeploy keeps
mutations. The log stores outcomes (slugs, old and new rents, whole new listings), not options.

`demo:mutate --prices N --leased N --new N [--seed S] [--focus F] [--target URL] [--ping] [--json]`

- `--prices N`: N available listings get rent ±3–8% (rounded to $5). `--leased N`: N other available
  listings become leased. `--new N`: N new listings. The three sets are disjoint; the same data and
  seed pick the same slugs (no `--seed` → a random one, printed).
- `--focus "bedrooms>=3,price_usd<2000,city=Austin"`: price changes are drawn from, and stay inside,
  the filter; new listings match it. Clauses are ANDed; fields `price_usd`, `bedrooms`, `bathrooms`,
  `sqft` (`>= <= > < = !=`) and `city`, `neighbourhood`, `postal_code`, `pets_allowed`, `status` (`= !=`).
- Only touched pages get a new `updated_at` / sitemap `lastmod` (and so a new ETag): each changed
  listing, its agent's page (active listing cards and counts) and, for rent changes, its open houses.
  `/`, `/about` and `/blog` lastmods are derived from the newest record, as before.
- `--target URL` calls `POST URL/admin/mutate` with `DEMO_ADMIN_TOKEN` (env or the repo `.env`); use it
  whenever the site is running, locally or on Render. Without it the CLI appends to the log in
  `DEMO_DATA_DIR` directly, and a running site only sees it after a restart.
- `--ping` is accepted and does nothing until SP-055.

Admin endpoints (`Authorization: Bearer $DEMO_ADMIN_TOKEN`; 401 with a missing or wrong token, 404 when
the token is unset). They're mounted before spigot-gate, and robots.txt disallows `/admin`.

| Endpoint | |
|---|---|
| `POST /admin/mutate` | JSON body `{ prices, leased, new, seed?, focus?, ping? }` → the slugs changed, `at`, and every touched path. 400 on bad options |
| `POST /admin/reset` | Rebuild from the seed, drop added listings, replace the log with one reset entry. Pages the reset reverted get `lastmod = now` (always newer than before), so the next crawl re-fetches them and Spigot's records revert too |
| `GET /admin/state` | Scale, current and seed counts, the log, mutation count, last reset time |

Writes are serialized; each entry is fsynced to the log before it is applied. A torn last line (crash
mid-append) is dropped on boot; a log from another `DEMO_SEED_SCALE` refuses to boot (reset or delete it).
