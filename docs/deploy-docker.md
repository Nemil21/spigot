# Self-hosted deploy (Docker Compose + nginx)

An alternative to the Render Blueprint ([deploy.md](deploy.md)) for one Linux server that already
runs nginx. Three containers from [`docker-compose.yml`](../docker-compose.yml): `db` (Postgres
16), `api` (dashboard, buyer portal, `/v1`, `/mcp`, catalog page; migrates on start) and
`demo-site` (Bluebonnet Rentals with spigot-gate). Both app ports bind to `127.0.0.1` only; the
host nginx ([`deploy/nginx/spigot.conf`](../deploy/nginx/spigot.conf)) terminates TLS.
`WORKFLOWS_MODE=inproc`: crawls and payouts run inside the API container.

## 1. DNS

Two A records to the server's IP, e.g. `spigot.<domain>` (API) and `bluebonnet.<domain>` (demo
site). On Cloudflare use **DNS only**: its proxy cuts SSE / MCP connections after ~100 s.

## 2. Env files (next to `docker-compose.yml`, git-ignored)

`.env`: the keys from [deploy.md §Environment variables](deploy.md#environment-variables)
(`spigot-config` + `spigot-api`), plus:

| Key | Value |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` (compose builds `DATABASE_URL` from it) |
| `APP_BASE_URL` | `https://spigot.<domain>` |
| `DEMO_SITE_URL` | `https://bluebonnet.<domain>` |
| `NODE_ENV` | `production` |
| `VITE_AG_GRID_LICENSE_KEY`, `VITE_PAYPAL_CLIENT_ID` | Build args for the web bundle; rebuild after changing them |

`.env.demo-site`: `NODE_ENV=production`, `DEMO_SEED_SCALE=1`, `SPIGOT_GATE_DEMO=1`,
`DEMO_ADMIN_TOKEN` (same as in `.env`), `SPIGOT_API_BASE=https://spigot.<domain>`,
`SPIGOT_VERIFY_TOKEN` (same as in `.env`), `SPIGOT_GATE_KEY` (empty until step 5).

The demo site runs with **25 listings** (+ 1 agent, 1 open house) by default, so a live crawl and Claude's
proposal (one record type, Listing · 25) finish in seconds. Don't go below 20: URL clustering needs at least
20 distinct `/listings/<slug>` pages to find a record type, so 10 listings gives no proposal. For the full 2,341 / 88 / 40 set `DEMO_LISTINGS=2341` in `.env`, then
`docker compose up -d demo-site`.

## 3. Start

```sh
docker compose up -d --build
docker compose ps                       # db healthy, api and demo-site up
curl -s http://127.0.0.1:3000/api/healthz
curl -s http://127.0.0.1:4100/healthz
```

Ports clash with something else on the host? Set `API_PORT` / `DEMO_SITE_PORT` in `.env` and the
same ports in the nginx file.

## 4. nginx + TLS

Copy `deploy/nginx/spigot.conf`, replace the two `server_name`s, enable it, `sudo nginx -t`, reload,
then `sudo certbot --nginx -d spigot.<domain> -d bluebonnet.<domain>`. The API location keeps
`proxy_buffering off` and a 1 h read timeout for SSE and MCP.

## 5. Seed and connect the gate

```sh
docker compose exec api npm run seed:demo        # prints passwords and keys: keep it private
```

Put the printed gate key in `.env.demo-site` (`SPIGOT_GATE_KEY`), then
`docker compose up -d demo-site`. Then the smoke check from the repo root:
`node scripts/smoke-deploy.mjs https://spigot.<domain> --site https://bluebonnet.<domain>`.

Every demo CLI runs the same way: `docker compose exec api npm run demo:reset -- --yes`,
`docker compose exec api npm run sim:buyers -- --live`, …

## Update

```sh
git pull && docker compose up -d --build
```
