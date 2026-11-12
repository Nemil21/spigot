// Fixture snapshot sets for SP-013's *.db.test.ts: listing pages shaped like the demo site's
// (JSON-LD Apartment + Offer, a status badge), inserted straight into pages / snapshots.
import { gzipSync } from 'node:zlib';
import type pg from 'pg';
import type { ExtractorSpecInput } from '@spigot/shared';

export const ORIGIN = 'https://bluebonnet.test';

export interface Listing {
  slug: string;
  price: number;
  beds: number;
  city: string;
  status: 'Available' | 'Leased';
}

export const LISTING_SPEC: ExtractorSpecInput = {
  recordKey: { from: 'url' },
  fields: [
    {
      name: 'price_usd',
      type: 'integer',
      required: true,
      source: { jsonld: '$.offers.price' },
      transforms: ['toInt'],
    },
    { name: 'bedrooms', type: 'integer', source: { jsonld: '$.numberOfRooms' } },
    { name: 'city', type: 'string', source: { jsonld: '$.address.addressLocality' } },
    { name: 'status', type: 'string', source: { css: '.status-badge', attr: 'text' } },
  ],
};

const CITIES = ['Austin', 'Round Rock', 'Pflugerville', 'Cedar Park'];

export function listings(n: number, from = 0): Listing[] {
  return Array.from({ length: n }, (_, i) => {
    const k = from + i;
    return {
      slug: `${(k % 4) + 1}br-unit-${String(k).padStart(5, '0')}`,
      price: 1200 + ((k * 37) % 1800),
      beds: (k % 4) + 1,
      city: CITIES[k % CITIES.length]!,
      status: 'Available',
    };
  });
}

export const urlOf = (l: Listing) => `${ORIGIN}/listings/${l.slug}`;

/** `crawlNonce` changes bytes outside the extracted fields (like a CSRF token or ad slot). */
export function listingHtml(l: Listing, crawlNonce = ''): string {
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': ['Apartment', 'Offer'],
    '@id': urlOf(l),
    name: `${l.beds}BR in ${l.city}`,
    numberOfRooms: l.beds,
    address: { '@type': 'PostalAddress', addressLocality: l.city, addressRegion: 'TX' },
    offers: { '@type': 'Offer', price: String(l.price), priceCurrency: 'USD' },
  };
  return `<!doctype html><html><head><title>${l.slug}</title>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script></head>
<body><main class="listing"><h1>${l.beds}BR in ${l.city}</h1>
<span class="status-badge">${l.status}</span>
<p class="listing-price"><span class="price">$${l.price.toLocaleString('en-US')}</span> / month</p>
<!-- ${crawlNonce} --></main></body></html>`;
}

export interface SeededDataset {
  siteId: string;
  templateId: string;
  datasetId: string;
  schemaId: string;
}

/** Publisher → site → template → LIVE dataset with an APPROVED `LISTING_SPEC` schema. */
export async function seedDataset(pool: pg.Pool, tag = 'a'): Promise<SeededDataset> {
  const q = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  const publisherId = await q(
    `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
    [`p-${tag}-${Math.random()}@x.test`],
  );
  const siteId = await q(
    `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
     VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
    [publisherId, `${ORIGIN}/${tag}`],
  );
  const templateId = await q(
    `INSERT INTO templates (site_id, url_pattern) VALUES ($1, '^/listings/[a-z0-9-]+$') RETURNING id`,
    [siteId],
  );
  const datasetId = await q(
    `INSERT INTO datasets (site_id, template_id, slug, type_name, status) VALUES ($1, $2, 'listings', 'Listing', 'LIVE')
     RETURNING id`,
    [siteId, templateId],
  );
  const { recordKey, ...extractor } = LISTING_SPEC;
  const schemaId = await q(
    `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
     VALUES ($1, 1, 'APPROVED', $2, $3, $4, 'AI') RETURNING id`,
    [
      datasetId,
      JSON.stringify(
        LISTING_SPEC.fields.map((f) => ({ name: f.name, type: f.type, visible: true })),
      ),
      JSON.stringify(extractor),
      JSON.stringify(recordKey),
    ],
  );
  await pool.query('UPDATE datasets SET active_schema_id = $2 WHERE id = $1', [
    datasetId,
    schemaId,
  ]);
  return { siteId, templateId, datasetId, schemaId };
}

