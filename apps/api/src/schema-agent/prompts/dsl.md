# Extractor DSL (reference)

Each field is `{ name, type, required?, source, transforms?, description?, filterable?, pii?, rights_flag? }`.

## `source`

- `{ "jsonld": "<path>" }`: evaluated over every `<script type="application/ld+json">` block on the page (arrays and `@graph` items included); the first match wins. Paths use only `.name`, `['name']` and `[0]` segments, starting at `$`: `$.offers.price`, `$.address.addressLocality`, `$['@id']`. No `..`, wildcards, filters or slices.
- `{ "css": "<selector>", "attr": "text" | "<attribute>", "all"?: true }`: cheerio CSS selector over the page HTML. `attr: "text"` (the default) takes the whitespace-collapsed text content; any other value reads that attribute (`href`, `datetime`, `content`). `all: true` returns every match as a list (use with type `string[]`); otherwise the first match is used.

## `transforms` (applied in order; anything else is rejected)

| Transform | Effect |
|---|---|
| `trim` | Strip surrounding whitespace |
| `lower` | Lower-case |
| `toInt` | Parse an integer (`"3"` → 3) |
| `toFloat` | Parse a number (`"2.5"` → 2.5) |
| `firstInt` | First integer in the text (`"820 sq ft"` → 820, `"12 years"` → 12) |
| `money` | Strip `$` and `,` then parse a number (`"$1,875"` → 1875) |
| `date` | Parse to `YYYY-MM-DD` |
| `datetime` | Parse to an ISO 8601 timestamp |
| `absoluteUrl` | Resolve a relative URL against the page URL |
| `split:<sep>` | Split text into a list on `<sep>` (1–10 chars), items trimmed (`split:,`) |
| `bool:<word>` | `true` when the value contains `<word>` as a whole word (case-insensitive), else `false` (`bool:Yes`) |
| `regex:<pattern>` | First capture group of a safe regex, ≤ 100 chars (`regex:Licence (\S+)`) |

## `type`

`string`, `integer`, `number`, `boolean`, `date`, `datetime`, `url`, `string[]`. Each value is coerced to the type after the transforms; a value that can't be coerced becomes `null`.

## `recordKey`

`{ "from": "url" }` (last URL path segment) or `{ "jsonld": "<path>" }`.

## Example (a rental listing template)

```json
{ "typeName": "Listing", "recordKey": { "from": "url" },
  "fields": [
    { "name": "price_usd", "type": "integer", "description": "Monthly rent in USD", "required": true,
      "source": { "jsonld": "$.offers.price" }, "transforms": ["toInt"], "filterable": ["eq","lt","lte","gt","gte"] },
    { "name": "bedrooms", "type": "integer", "source": { "jsonld": "$.numberOfRooms" }, "transforms": ["toInt"], "filterable": ["eq","gte","lte"] },
    { "name": "available_from", "type": "date", "source": { "css": "dl.facts dd[data-k=available]", "attr": "text" }, "transforms": ["trim","date"] },
    { "name": "agent_phone", "type": "string", "source": { "css": ".agent-card .phone", "attr": "text" }, "pii": true }
  ],
  "rationale": "Listing pages carry schema.org Apartment JSON-LD with price and rooms; availability and pets are only in the facts list." }
```
