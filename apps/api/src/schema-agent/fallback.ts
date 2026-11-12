// JSON-LD-only auto-schema (SP-012b; features/04 §Edge cases "Model unavailable / rate-limited").
// When Claude is still overloaded / rate-limited after 3 tries, a template whose pages carry
// schema.org JSON-LD gets a proposal built by plain code: the main JSON-LD entity's properties are
// flattened to typed fields (`offers.price` → `offers_price`, integer). No AI is involved, so the
// proposal is labelled "auto (no AI)" (`schema_versions.ai_model`, the audit row and the
// rationale). It still goes through the dry run, the PII / rights guard and the self-check (without
// repair rounds) before it is stored. Templates without JSON-LD get no fallback and stay failed;
// the resume job retries them with the model later.
import {
  coerce,
  compileExtractor,
  JSONPATH_MAX_LENGTH,
  JSONPATH_PATTERN,
  parseDate,
  parseDateTime,
  parseHttpUrl,
  type FieldType,
  type Value,
} from '@spigot/shared';
import type { SamplePage } from './dryrun.js';
import { jsonLdBlocks } from './outline.js';
import { TYPE_NAME_PATTERN, type Proposal, type ProposedField } from './tool.js';

/** `schema_versions.ai_model` and the audit label of an auto-schema. */
export const AUTO_SCHEMA_LABEL = 'auto (no AI)';

const MAX_FIELDS = 30;
const MAX_DEPTH = 3;
/** A property must appear on this share of the samples to become a field. */
const MIN_PRESENCE = 0.6;
const MAX_REQUIRED = 3;
/** Entity types that sit next to the main entity on most pages; never the record itself. */
const AUXILIARY_TYPES = new Set([
  'BreadcrumbList',
  'WebSite',
  'WebPage',
  'Organization',
  'SiteNavigationElement',
  'SearchAction',
  'ImageObject',
]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const typesOf = (o: Obj): string[] =>
  ([] as Json[]).concat(o['@type'] ?? []).filter((t): t is string => typeof t === 'string');

/** Top-level entities of one page: blocks, arrays of entities and `@graph` members. */
function entities(blocks: unknown[]): Obj[] {
  const out: Obj[] = [];
  const add = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (isObj(v)) {
      if (Array.isArray(v['@graph'])) v['@graph'].forEach(add);
      else out.push(v);
    }
  };
  blocks.forEach(add);
  return out;
}

/** The record entity: of the template's JSON-LD types first, else the first non-auxiliary one. */
function mainEntity(blocks: unknown[], templateTypes: readonly string[]): Obj | null {
  const all = entities(blocks);
  return (
    all.find((e) => typesOf(e).some((t) => templateTypes.includes(t))) ??
    all.find((e) => typesOf(e).length && !typesOf(e).some((t) => AUXILIARY_TYPES.has(t))) ??
    null
  );
}

const SIMPLE_SEGMENT = /^[A-Za-z_@][\w@-]*$/;
const segment = (k: string) => (SIMPLE_SEGMENT.test(k) ? `.${k}` : `['${k}']`);

interface Leaf {
  /** Property path from the entity, e.g. `['offers', 'price']`. */
  keys: string[];
  value: Json;
}

/** Scalar and scalar-array leaves of an entity (arrays of objects: their first element). */
function leaves(o: Obj, prefix: string[] = [], out: Leaf[] = []): Leaf[] {
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('@') || k.includes("'") || k.includes(']')) continue;
    const keys = [...prefix, k];
    const first = Array.isArray(v) && v.length && v.every(isObj) ? v[0]! : v;
    if (isObj(first)) {
      if (keys.length < MAX_DEPTH) leaves(first, keys, out);
    } else if (Array.isArray(first)) {
      if (first.length && first.every((x) => typeof x === 'string'))
        out.push({ keys, value: first });
    } else if (first !== null && first !== '') {
      out.push({ keys, value: first });
    }
  }
  return out;
}

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

