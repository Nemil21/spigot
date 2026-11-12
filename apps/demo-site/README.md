# Bluebonnet Rentals (demo site)

A fictional rentals site that Spigot crawls in the demo. **Not a real business.** Express + EJS,
server-rendered, no client JS. Its data lives here (JSON in `DEMO_DATA_DIR`), never in Spigot's Postgres.

```sh
npm run dev -w @spigot/demo-site            # http://localhost:4100
npm test -w @spigot/demo-site               # vitest, --maxWorkers=2
npm run seed -w @spigot/demo-site           # write data/bluebonnet.json and print counts
```

| Env | Default | |
|---|---|---|
| `PORT` | `4100` | |
| `DEMO_SEED_SCALE` | `1` | Scales counts: 1 → 2,341 listings / 88 agents / 40 open houses; 0.05 → 117 / 4 / 2 |
| `DEMO_DATA_DIR` | `apps/demo-site/data` | Seed snapshot (and, from SP-004b, the mutation log). A Render disk in prod |
| `SPIGOT_VERIFY_TOKEN` | unset | Served at `/.well-known/spigot.txt`; 404 when unset |

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
after the access log and before every route (a no-op until SP-006b).

The demo query population ("3-bed under $2k in Austin") is every 32nd listing: 74 at scale 1.
