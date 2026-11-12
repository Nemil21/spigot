/**
 * Response and request types of the Spigot `/v1` API, transcribed from `openapi.yaml`
 * (`components.schemas`). Money is integer **micros** of USD (`1500` = $0.0015); top-up amounts are
 * **cents**. Keep in step with `openapi.yaml` (the smoke tests parse stub and live responses with
 * the API's own Zod schemas, so drift shows up there).
 */

export type FilterOp = 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in';

/**
 * `field[op]: value`, e.g. `{ 'bedrooms[gte]': 3, 'price_usd[lt]': 2000, city: 'Austin' }`. A bare
 * field means `eq`; `field[in]` takes a comma-separated string or an array (max 50).
 */
export type Filters = Record<string, string | number | boolean | readonly (string | number)[]>;

export interface Freshness {
  lastCrawlAt: string | null;
  staleSince: string | null;
}

export interface Catalog {
  sites: {
    slug: string;
    name: string;
    datasets: {
      slug: string;
      type: string;
      records: number;
      perRecordMicros: number;
      perChangeMicros: number;
      freshness: Freshness;
    }[];
  }[];
}

export interface DatasetDescription {
  type: string;
  version: number | null;
  records: number;
  fields: { name: string; type: string; description?: string; filterable: FilterOp[] }[];
  pricing: { perRecordMicros: number; perChangeMicros: number; display: string };
  maxRecordsPerCall: number;
  freshness: Freshness;
  license: string;
}

export interface Quote {
  records: number;
  unitPriceMicros: number;
  priceMicros: number;
  display: string;
  balanceMicros: number;
  wouldAutoTopUp: boolean;
  validForSeconds: number;
}

export interface SpigotRecord<T = Record<string, unknown>> {
  key: string;
  data: T;
  version: number;
  freshness: { crawledAt: string | null; sourceLastmod: string | null; staleSince: string | null };
}

/** What a paid call's response headers add: the call id (for claims) and whether it was a replay. */
export interface CallMeta {
  /** `Spigot-Call-Id`; pass it to `claims.create` to report a bad record. */
  callId: string | null;
  /** `Spigot-Replay: true`: a stored response replayed for the same `Idempotency-Key` (not charged). */
  replay: boolean;
}

export interface RecordsPage<T = Record<string, unknown>> extends CallMeta {
  records: SpigotRecord<T>[];
  next: string | null;
  charged: { records: number; priceMicros: number };
  balanceMicros: number;
}

export interface RecordResult<T = Record<string, unknown>> extends CallMeta {
  record: SpigotRecord<T>;
  charged: { records: 1; priceMicros: number };
  balanceMicros: number;
}

export interface Change<T = Record<string, unknown>> {
  cursor: string;
  key: string;
  op: 'add' | 'update' | 'remove';
  version: number;
  patch: Record<string, unknown>[];
  changedAt: string;
  record?: SpigotRecord<T> | null;
}

export interface ChangesPage<T = Record<string, unknown>> extends CallMeta {
  changes: Change<T>[];
  next: string;
  hasMore: boolean;
  charged: { changes: number; priceMicros: number };
  balanceMicros: number;
}

export interface Balance {
  balanceMicros: number;
  autoTopup: {
    enabled: boolean;
    thresholdMicros: number;
    amountCents: number;
    remainingThisMonthCents: number;
    hasSavedMethod: boolean;
  };
}

export interface Topup {
  topupId: string;
  status: string;
  method: string;
  amountCents: number;
  orderId: string | null;
  /** Open this in a browser to approve the PayPal order (wallet top-ups). */
  approveUrl: string | null;
  balanceMicros?: number;
  replay?: boolean;
}

export type ClaimReason = 'STALE' | 'WRONG_VALUE' | 'MISSING_FIELD' | 'DUPLICATE' | 'REMOVED';

export interface ClaimRequest {
  callId: string;
  recordKey: string;
  reason: ClaimReason;
  note?: string | null;
}

export interface Claim {
  claimId: string;
  status: 'OPEN' | 'AUTO_CREDITED' | 'CREDITED' | 'REJECTED';
  creditMicros: number;
}

/** `{ error: { code, message, details? } }`; a 402 adds the payment fields (`topUpUrl`, `quote`, …). */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
  topUpUrl?: string;
  quote?: { records?: number; changes?: number; priceMicros: number };
  balanceMicros?: number;
  [key: string]: unknown;
}