function fieldName(keys: string[], taken: Set<string>): string | null {
  let name = keys.map(snake).filter(Boolean).join('_');
  if (!name) return null;
  if (!/^[a-z]/.test(name)) name = `f_${name}`;
  if (name === 'url' || name === 'updated_at') name = `jsonld_${name}`;
  name = name.slice(0, 63).replace(/_+$/, '');
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name.slice(0, 60)}_${i}`;
  taken.add(out);
  return out;
}

/** The narrowest type that fits every sample value, with the transforms it needs. */
function inferType(values: Json[]): { type: FieldType; transforms: string[] } | null {
  if (values.every((v) => Array.isArray(v))) return { type: 'string[]', transforms: [] };
  if (values.every((v) => typeof v === 'boolean')) return { type: 'boolean', transforms: [] };
  if (values.every((v) => typeof v === 'number'))
    return values.every((v) => Number.isSafeInteger(v))
      ? { type: 'integer', transforms: [] }
      : { type: 'number', transforms: [] };
  if (!values.every((v) => typeof v === 'string' || typeof v === 'number')) return null;
  const strs = values.map(String);
  if (strs.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s)))
    return { type: 'date', transforms: [] };
  if (strs.every((s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && parseDateTime(s)))
    return { type: 'datetime', transforms: [] };
  if (strs.every((s) => /^https?:\/\//i.test(s) && parseHttpUrl(s)))
    return { type: 'url', transforms: [] };
  // Numeric-looking strings stay strings (ZIP codes, ids): the owner can retype on W06.
  return { type: 'string', transforms: ['trim'] };
}

const STATIC_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(sses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** `/listings/:slug` → `Listing`, `/open-houses/:id` → `Open House`; else the JSON-LD type. */
export function typeNameFor(pathPattern: string, jsonldType: string | undefined): string {
  const segs = pathPattern.split('/').filter((s) => s && !s.startsWith(':'));
  const last = segs.filter((s) => STATIC_SEGMENT.test(s)).at(-1);
  const candidates = [
    last &&
      singular(last)
        .split(/[-_]+/)
        .filter(Boolean)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(' '),
    jsonldType,
    'Record',
  ];
  return candidates.find((c): c is string => !!c && c.length <= 40 && TYPE_NAME_PATTERN.test(c))!;
}

export interface AutoSchemaInput {
  pathPattern: string;
  /** Top-level JSON-LD `@type`s of the template (clustering). */
  jsonldTypes: readonly string[];
  samples: readonly SamplePage[];
  /** Why the model wasn't used (shown in the rationale). */
  reason: string;
}

/**
 * A `propose_schema`-shaped proposal flattened from the samples' JSON-LD, or null when the
 * samples carry no usable JSON-LD entity.
 */
export function autoSchema(input: AutoSchemaInput): Proposal | null {
  const { samples } = input;
  if (!samples.length) return null;
  const pages = samples.map((s) => ({
    page: s,
    main: mainEntity(jsonLdBlocks(s.html), input.jsonldTypes),
  }));
  const withMain = pages.filter((p) => p.main);
  if (!withMain.length) return null;

  // Each path's value on each sample, in first-seen order.
  const byPath = new Map<string, { keys: string[]; values: Json[]; on: SamplePage[] }>();
  for (const p of withMain) {
    for (const leaf of leaves(p.main!)) {
      const path = '$' + leaf.keys.map(segment).join('');
      if (path.length > JSONPATH_MAX_LENGTH || !JSONPATH_PATTERN.test(path)) continue;
      let entry = byPath.get(path);
      if (!entry) byPath.set(path, (entry = { keys: leaf.keys, values: [], on: [] }));
      entry.values.push(leaf.value);
      entry.on.push(p.page);
    }
  }

  const taken = new Set<string>();
  const fields: ProposedField[] = [];
  for (const [path, e] of byPath) {
    if (fields.length >= MAX_FIELDS) break;
    if (e.values.length < Math.ceil(withMain.length * MIN_PRESENCE)) continue;
    const typed = inferType(e.values);
    if (!typed) continue;
    const field: ProposedField = {
      name: 'probe',
      type: typed.type,
      required: false,
      source: { jsonld: path },
      transforms: typed.transforms,
    };
    // The extractor reads the first match across every block (and `@graph` node): the path must
    // land on the main entity's value on every sample, not on a breadcrumb's `name`.
    const ex = compileExtractor({ recordKey: { from: 'url' }, fields: [field] });
    const consistent = e.on.every((page, i) => {
      const got = ex.extract(page.html, page.url)?.data.probe ?? null;
      const v = e.values[i]!;
      const want = coerce((typeof v === 'string' ? v.trim() : v) as Value, typed.type);
      return JSON.stringify(got) === JSON.stringify(want);
    });
    if (!consistent) continue;
    const name = fieldName(e.keys, taken);
    if (!name) continue;
    fields.push({ ...field, name, description: `JSON-LD ${e.keys.join('.')}` });
  }
  if (!fields.length) return null;

  // Required: up to 3 top-level scalar properties present on every sample.
  let required = 0;
  for (const f of fields) {
    if (required >= MAX_REQUIRED) break;
    const e = byPath.get((f.source as { jsonld: string }).jsonld)!;
    if (e.keys.length === 1 && e.values.length === samples.length && f.type !== 'string[]') {
      f.required = true;
      required++;
    }
  }

  const mainType = typesOf(withMain[0]!.main!)[0];
  return {
    typeName: typeNameFor(input.pathPattern, mainType),
    recordKey: { from: 'url' },
    fields,
    rationale:
      `${AUTO_SCHEMA_LABEL}: Claude was unavailable (${input.reason}), so Spigot built this ` +
      `schema with plain code from the pages' schema.org ${mainType ?? 'JSON-LD'} data: ` +
      `${fields.length} JSON-LD properties flattened to typed fields, no CSS fields. ` +
      'Check the names and visibility before publishing.',
  };
}
