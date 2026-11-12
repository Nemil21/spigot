import { commissionSplit, formatCount, formatMicros } from '@spigot/shared/money';

/**
 * W06 dataset editor model (SP-029; screens.md §W06, features/13 §3, features/06 §Pricing,
 * features/04 §6). Pure helpers, so the screen and its tests share one definition of the price
 * math, the edit diff sent to `PATCH /api/datasets/:id` and the endpoint preview.
 */

export type DatasetStatus = 'PROPOSED' | 'LIVE' | 'LIVE_STALE' | 'UNPUBLISHED' | 'REJECTED';

export type FieldType =
  'string' | 'url' | 'integer' | 'number' | 'date' | 'datetime' | 'boolean' | 'string[]';

export type FieldValue = string | number | boolean | string[] | null;
export type SampleRow = Record<string, FieldValue | undefined>;

/** One field as `GET /api/datasets/:id` sends it (SP-014b `fieldView`). */
export interface DatasetField {
  name: string;
  type: string;
  description: string | null;
  visible: boolean;
  pii: boolean;
  rightsFlag: boolean;
  filterable: string[];
  nullRate: number | null;
  example: FieldValue;
}

/** `GET /api/datasets/:id` (api.md; SP-014b). */
export interface DatasetDetail {
  id: string;
  siteSlug: string | null;
  slug: string;
  typeName: string;
  status: DatasetStatus;
  staleSince: string | null;
  /** SP-052b: newest records `crawled_at` (LIVE_STALE only): "Last good extract 6 h ago". */
  lastGoodExtractAt?: string | null;
  /** SP-052b: where re-inference stands (LIVE_STALE only). */
  reinference?: Reinference | null;
  activeSchemaVersion: { id: string; version: number } | null;
  latestSchemaVersion: {
    id: string;
    version: number;
    status: string;
    proposedBy: string | null;
  } | null;
  fields: DatasetField[];
  prices: { perRecordMicros: number; perChangeMicros: number };
  recordCount: number;
  endpoint: string | null;
  sampleRows: SampleRow[];
}

/** One field of the diff of sources: the live extractor vs the re-proposal (SP-052b). */
export interface SourceDiffRow {
  name: string;
  before: string;
  /** null: the self-check dropped the field (it no longer extracts). */
  after: string | null;
  changed: boolean;
}

/** `GET /api/datasets/:id` `reinference` (SP-052b `reinferenceView`). */
export interface Reinference {
  state: 'QUEUED' | 'RUNNING' | 'PROPOSED' | 'FAILED';
  schemaVersionId: string | null;
  version: number | null;
  reason: string | null;
  sources: SourceDiffRow[];
}

/** `POST /api/datasets/:id/reinfer` (202). */
export type ReinferResult =
  { status: 'REINFERRING' } | { status: 'PROPOSED'; schemaVersionId: string; version: number };

/** `PATCH /api/datasets/:id` body (SP-014a `patchBody`). */
export interface PatchBody {
  fields?: { name: string; visible?: boolean; filterable?: boolean }[];
  perRecordMicros?: number;
  perChangeMicros?: number;
}

export interface PatchResult {
  dataset: {
    id: string;
    slug: string;
    status: DatasetStatus;
    perRecordMicros: number;
    perChangeMicros: number;
  };
  schemaVersion: { id: string; version: number; status: string; proposedBy: string | null } | null;
}

/** `POST /api/datasets/:id/approve` (SP-014a). */
export interface ApproveResult {
  status: 'LIVE';
  endpoint: string;
  crawlRunId: string;
}

/** A row of `GET /api/sites/:id/crawl-runs` (SP-009b `RUN_VIEW_COLUMNS`). */
export interface CrawlRun {
  id: string;
  trigger: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | string;
  pagesTotal: number | null;
  pagesFetched: number | null;
  error: string | null;
}

// --- prices ------------------------------------------------------------------------------------

/** Bounds per record (features/06 §Pricing; SP-014a `PRICE_MIN_MICROS` / `PRICE_MAX_MICROS`). */
export const PRICE_MIN_MICROS = 100;
export const PRICE_MAX_MICROS = 100_000;

/**
 * Spigot's commission (data-model.md `publishers.commission_bps` default 2000 = 20%). The session
 * API doesn't expose a publisher's own rate yet, so W06 shows the default, like the spec copy.
 */
export const DEFAULT_COMMISSION_BPS = 2000;

/**
 * "1.50" (dollars per 1,000) → 1,500 micros per unit. Parsed from the digits, never through a
 * float: $X per 1,000 is X × 1,000 micros per unit, so three decimals are exact to the micro.
 * Returns null for anything that isn't a plain amount with at most three decimals.
 */
