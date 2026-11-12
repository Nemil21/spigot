// The extractor (features/04 §3): `(html, spec, pageUrl) → record | null`, deterministic, no AI
// call, no eval. Same code in the self-check (SP-012b), `extractTemplate` and `extractPage`
// (SP-013). The spec is always re-validated by Zod before anything in it is evaluated.
import { load, type CheerioAPI } from 'cheerio/slim';
import { coerce, lastPathSegment, type FieldValue, type Value } from './coerce.js';
import { jsonPathFirst } from './jsonpath.js';
import { nativeRegexEngine, type RegexEngine } from './regex.js';
import {
  extractorSpecSchema,
  parseTransform,
  type ExtractorField,
  type ExtractorSource,
  type ExtractorSpec,
  type ParsedTransform,
  type RecordKeySpec,
} from './spec.js';
import { compileTransform, type CompiledTransform } from './transforms.js';

/** Extracted fields: what `records.data` stores and `recordHash` hashes. */
export type RecordData = Record<string, FieldValue>;

export interface ExtractedRecord {
  /** Without the dataset slug; the API prefixes `<dataset-slug>/` when serializing (SP-015). */
  recordKey: string;
  data: RecordData;
  /** Source page. Metadata: not part of `data`, never hashed. */
  url: string;
  /** Sitemap lastmod or crawl time, passed through from `ExtractOptions`. Never hashed. */
  updatedAt: string | null;
}

export interface CompileOptions {
  /** Engine for `regex:` transforms. The API injects RE2 (`re2Engine`, apps/api/src/extract/adapters.ts). */
  regex?: RegexEngine;
}

export interface ExtractOptions extends CompileOptions {
  updatedAt?: string | null;
}

export class ExtractorSpecError extends Error {
  override name = 'ExtractorSpecError';
}

interface CompiledField {
  name: string;
  type: ExtractorField['type'];
  required: boolean;
  source: ExtractorSource;
  transforms: CompiledTransform[];
}

export interface CompiledExtractor {
  spec: ExtractorSpec;
  extract(
    html: string,
    pageUrl: string,
    opts?: { updatedAt?: string | null },
  ): ExtractedRecord | null;
}

/** JSON-LD scalars as-is, value objects (`{"@value": …}`) unwrapped, other objects → null. */
function fromJson(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(fromJson);
  if (typeof v === 'object' && Object.hasOwn(v, '@value')) {
    return fromJson((v as Record<string, unknown>)['@value']);
  }
  return null;
}

/**
 * Every `<script type="application/ld+json">` block, parsed, in document order. A top-level
 * array contributes each element; a `@graph` contributes the block, then each node. Invalid JSON
 * is skipped.
 */
function jsonLdRoots($: CheerioAPI): unknown[] {
  const roots: unknown[] = [];
  $('script').each((_, el) => {
    const type = ($(el).attr('type') ?? '').trim().toLowerCase();
    if (!type.startsWith('application/ld+json')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      return;
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    for (const b of blocks) {
      if (b === null || typeof b !== 'object') continue;
      roots.push(b);
      const graph = (b as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) roots.push(...graph);
    }
  });
  return roots;
}

function readSource(source: ExtractorSource, $: CheerioAPI, roots: () => unknown[]): Value {
  if ('jsonld' in source) return fromJson(jsonPathFirst(source.jsonld, roots()));
  const read = (el: Parameters<CheerioAPI>[0]): Value => {
    const node = $(el);
    if (source.attr === 'text') {
      const text = node.text().replace(/\s+/g, ' ').trim();
      return text || null;
    }
    return node.attr(source.attr) ?? null;
  };
  const matches = $(source.css);
  if (source.all) return matches.toArray().map(read);
  return matches.length ? read(matches[0]!) : null;
}

function recordKeyOf(spec: RecordKeySpec, pageUrl: string, roots: () => unknown[]): string | null {
  if ('from' in spec) return lastPathSegment(pageUrl);
  const v = fromJson(jsonPathFirst(spec.jsonld, roots()));
  const k = Array.isArray(v) ? v[0] : v;
  if (typeof k === 'string') return k.trim() || null;
  if (typeof k === 'number') return String(k);
  return null;
}

/** Validate (Zod) and compile a spec once; reuse the result for every page of the template. */
export function compileExtractor(rawSpec: unknown, opts: CompileOptions = {}): CompiledExtractor {
  const spec = extractorSpecSchema.parse(rawSpec);
  const regex = opts.regex ?? nativeRegexEngine;

  const probe = load('');
  const fields: CompiledField[] = spec.fields.map((f) => {
    if ('css' in f.source) {
      try {
        probe(f.source.css);
      } catch {
        throw new ExtractorSpecError(`field "${f.name}": invalid CSS selector`);
      }
    }
    return {
      name: f.name,
      type: f.type,
      required: f.required,
      source: f.source,
      // Already validated by the schema, so parseTransform returns a ParsedTransform here.
      transforms: f.transforms.map((t) =>
        compileTransform(parseTransform(t) as ParsedTransform, regex),
      ),
    };
  });
  const gate = fields.some((f) => f.required) ? fields.filter((f) => f.required) : fields;

  return {
    spec,
    extract(html, pageUrl, extractOpts = {}) {
      const $ = load(html);
      let roots: unknown[] | undefined;
      const lazyRoots = () => (roots ??= jsonLdRoots($));

      const recordKey = recordKeyOf(spec.recordKey, pageUrl, lazyRoots);
      if (recordKey === null) return null;

      const ctx = { pageUrl };
      const data: RecordData = {};
      for (const f of fields) {
        let v: Value;
        try {
          v = readSource(f.source, $, lazyRoots);
        } catch {
          v = null;
        }
        for (const t of f.transforms) v = t(v, ctx);
        data[f.name] = coerce(v, f.type);
      }
      // Required fields all missing (or, with none required, every field): not a record.
      if (gate.every((f) => data[f.name] === null)) return null;

      return { recordKey, data, url: pageUrl, updatedAt: extractOpts.updatedAt ?? null };
    },
  };
}

const cache = new WeakMap<object, WeakMap<RegexEngine, CompiledExtractor>>();

/**
 * `(html, spec, pageUrl) → record | null`. Throws `ZodError` / `ExtractorSpecError` for an
 * invalid spec. The compiled spec is cached per spec object (treat it as immutable), so a loop
 * over a template's pages validates and compiles once.
 */
export function extract(
  html: string,
  spec: unknown,
  pageUrl: string,
  opts: ExtractOptions = {},
): ExtractedRecord | null {
  const engine = opts.regex ?? nativeRegexEngine;
  let compiled: CompiledExtractor | undefined;
  if (spec !== null && typeof spec === 'object') {
    let byEngine = cache.get(spec);
    if (!byEngine) cache.set(spec, (byEngine = new WeakMap()));
    compiled = byEngine.get(engine);
    if (!compiled) byEngine.set(engine, (compiled = compileExtractor(spec, { regex: engine })));
  } else {
    compiled = compileExtractor(spec, { regex: engine });
  }
  return compiled.extract(html, pageUrl, { updatedAt: opts.updatedAt ?? null });
}
