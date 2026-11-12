/**
 * W14 Admin / audit (screens.md §W14; features/14 §Audit and ops; SP-062). Response shapes of
 * SP-043's `/admin/*` endpoints and SP-021's `POST /admin/payouts/run`, plus the pure helpers the
 * screen and its tests share.
 */

/** `GET /admin/audit` row (apps/api/src/ops/auditSearch.ts). */
export interface AuditEvent {
  id: string;
  at: string;
  actorType: string;
  actorId: string | null;
  publisherId: string | null;
  entity: string | null;
  entityId: string | null;
  action: string;
  paypalId: string | null;
  data: unknown;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Pass as `cursor` for the next page; `null` on the last page. */
  next: string | null;
}

export interface CheckResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** `GET /admin/health` (apps/api/src/ops/health.ts). */
export interface AdminHealth {
  status: 'ok' | 'degraded';
  checkedAt: string;
  checks: {
    paypal: CheckResult;
    db: CheckResult;
    workflows: { ok: boolean; mode: string; detail: string; missing?: string[] };
    facts: CheckResult;
  };
  gate:
    | {
        siteId: string;
        publisherId: string;
        origin: string;
        status: string;
        lastGateSeenAt: string | null;
        lastHitAt: string | null;
      }[]
    | null;
  openTopups: { count: number; oldestAt: string | null; needsReconcile: number } | null;
  pendingPayouts: {
    pendingItems: number;
    unclaimedItems: number;
    oldestAt: string | null;
    batchesNeedingReconcile: number;
  } | null;
}

/** `POST /admin/ledger/check` (apps/api/src/ledger/check.ts). */
export interface LedgerCheckResult {
  sumMicros: number;
  accountsChecked: number;
  mismatches: ({ check: string; expectedMicros: number; actualMicros: number } & Record<
    string,
    unknown
  >)[];
}

/** `POST /admin/payouts/run` (apps/api/src/routes/admin-payouts.ts → `runSummary`). */
export interface AdminRunResult {
  demoControl: true;
  outcome: 'NO_ITEMS' | 'PERIOD_TAKEN' | 'PENDING' | 'NEEDS_RECONCILE' | 'FAILED' | 'RETRY_LATER';
  batchId: string | null;
  resumed: boolean;
  paypalBatchId?: string;
  errorCode?: string;
  items: { id: string; publisherId: string; netCents: number }[];
}

/** The three W14 search fields; each maps to one `GET /admin/audit` query param. */
export const SEARCH_FIELDS = [
  { key: 'paypalId', label: 'PayPal id', placeholder: 'Order, capture, refund or payout id' },
  { key: 'publisherId', label: 'Publisher id', placeholder: 'Publisher UUID' },
  { key: 'actorId', label: 'Buyer id', placeholder: 'Buyer id (the actor)' },
] as const;

export type SearchKey = (typeof SEARCH_FIELDS)[number]['key'];
export type AuditSearch = Partial<Record<SearchKey, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A client-side check that mirrors the API's (`publisherId` is a UUID); `null` when valid. */
export function searchError(s: AuditSearch): string | null {
  // Trimmed like `auditUrl`: a pasted id often carries a trailing space or newline.
  const publisherId = s.publisherId?.trim();
  if (publisherId && !UUID.test(publisherId)) return 'Publisher id must be a UUID.';
  return null;
}

/** `/admin/audit?paypalId=…&limit=50&cursor=…`, empty fields dropped. */
export function auditUrl(s: AuditSearch, cursor?: string | null, limit = 50): string {
  const q = new URLSearchParams();
  for (const { key } of SEARCH_FIELDS) {
    const v = s[key]?.trim();
    if (v) q.set(key, v);
  }
  q.set('limit', String(limit));
  if (cursor) q.set('cursor', cursor);
  return `/admin/audit?${q.toString()}`;
}

/**
 * SIM rows (features/15): the actor is `SIM` (seeded top-ups, sampled SIM calls) or the row's
 * data says `isSimulated`.
 */
export function isSimEvent(e: AuditEvent): boolean {
  if (e.actorType === 'SIM') return true;
  const d = e.data as { isSimulated?: unknown } | null;
  return !!d && typeof d === 'object' && d.isSimulated === true;
}

/** `2026-11-12T10:04:05.000Z` → `2026-11-12 10:04:05 UTC`. UTC, so every viewer agrees. */
export function formatAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** One line of the row's `data` for the grid cell; the tooltip has the full JSON. */
export function dataSummary(data: unknown): string {
  if (data == null) return '';
  if (typeof data !== 'object') return String(data);
  return Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

/** The newest gate signal across sites (hit bucket or policy fetch), with its site. */
export function lastGateHit(
  gate: AdminHealth['gate'],
): { at: string; origin: string; sites: number } | null {
  if (!gate || gate.length === 0) return null;
  let best: { at: string; origin: string } | null = null;
  for (const s of gate) {
    for (const at of [s.lastHitAt, s.lastGateSeenAt]) {
      if (at && (!best || at > best.at)) best = { at, origin: s.origin };
    }
  }
  return best ? { ...best, sites: gate.length } : null;
}

/** Which dependency checks failed, for the degraded banner. */
export function failedChecks(h: AdminHealth): string[] {
  const out: string[] = [];
  const { paypal, db, workflows, facts } = h.checks;
  if (!paypal.ok) out.push(`PayPal token (${paypal.error ?? 'ERROR'})`);
  if (!db.ok) out.push(`Database (${db.error ?? 'ERROR'})`);
  if (!workflows.ok) {
    const missing = workflows.missing?.length ? `: ${workflows.missing.join(', ')}` : '';
    out.push(`Workflows (${workflows.detail}${missing})`);
  }
  if (!facts.ok && db.ok) out.push(`Ops queries (${facts.error ?? 'ERROR'})`);
  return out;
}

/** What a run outcome means, in one sentence. */
export function runOutcomeLine(r: AdminRunResult): string {
  switch (r.outcome) {
    case 'PENDING': {
      const n = r.items.length;
      return `Payout batch sent via PayPal: ${n} item${n === 1 ? '' : 's'}. Items flip to Paid out when PayPal confirms.`;
    }
    case 'NO_ITEMS':
      return 'Nothing to pay out: no publisher is over the $1 demo threshold.';
    case 'PERIOD_TAKEN':
      return 'A batch for this period already exists, so nothing was sent twice.';
    case 'FAILED':
      return `PayPal refused the batch (${r.errorCode ?? 'ERROR'}). The amounts are back in each publisher's payable balance.`;
    case 'NEEDS_RECONCILE':
      return "PayPal's answer was unclear; the batch needs reconciling before anything is resent.";
    case 'RETRY_LATER':
      return "PayPal hasn't confirmed the batch yet. Spigot retries with the same batch id, so it is never sent twice.";
  }
}