export function per1000InputToMicros(input: string): number | null {
  const m = /^\s*\$?\s*(\d{1,6})?(?:\.(\d{0,3}))?\s*$/.exec(input);
  if (!m || (m[1] === undefined && !m[2])) return null;
  const whole = Number(m[1] ?? '0');
  const frac = Number((m[2] ?? '').padEnd(3, '0'));
  return whole * 1000 + frac;
}

/** 1,500 micros per unit → "1.50" (the input's text; at least two decimals, up to three). */
export function microsToPer1000Input(perUnitMicros: number): string {
  return formatMicros(perUnitMicros * 1000)
    .replace(/^\$/, '')
    .replace(/,/g, '');
}

/** Why a per-unit price can't be saved, or null. */
export function priceError(perUnitMicros: number | null): string | null {
  if (perUnitMicros === null) return 'Enter a price like 1.50.';
  if (perUnitMicros < PRICE_MIN_MICROS || perUnitMicros > PRICE_MAX_MICROS) {
    return 'Between $0.10 and $100 per 1,000.';
  }
  return null;
}

/** "listings" from the slug "listings"; "open houses" from "open-houses". */
export function recordNoun(slug: string): string {
  return slug.replace(/-/g, ' ');
}

export interface BuyerLine {
  totalMicros: number;
  commissionMicros: number;
  publisherMicros: number;
  text: string;
}

/**
 * "A buyer pulling all 2,341 listings pays $3.5115; you get $2.8092 after Spigot's 20%"
 * (screens.md §W06). The split is `commissionSplit` from `@spigot/shared` (the ledger's own math:
 * commission floored, the odd micro to the publisher), and amounts use `formatMicros`, which never
 * rounds a charge away.
 */
export function buyerLine(
  recordCount: number,
  perRecordMicros: number,
  noun: string,
  bps = DEFAULT_COMMISSION_BPS,
): BuyerLine {
  const totalMicros = recordCount * perRecordMicros;
  const { commission, publisher } = commissionSplit(totalMicros, bps);
  const pct = `${bps / 100}%`;
  return {
    totalMicros,
    commissionMicros: commission,
    publisherMicros: publisher,
    text: `A buyer pulling all ${formatCount(recordCount)} ${noun} pays ${formatMicros(totalMicros)}; you get ${formatMicros(publisher)} after Spigot's ${pct}`,
  };
}

// --- fields ------------------------------------------------------------------------------------

/** Filter ops per type (mirrors the API's `records/fields.ts` `OPS_BY_TYPE`). */
export const OPS_BY_TYPE: Record<string, readonly string[]> = {
  string: ['eq', 'in'],
  url: ['eq', 'in'],
  integer: ['eq', 'lt', 'lte', 'gt', 'gte'],
  number: ['eq', 'lt', 'lte', 'gt', 'gte'],
  date: ['eq', 'lt', 'lte', 'gt', 'gte'],
  datetime: ['eq', 'lt', 'lte', 'gt', 'gte'],
  boolean: ['eq'],
  'string[]': [],
};

export function canFilter(type: string): boolean {
  return (OPS_BY_TYPE[type]?.length ?? 0) > 0;
}

/** Owner edits to a field, in the editor's state. */
export interface FieldEdit {
  visible: boolean;
  filterable: boolean;
}

export type FieldEdits = Record<string, FieldEdit>;

export function editsOf(fields: readonly DatasetField[]): FieldEdits {
  return Object.fromEntries(
    fields.map((f) => [
      f.name,
      { visible: f.visible, filterable: f.visible && f.filterable.length > 0 },
    ]),
  );
}

/** Toggle a field's visibility; hiding it clears its filter (the API does the same). */
export function toggleVisible(edits: FieldEdits, name: string): FieldEdits {
  const cur = edits[name];
  if (!cur) return edits;
  const visible = !cur.visible;
  return { ...edits, [name]: { visible, filterable: visible ? cur.filterable : false } };
}

export function toggleFilterable(edits: FieldEdits, name: string): FieldEdits {
  const cur = edits[name];
  if (!cur || !cur.visible) return edits;
  return { ...edits, [name]: { ...cur, filterable: !cur.filterable } };
}

/** The fields with the owner's edits applied (what the grid and the preview show). */
export function applyEdits(fields: readonly DatasetField[], edits: FieldEdits): DatasetField[] {
  return fields.map((f) => {
    const e = edits[f.name];
    if (!e) return f;
    const filterable = !e.filterable
      ? []
      : f.filterable.length > 0
        ? f.filterable
        : [...(OPS_BY_TYPE[f.type] ?? [])];
    return { ...f, visible: e.visible, filterable };
  });
}

