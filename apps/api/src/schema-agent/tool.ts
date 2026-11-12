// The one tool the schema agent may call (features/04 §2). Its input is model-written data, so the
// Zod schema below is the security boundary: SP-011's extractor field spec (JSONPath subset,
// transform whitelist, safe regexes) plus the proposal metadata. Unknown keys are stripped, so a
// model can't smuggle extra properties into what we store.
import type Anthropic from '@anthropic-ai/sdk';
import {
  extractorFieldSchema,
  recordKeySchema,
  SIMPLE_TRANSFORMS,
  transformSchema,
} from '@spigot/shared';
import { z } from 'zod';
import { FILTER_OPS } from '../records/fields.js';

export const PROPOSE_SCHEMA_TOOL_NAME = 'propose_schema';

const TRANSFORMS_HELP =
  `Whitelisted transforms, applied in order: ${SIMPLE_TRANSFORMS.join(', ')}, ` +
  'split:<sep>, bool:<truthy-word>, regex:<pattern> (first capture group, <= 100 chars).';

/** A field's transform list (also the `repair_fields` tool's). */
export const transformsSchema = z
  .array(transformSchema.describe(TRANSFORMS_HELP))
  .max(10)
  .default([]);

export const proposedFieldSchema = extractorFieldSchema.extend({
  transforms: transformsSchema,
  description: z.string().trim().max(300).optional(),
  /** Filter ops buyers may use on this field (2–4 fields per type should have some). */
  filterable: z.array(z.enum(FILTER_OPS)).max(FILTER_OPS.length).optional(),
  /** Personal data (phone, email, a person's address). Forces `visible: false`. */
  pii: z.boolean().optional(),
  /** Wire-service byline / credit (AP, Reuters, AFP, Getty). Forces `visible: false`. */
  rights_flag: z.boolean().optional(),
  visible: z.boolean().optional(),
});
export type ProposedField = z.infer<typeof proposedFieldSchema>;

/** `Listing`, `Agent`, `Open House`: capitalised words, shown on W05 cards. */
export const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*( [A-Z0-9][A-Za-z0-9]*)*$/;

export const proposalSchema = z.object({
  typeName: z.string().trim().max(40).regex(TYPE_NAME_PATTERN, 'typeName is capitalised words'),
  recordKey: recordKeySchema,
  fields: z
    .array(proposedFieldSchema)
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
  rationale: z.string().trim().min(1).max(2000),
});
export type Proposal = z.infer<typeof proposalSchema>;

const TOOL_DESCRIPTION =
  'Propose the record type for one page template of the site: a type name, how to build a ' +
  'stable record key, typed fields with a deterministic extractor source and transforms, PII / ' +
  'rights flags, filterable ops, and a one-paragraph rationale. Call it exactly once.';

/** JSON Schema for the tool, generated from `proposalSchema` (input side: defaults optional). */
export function proposeSchemaInputSchema(): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(proposalSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
}

export const PROPOSE_SCHEMA_TOOL: Anthropic.Tool = {
  name: PROPOSE_SCHEMA_TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: proposeSchemaInputSchema(),
};

/** Zod issues as short `path: message` lines, for the retry turn and the audit row. */
export function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`);
}