/** Upsert pages for these listings; returns page ids by slug. */
export async function upsertListingPages(
  pool: pg.Pool,
  ds: SeededDataset,
  ls: readonly Listing[],
): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ id: string; url: string }>(
    `INSERT INTO pages (site_id, url, template_id)
     SELECT $1, u, $2 FROM unnest($3::text[]) AS u
     ON CONFLICT (site_id, url) DO UPDATE SET template_id = EXCLUDED.template_id
     RETURNING id, url`,
    [ds.siteId, ds.templateId, ls.map(urlOf)],
  );
  const byUrl = new Map(rows.map((r) => [r.url, r.id]));
  return new Map(ls.map((l) => [l.slug, byUrl.get(urlOf(l))!]));
}

/** One 200 snapshot per listing, all with `fetchedAt` (a crawl). */
export async function insertSnapshots(
  pool: pg.Pool,
  pageIds: Map<string, string>,
  ls: readonly Listing[],
  fetchedAt: Date,
  crawlNonce = fetchedAt.toISOString(),
): Promise<void> {
  for (let i = 0; i < ls.length; i += 500) {
    const chunk = ls.slice(i, i + 500);
    await pool.query(
      `INSERT INTO snapshots (page_id, fetched_at, http_status, html_gz)
       SELECT p, $2, 200, h FROM unnest($1::uuid[], $3::bytea[]) AS t(p, h)`,
      [
        chunk.map((l) => pageIds.get(l.slug)!),
        fetchedAt,
        chunk.map((l) => gzipSync(listingHtml(l, crawlNonce))),
      ],
    );
  }
}

/** A RUNNING crawl run; a non-APPROVE one first finishes the site's live crawl (rule 9). */
export async function newRun(pool: pg.Pool, siteId: string, trigger: string): Promise<string> {
  if (trigger !== 'APPROVE') {
    await pool.query(
      `UPDATE crawl_runs SET status = 'SUCCEEDED', finished_at = now()
        WHERE site_id = $1 AND status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE' AND trigger <> 'CLAIM'`,
      [siteId],
    );
  }
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO crawl_runs (site_id, trigger, status, started_at) VALUES ($1, $2, 'RUNNING', now()) RETURNING id`,
      [siteId, trigger],
    )
  ).rows[0]!.id;
}

export async function versions(pool: pg.Pool, datasetId: string, runId?: string) {
  return (
    await pool.query<{
      seq: number;
      op: string;
      patch: unknown;
      record_key: string;
      version: number;
      crawl_run_id: string | null;
    }>(
      `SELECT rv.seq, rv.op, rv.patch, r.record_key, rv.version, rv.crawl_run_id
         FROM record_versions rv JOIN records r ON r.id = rv.record_id
        WHERE rv.dataset_id = $1 AND ($2::uuid IS NULL OR rv.crawl_run_id = $2)
        ORDER BY rv.seq`,
      [datasetId, runId ?? null],
    )
  ).rows;
}

/**
 * A changes-feed reader like SP-015's: polls `seq > cursor AND seq <= published_seq` in one
 * statement and advances its cursor. `stop()` drains once more and returns every seq it saw.
 */
export function startFeedReader(pool: pg.Pool, datasetId: string) {
  const seen: number[] = [];
  let cursor = 0;
  let stopping = false;
  const poll = async () => {
    const { rows } = await pool.query<{ seq: number }>(
      `SELECT rv.seq FROM record_versions rv JOIN datasets d ON d.id = rv.dataset_id
        WHERE rv.dataset_id = $1 AND rv.seq > $2 AND rv.seq <= d.published_seq
        ORDER BY rv.seq LIMIT 1000`,
      [datasetId, cursor],
    );
    for (const r of rows) seen.push(r.seq);
    if (rows.length) cursor = rows[rows.length - 1]!.seq;
    return rows.length;
  };
  const loop = (async () => {
    while (!stopping) {
      await poll();
      await new Promise((r) => setTimeout(r, 2));
    }
    while ((await poll()) > 0);
  })();
  return {
    seen,
    async stop(): Promise<number[]> {
      stopping = true;
      await loop;
      return seen;
    },
  };
}