/** Only the fields whose visibility or filter changed since `base`, for the PATCH body. */
export function fieldChanges(
  base: FieldEdits,
  edits: FieldEdits,
): NonNullable<PatchBody['fields']> {
  const out: NonNullable<PatchBody['fields']> = [];
  for (const [name, e] of Object.entries(edits)) {
    const b = base[name];
    if (!b) continue;
    const change: { name: string; visible?: boolean; filterable?: boolean } = { name };
    if (b.visible !== e.visible) change.visible = e.visible;
    // Hiding clears the filter server-side; only send `filterable` for a visible field.
    if (e.visible && b.filterable !== e.filterable) change.filterable = e.filterable;
    if (change.visible !== undefined || change.filterable !== undefined) out.push(change);
  }
  return out;
}

const WIRE_SERVICES: readonly [RegExp, string][] = [
  [/\bAP\b|Associated Press/, 'AP'],
  [/\bReuters\b/i, 'Reuters'],
  [/\bAFP\b|Agence France-Presse/, 'AFP'],
  [/\bBloomberg\b/i, 'Bloomberg'],
  [/Getty Images/i, 'Getty Images'],
];

/** "Byline 'AP' found: excluded by default" (screens.md §W06) for a rights-flagged field. */
export function rightsFlagText(field: Pick<DatasetField, 'example'>): string {
  const text = Array.isArray(field.example)
    ? field.example.join(' ')
    : typeof field.example === 'string'
      ? field.example
      : '';
  const hit = WIRE_SERVICES.find(([re]) => re.test(text));
  return hit
    ? `Byline '${hit[1]}' found: excluded by default`
    : 'Wire-service byline found: excluded by default';
}

// --- endpoint preview --------------------------------------------------------------------------

const RANGE_TYPES = new Set(['integer', 'number', 'date', 'datetime']);

/**
 * The preview's example filter: the first visible, filterable numeric/date field with `gte`
 * (`bedrooms[gte]=3`), else the first `eq` field, using the field's example value.
 */
export function exampleFilter(fields: readonly DatasetField[]): string | null {
  const usable = fields.filter(
    (f) => f.visible && f.filterable.length > 0 && f.example !== null && !Array.isArray(f.example),
  );
  const range = usable.find((f) => RANGE_TYPES.has(f.type) && f.filterable.includes('gte'));
  if (range)
    return `${encodeURIComponent(range.name)}[gte]=${encodeURIComponent(String(range.example))}`;
  const eq = usable.find((f) => f.filterable.includes('eq'));
  if (eq) return `${encodeURIComponent(eq.name)}=${encodeURIComponent(String(eq.example))}`;
  return null;
}

/** `/v1/bluebonnet/datasets/listings/records` from the API's absolute endpoint (or the slugs). */
export function endpointPath(
  detail: Pick<DatasetDetail, 'endpoint' | 'siteSlug' | 'slug'>,
): string {
  if (detail.endpoint) {
    try {
      return new URL(detail.endpoint).pathname;
    } catch {
      // fall through to the slugs
    }
  }
  return `/v1/${detail.siteSlug ?? ':site'}/datasets/${detail.slug}/records`;
}

/** A row reduced to the visible fields, in schema order (what a buyer receives). */
export function visibleData(fields: readonly DatasetField[], row: SampleRow): SampleRow {
  const out: SampleRow = {};
  for (const f of fields) if (f.visible && row[f.name] !== undefined) out[f.name] = row[f.name];
  return out;
}

/** Sample JSON of the records endpoint (api.md §records), visible fields only. */
export function sampleResponse(
  fields: readonly DatasetField[],
  rows: readonly SampleRow[],
  perRecordMicros: number,
  n = 2,
): string {
  const records = rows.slice(0, n).map((r) => ({ data: visibleData(fields, r) }));
  return JSON.stringify(
    {
      records,
      charged: { records: records.length, priceMicros: records.length * perRecordMicros },
    },
    null,
    2,
  );
}

// --- validation --------------------------------------------------------------------------------

export const NO_VISIBLE_FIELDS = 'Pick at least one field to sell';
export const RIGHTS_NOT_TICKED = 'Confirm you own or may license these fields.';

/** Statuses where fields can change and Publish (approve) applies (SP-014a). */
export const PUBLISHABLE: readonly DatasetStatus[] = ['PROPOSED', 'LIVE_STALE'];
/** Statuses whose prices can be edited (SP-014a `EDITABLE_STATUSES`). */
export const PRICE_EDITABLE: readonly DatasetStatus[] = ['PROPOSED', 'LIVE', 'LIVE_STALE'];
