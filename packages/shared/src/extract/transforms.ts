// Transform whitelist (features/04 §3). Each transform is compiled once per spec and maps one
// scalar to a value; arrays (CSS `all`, JSON-LD arrays, `split`) are mapped element-wise.
// `null` in → `null` out, and nothing throws.
import { parseDate, parseDateTime, parseHttpUrl, parseNumber, type Scalar, type Value } from './coerce.js';
import { nativeRegexEngine, type RegexEngine } from './regex.js';
import type { ParsedTransform } from './spec.js';

export interface TransformContext {
  pageUrl: string;
}

type ScalarFn = (v: Scalar, ctx: TransformContext) => Value;
export type CompiledTransform = (v: Value, ctx: TransformContext) => Value;

const FIRST_INT_RE = /\d{1,3}(?:,\d{3})+(?!\d)|\d+/;

/** Lowercase words separated by single spaces, for whole-word `bool:` matching. */
const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

function scalarFn(t: ParsedTransform, regex: RegexEngine): ScalarFn {
  switch (t.op) {
    case 'trim':
      return (v) => (typeof v === 'string' ? v.trim() : v);
    case 'lower':
      return (v) => (typeof v === 'string' ? v.toLowerCase() : v);
    case 'toInt':
      return (v) => {
        const n = parseNumber(v);
        return n === null ? null : Math.trunc(n);
      };
    case 'toFloat':
      return (v) => parseNumber(v);
    case 'firstInt':
      return (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
        if (typeof v !== 'string') return null;
        const m = FIRST_INT_RE.exec(v);
        return m ? Number(m[0].replace(/,/g, '')) : null;
      };
    case 'money':
      // Strips `$`, `,` and whitespace, then reads the leading decimal: "$1,875 / month" → 1875.
      return (v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v !== 'string') return null;
        const m = /^[+-]?(\d+(\.\d+)?|\.\d+)/.exec(v.replace(/[$,\s]/g, ''));
        return m ? Number(m[0]) : null;
      };
    case 'date':
      return (v) => parseDate(v);
    case 'datetime':
      return (v) => parseDateTime(v);
    case 'absoluteUrl':
      return (v, ctx) => parseHttpUrl(v, ctx.pageUrl);
    case 'split': {
      const { sep } = t;
      return (v) =>
        typeof v === 'string'
          ? v
              .split(sep)
              .map((s) => s.trim())
              .filter(Boolean)
          : v;
    }
    case 'bool': {
      const needle = words(t.word);
      return (v) => (typeof v === 'boolean' ? v : words(String(v)).includes(needle));
    }
    case 'regex': {
      let compiled: ReturnType<RegexEngine['compile']> | null = null;
      try {
        compiled = regex.compile(t.pattern);
      } catch {
        // Passed the spec check but the engine refused it: the field reads as null, which the
        // self-check (SP-012b) reports as a failing field.
      }
      return (v) => (compiled ? compiled.firstGroup(String(v)) : null);
    }
  }
}

export function compileTransform(t: ParsedTransform, regex: RegexEngine = nativeRegexEngine): CompiledTransform {
  const fn = scalarFn(t, regex);
  const apply = (v: Value, ctx: TransformContext): Value => {
    if (v === null) return null;
    if (Array.isArray(v)) {
      const out: Value[] = [];
      for (const item of v) {
        const r = apply(item, ctx);
        // `split` turns one element into many; keep the list flat.
        if (Array.isArray(r)) out.push(...r);
        else out.push(r);
      }
      return out;
    }
    return fn(v, ctx);
  };
  return apply;
}
