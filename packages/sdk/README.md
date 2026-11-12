# Spigot SDK

Typed clients for Spigot's buyer `/v1` API ([`openapi.yaml`](../../openapi.yaml), also served at
`/v1/openapi.yaml`). Use these instead of hand-writing `fetch` calls: filters, `Idempotency-Key`,
the call id you need for claims and the 402 top-up link are handled for you.

| Language | Path | Package | Dependencies |
|---|---|---|---|
| TypeScript / JavaScript | [`typescript/`](typescript/) | `@spigot/sdk` | none (global `fetch`, Node 18+ or a browser) |
| Python | [`python/`](python/) | `spigot-sdk` | none (standard library, Python 3.9+) |

## TypeScript

```ts
import { SpigotClient } from '@spigot/sdk';
const { SPIGOT_KEY, SPIGOT_URL } = process.env;
const spigot = new SpigotClient({ apiKey: SPIGOT_KEY, baseUrl: SPIGOT_URL });
const filters = { 'bedrooms[gte]': 3, 'price_usd[lt]': 2000 };
const { records, charged } = await spigot.records.search('bluebonnet', 'listings', filters);
console.log(`${records.length} listings, charged $${(charged.priceMicros / 1e6).toFixed(4)}`);
```

`SPIGOT_KEY` is an `sk_spg_…` key from the buyer portal. `baseUrl` defaults to
`https://spigot.onrender.com`; set `SPIGOT_URL` to point at a local API. This is
[`typescript/examples/readme.ts`](typescript/examples/readme.ts), and CI runs it.

## Python

```python
import os
from spigot_sdk import SpigotClient
spigot = SpigotClient(api_key=os.environ.get("SPIGOT_KEY"), base_url=os.environ.get("SPIGOT_URL"))
page = spigot.records.search("bluebonnet", "listings", {"bedrooms[gte]": 3, "price_usd[lt]": 2000})
print(f"{len(page['records'])} listings, charged ${page['charged']['priceMicros'] / 1e6:.4f}")
```

This is [`python/examples/readme.py`](python/examples/readme.py). Run it from `python/` (or
`pip install ./packages/sdk/python`).

## What's covered

Every `/v1` operation in `openapi.yaml`:

| Call | TypeScript | Python | Cost |
|---|---|---|---|
| `GET /v1/catalog` | `catalog.list()` | `catalog.list()` | free |
| `GET /v1/{site}/datasets/{dataset}` | `datasets.describe(site, dataset)` | `datasets.describe(site, dataset)` | free |
| `GET …/quote` | `records.quote(site, dataset, filters, { limit })` | `records.quote(site, dataset, filters, limit=)` | free |
| `GET …/records` | `records.search(site, dataset, filters, { limit, sort, cursor, maxPriceMicros, idempotencyKey })` | `records.search(…, max_price_micros=, idempotency_key=)` | per record |
| `GET …/records/{key}` | `records.get(site, dataset, key, opts)` | `records.get(site, dataset, key, …)` | one record |
| `GET …/changes` | `changes.list(site, dataset, { since, limit, includeRecord })` | `changes.list(…, since=, include_record=)` | per change |
| `GET /v1/balance` | `balance.get()` | `balance.get()` | free |
| `POST /v1/topups` | `topups.create(amountCents, { idempotencyKey })` | `topups.create(amount_cents, idempotency_key=)` | — |
| `POST /v1/claims` | `claims.create({ callId, recordKey, reason, note })` | `claims.create(call_id, record_key, reason, note)` | — |

- **Money** is integer micros of USD (`1500` = $0.0015); top-ups are cents.
- **Filters** are `field[op]: value` (ops `eq`, `lt`, `lte`, `gt`, `gte`, `in`); `datasets.describe`
  lists which fields take which ops. An array value is sent comma-separated, for `in`: `{ 'city[in]': ['Austin', 'Waco'] }`.
- **Paid results** carry `callId` (from `Spigot-Call-Id`; pass it to `claims.create`) and `replay`
  (`true` when the API replayed a stored response for the same idempotency key and charged nothing).
- **Retries:** pass an `idempotencyKey` to make a retry safe; the same key and request are never
  charged twice.
- **Errors:** a non-2xx response throws `SpigotError` (`code`, `status`, `message`, `details`, the
  raw `body`). On a 402 (`INSUFFICIENT_BALANCE`, `PRICE_ABOVE_MAX`, `PAYMENT_REQUIRED`) `topUpUrl`
  says where to add funds.

## APIMatic

The plan (spec features/11 §Logic 10) is to generate these SDKs with APIMatic. APIMatic generation
needs an APIMatic account and uploads the spec to APIMatic's cloud, so it is a human step:

```bash
npx @apimatic/cli@2.2.0 auth login        # or export APIMATIC_API_KEY=…
bash packages/sdk/apimatic/generate.sh    # → packages/sdk/{typescript,python}/apimatic/
```

Until that runs, the clients above are hand-written against `openapi.yaml`, with the same surface
as the spec's README example. They stay the stable surface either way. Commit the generated output
next to them.

## Tests

- `apps/api/src/sdk/sdk-readme.test.ts` (unit, runs in CI) runs both README examples, unchanged, as
  separate processes against a local stub server whose responses are checked against the API's own
  Zod response schemas. It also checks that the README blocks match the example files.
- `apps/api/src/sdk/sdk-smoke.db.test.ts` (db project) runs the TypeScript example and the client's
  idempotency, claim and 402 paths against the real API (`buildServer` on a local port, Postgres).
