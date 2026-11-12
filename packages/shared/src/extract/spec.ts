// Extractor spec (features/04 §3; data-model §schema_versions.extractor / .record_key).
// Claude writes it once per template; plain code (`extract.ts`) runs it on every page.
// Everything here is model-written data, so the schema is the security boundary: JSONPath is
// limited to dot / bracket / index segments, transforms to a whitelist, regexes to safe ones.
import { z } from 'zod';
import { checkRegexPattern } from './regex.js';

/**
 * Dot (`.name`), quoted bracket (`['@id']`) and numeric index (`[0]`) segments only. No `..`,
 * wildcards, slices, unions, `?()` filters or `()` script expressions ever reach the evaluator.
 */
export const JSONPATH_PATTERN = /^\$(\.[A-Za-z_@][\w@-]*|\['[^'\]]+'\]|\[\d+\])+$/;
export const JSONPATH_MAX_LENGTH = 200;

export const jsonPathSchema = z
  .string()
  .max(JSONPATH_MAX_LENGTH)
  .regex(JSONPATH_PATTERN, "JSONPath may only use .name, ['name'] and [0] segments");

/** `text` (whitespace-collapsed text content) or an attribute name. */
const attrSchema = z
  .string()
  .regex(/^(text|[A-Za-z_:][-\w:.]{0,63})$/, 'attr must be "text" or an attribute name');

export const sourceSchema = z.union([
  z.strictObject({ jsonld: jsonPathSchema }),
  z.strictObject({
    css: z.string().trim().min(1).max(300),
    attr: attrSchema.default('text'),
    all: z.boolean().optional(),
  }),
]);
export type ExtractorSource = z.infer<typeof sourceSchema>;

export const SIMPLE_TRANSFORMS = [
  'trim',
  'lower',
  'toInt',
  'toFloat',
  'firstInt',
  'money',
  'date',
  'datetime',
  'absoluteUrl',
] as const;
export type SimpleTransform = (typeof SIMPLE_TRANSFORMS)[number];

export type ParsedTransform =
  | { op: SimpleTransform }
  | { op: 'split'; sep: string }
  | { op: 'bool'; word: string }
  | { op: 'regex'; pattern: string };

/** Parses one transform string; returns an error message for anything off the whitelist. */
export function parseTransform(t: string): ParsedTransform | string {
  if ((SIMPLE_TRANSFORMS as readonly string[]).includes(t)) return { op: t as SimpleTransform };
  const colon = t.indexOf(':');
  if (colon < 0) return `unknown transform "${t}"`;
  const op = t.slice(0, colon);
  const arg = t.slice(colon + 1);
  switch (op) {
    case 'split':
      if (arg.length < 1 || arg.length > 10) return 'split:<sep> needs a 1-10 char separator';
      return { op: 'split', sep: arg };
    case 'bool':
      if (arg.trim().length < 1 || arg.length > 40) return 'bool:<word> needs a 1-40 char word';
      return { op: 'bool', word: arg };
    case 'regex': {
      const problem = checkRegexPattern(arg);
      return problem ? `regex:${problem}` : { op: 'regex', pattern: arg };
    }
    default:
      return `unknown transform "${t}"`;
  }
}

export const transformSchema = z.string().superRefine((t, ctx) => {
  const parsed = parseTransform(t);
  if (typeof parsed === 'string') ctx.addIssue({ code: 'custom', message: parsed });
});

export const FIELD_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'url',
  'string[]',
] as const;
export const fieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof fieldTypeSchema>;

/** Metadata the extractor attaches next to the record; a field may not shadow them. */
export const RESERVED_FIELD_NAMES = ['url', 'updated_at'] as const;

export const fieldNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'field names are snake_case')
  .refine((n) => !(RESERVED_FIELD_NAMES as readonly string[]).includes(n), {
    message: 'url and updated_at are added by the extractor',
  });

/**
 * One extracted field. Unknown keys (description, filterable, pii, …) are stripped, so a
 * `propose_schema` field parses into its extractor part; SP-012a can `.extend()` this.
 */
export const extractorFieldSchema = z.object({
  name: fieldNameSchema,
  type: fieldTypeSchema,
  required: z.boolean().default(false),
  source: sourceSchema,
  transforms: z.array(transformSchema).max(10).default([]),
});
export type ExtractorField = z.infer<typeof extractorFieldSchema>;

/** `{ from: 'url' }` → last URL path segment; `{ jsonld: path }` → first JSON-LD match. */
export const recordKeySchema = z.union([
  z.strictObject({ from: z.literal('url') }),
  z.strictObject({ jsonld: jsonPathSchema }),
]);
export type RecordKeySpec = z.infer<typeof recordKeySchema>;

export const extractorSpecSchema = z.object({
  recordKey: recordKeySchema,
  fields: z
    .array(extractorFieldSchema)
    .min(1)
    .max(50)
    .superRefine((fields, ctx) => {
      const seen = new Set<string>();
      for (const [i, f] of fields.entries()) {
        if (seen.has(f.name)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate field "${f.name}"`,
            path: [i, 'name'],
          });
        }
        seen.add(f.name);
      }
    }),
});
/** Parsed (defaults applied) spec. Validate stored/model JSON with `extractorSpecSchema.parse`. */
export type ExtractorSpec = z.infer<typeof extractorSpecSchema>;
/** Spec as written (defaults optional). */
export type ExtractorSpecInput = z.input<typeof extractorSpecSchema>;
