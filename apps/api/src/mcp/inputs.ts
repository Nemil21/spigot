// Input schemas shared by MCP tool files (SP-022a). Kept out of `mcp/tools/`, which holds only
// tool modules. Field names and ops are validated by the services against the dataset's served
// schema, so an invented field comes back as an `UNSUPPORTED_FILTER` tool error listing the
// valid ones (not a schema error from the SDK).
import { z } from 'zod';

export const siteDatasetInput = {
  site: z.string().min(1).max(100).describe('Site slug from list_datasets, e.g. "bluebonnet".'),
  dataset: z.string().min(1).max(100).describe('Dataset slug from list_datasets, e.g. "listings".'),
};

export const filtersInput = z
  .array(
    z.object({
      field: z.string().describe('A field from describe_dataset.'),
      op: z
        .string()
        .optional()
        .describe('eq (default), lt, lte, gt, gte or in; only the ops describe_dataset lists.'),
      value: z.unknown().describe('A value of the field type; a list for "in".'),
    }),
  )
  .max(20)
  .optional()
  .describe(
    'Filters, all of which must match: [{ "field": "bedrooms", "op": "gte", "value": 3 }].',
  );

export const idempotencyKeyInput = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe(
    'Optional. Reusing a key returns the first result without charging again; omit it and a ' +
      'retry of the same request is still recognised.',
  );

export const maxPriceInput = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    'Optional cap for this call in micros of a dollar (1,000,000 = $1). Above it, nothing is ' +
      'charged and you get the quote back.',
  );
