# Fixtures (`VITE_FIXTURES=1`)

With `VITE_FIXTURES=1`, `api.get(path)` in `src/api/client.ts` answers from a JSON file here when
one matches, ignoring the query string. Otherwise the request goes to the API.

| Request                                    | Files tried, in order                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `GET /api/publishers/me/earnings?range=7d` | `api/publishers/me/earnings.json`                                                 |
| `GET /api/sites/s1/bots`                   | `api/sites/s1/bots.json`, then `api/sites/_/bots.json`, … (`_` = any one segment) |

Rules:

- **Each screen ticket owns the fixtures for its own endpoints**: add files, don't edit anyone else's.
- Shapes follow `docs/spec/api.md`. Money is in micros/cents, as the API sends it.
- Only `GET` is served. Mutations always go to the network; SSE is off (`useEventStream` reports
  `disabled`).
- A normal build (`VITE_FIXTURES` unset) ships none of these files.
