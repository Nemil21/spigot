/**
 * W07 Records browser data (SP-053; api.md-style shapes from apps/api/src/routes/records-browser.ts)
 * and the pure helpers behind the version drawer's diff view.
 */

export type FieldType =
  'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'url' | 'string[]';

export interface BrowserField {
  name: string;
  type: FieldType;
  /** False: never sold. The owner still sees it, marked hidden. */
  visible: boolean;
  pii: boolean;
}

export interface BrowserDataset {
  id: string;
  slug: string;
  typeName: string;
  status: string;
  recordCount: number;
  staleSince: string | null;
  fields: BrowserField[];
}

export interface RecordRow {
  id: string;
  key: string;
  url: string | null;
  data: Record<string, unknown>;
  version: number;
  updatedAt: string;
  crawledAt: string | null;
  sourceLastmod: string | null;
}

export interface RecordsBlock {
  rows: RecordRow[];
  rowCount: number;
  staleSince: string | null;
}

export interface PatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export interface RecordVersion {
  seq: number;
  version: number;
  op: 'add' | 'update' | 'remove';
  patch: PatchOp[];
  changedAt: string;
  crawlRunId: string | null;
}

export interface RecordHistory {
  record: {
    id: string;
    datasetId: string;
    key: string;
    version: number;
    updatedAt: string;
    removedAt: string | null;
  };
  hiddenFields: string[];
  /** Newest first. */
  versions: RecordVersion[];
  truncated: boolean;
}

/** The dataset is serving records extracted before the site's layout changed. */
export function isStale(d: Pick<BrowserDataset, 'status' | 'staleSince'>): boolean {
  return d.status === 'LIVE_STALE' || d.staleSince !== null;
}

// --- diff view ---------------------------------------------------------------------------------

/** One line of the diff view: a field's value before and after a change. */
export interface DiffLine {
  /** Top-level field (or `""` for the whole record). */
  field: string;
  /** JSON Pointer as stored, e.g. `/price_usd` or `/photos/2`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  /** Undefined when unknown: history before this version is past retention. */
  before: unknown;
  after: unknown;
  hidden: boolean;
}

export interface VersionDiff {
  version: RecordVersion;
  lines: DiffLine[];
  /** Whether `before` values are known (the history reaches back to the record's `add`). */
  beforeKnown: boolean;
}

const unescapePointer = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

function segments(path: string): string[] {
  if (path === '') return [];
  return path.split('/').slice(1).map(unescapePointer);
}

function getAt(doc: unknown, segs: readonly string[]): unknown {
  let cur = doc;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** Applies one op to `doc` in place where possible; returns the new root. */
function applyOp(doc: unknown, op: PatchOp): unknown {
  const segs = segments(op.path);
  if (segs.length === 0) {
    if (op.op === 'remove') return undefined;
    if (op.op === 'add' || op.op === 'replace') return structuredClone(op.value);
    return doc;
  }
  const parent = getAt(doc, segs.slice(0, -1));
  if (parent === null || typeof parent !== 'object') return doc;
  const last = segs[segs.length - 1]!;
  if (Array.isArray(parent)) {
    const i = last === '-' ? parent.length : Number(last);
    if (!Number.isInteger(i)) return doc;
    if (op.op === 'add') parent.splice(i, 0, structuredClone(op.value));
    else if (op.op === 'replace') parent[i] = structuredClone(op.value);
    else if (op.op === 'remove') parent.splice(i, 1);
    return doc;
  }
  const obj = parent as Record<string, unknown>;
  if (op.op === 'add' || op.op === 'replace') obj[last] = structuredClone(op.value);
  else if (op.op === 'remove') delete obj[last];
  return doc;
}

/**
 * Replays `versions` (newest first, as the API sends them) oldest to newest and returns one diff
 * per version, newest first. Before-values come from the replayed record, so they are known only
 * once the replay has seen the record's `add`; a history cut by retention shows new values only.
 */
export function diffVersions(
  versions: readonly RecordVersion[],
  hiddenFields: readonly string[],
): VersionDiff[] {
  const hidden = new Set(hiddenFields);
  const out: VersionDiff[] = [];
  let doc: unknown;
  let known = false;
  for (const v of [...versions].sort((a, b) => a.seq - b.seq)) {
    const beforeKnown = known || v.op === 'add';
    const lines: DiffLine[] = [];
    for (const op of v.patch) {
      const segs = segments(op.path);
      const field = segs[0] ?? '';
      if (segs.length === 0 && (op.op === 'add' || op.op === 'replace') && isObject(op.value)) {
        // A whole record (a new or revived listing): one line per field.
        for (const [k, val] of Object.entries(op.value)) {
          lines.push({
            field: k,
            path: `/${k}`,
            kind: 'added',
            before: undefined,
            after: val,
            hidden: hidden.has(k),
          });
        }
      } else if (op.op === 'add' || op.op === 'replace' || op.op === 'remove') {
        // `add` into an array inserts (shifting the element there), so it has no before-value.
        const intoArray = op.op === 'add' && Array.isArray(getAt(doc, segs.slice(0, -1)));
        const before = known && !intoArray ? getAt(doc, segs) : undefined;
        lines.push({
          field,
          path: op.path,
          kind:
            op.op === 'remove'
              ? 'removed'
              : op.op === 'add' && (!known || intoArray || before === undefined)
                ? 'added'
                : 'changed',
          before: known ? before : undefined,
          after: op.op === 'remove' ? undefined : op.value,
          hidden: hidden.has(field),
        });
      }
      if (known || segs.length === 0) doc = applyOp(doc, op);
    }
    if (v.op === 'add') known = true;
    if (v.op === 'remove') known = true; // the record is gone; a later `add` replaces it whole
    out.push({ version: v, lines, beforeKnown });
  }
  return out.reverse();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A cell / diff value as text: strings plain, everything else JSON. */
export function formatValue(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return JSON.stringify(v);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "12 min ago", "3 h ago", "2 d ago"; older than a week → the date. */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = Math.max(0, now - t);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return formatDateTime(iso);
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}
