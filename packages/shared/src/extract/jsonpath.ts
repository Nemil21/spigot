// Evaluator for the restricted JSONPath grammar in `spec.ts` (`$`, then `.name`, `['name']` and
// `[0]` segments). Only paths that passed `JSONPATH_PATTERN` get here, so there is nothing to
// interpret: no filters, scripts, wildcards or recursive descent. It reads own properties only,
// so `$.constructor` or `$.__proto__` can never reach a prototype.
//
// Why not jsonpath-plus: even with `eval: false` it gives `@`-prefixed names its own meaning, so
// `$['@id']` (data-model §schema_versions.record_key) and `$.@type` throw or mis-resolve.

type Segment = { name: string } | { index: number };

const SEGMENT_RE = /\.([A-Za-z_@][\w@-]*)|\['([^'\]]+)'\]|\[(\d+)\]/y;
const parsed = new Map<string, Segment[]>();

function segments(path: string): Segment[] {
  let segs = parsed.get(path);
  if (segs) return segs;
  segs = [];
  SEGMENT_RE.lastIndex = 1; // after `$`
  while (SEGMENT_RE.lastIndex < path.length) {
    const m = SEGMENT_RE.exec(path);
    if (!m) throw new Error(`unsupported JSONPath: ${path}`);
    segs.push(m[3] !== undefined ? { index: Number(m[3]) } : { name: (m[1] ?? m[2])! });
  }
  if (parsed.size > 1000) parsed.clear();
  parsed.set(path, segs);
  return segs;
}

function step(v: unknown, seg: Segment, out: unknown[]): void {
  if (v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    if ('index' in seg) {
      if (seg.index < v.length) out.push(v[seg.index]);
    } else {
      // JSON-LD often makes a single-valued property an array (`"offers": [{…}]`): a name segment
      // on an array applies to each element.
      for (const item of v) step(item, seg, out);
    }
    return;
  }
  if ('name' in seg && Object.hasOwn(v, seg.name)) out.push((v as Record<string, unknown>)[seg.name]);
}

/** Every match of `path` in `json`, in document order. */
export function jsonPathAll(path: string, json: unknown): unknown[] {
  let current: unknown[] = [json];
  for (const seg of segments(path)) {
    const next: unknown[] = [];
    for (const v of current) step(v, seg, next);
    current = next;
    if (!current.length) break;
  }
  return current;
}

/** First non-null match of `path` across `roots` (JSON-LD blocks in document order), else null. */
export function jsonPathFirst(path: string, roots: readonly unknown[]): unknown {
  for (const json of roots) {
    for (const hit of jsonPathAll(path, json)) if (hit !== null && hit !== undefined) return hit;
  }
  return null;
}
