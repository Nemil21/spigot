// Free MCP tools (api.md §MCP server; SP-022a): `list_datasets`, `describe_dataset`, `quote`.
// Each calls the same SP-017a service as `/v1`, so the agent sees what a REST buyer sees.
import { z } from 'zod';
import { formatCount, formatMicros, formatPer1000 } from '@spigot/shared';
import { catalog, type CatalogSite } from '../../services/catalog.js';
import { describe } from '../../services/describe.js';
import { quote } from '../../services/quote.js';
import { countNoun, guard, ok } from '../results.js';
import { callerOf, requireRead, type ToolModule } from '../tools.js';
import { filtersInput, siteDatasetInput } from '../inputs.js';

const listInput = {
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Words to match against site and dataset names, e.g. "rentals austin". Omit for all.',
    ),
};

/** Sites whose name, slug, dataset slug or record type contains every word of `query`. */
export function matchCatalog(sites: CatalogSite[], query: string | undefined): CatalogSite[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sites;
  const out: CatalogSite[] = [];
  for (const site of sites) {
    const siteText = `${site.slug} ${site.name}`.toLowerCase();
    const datasets = site.datasets.filter((d) => {
      const text = `${siteText} ${d.slug} ${d.type}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    if (datasets.length > 0) out.push({ ...site, datasets });
  }
  return out;
}

const register: ToolModule = (server, deps) => {
  server.registerTool(
    'list_datasets',
    {
      title: 'List datasets for sale',
      description:
        'Lists the sites and datasets sold on Spigot, with record counts, prices and freshness. ' +
        'Free. Use the site and dataset slugs with describe_dataset, quote and search_records.',
      inputSchema: listInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(deps.log, 'list_datasets', async () => {
        requireRead(callerOf(extra));
        const sites = matchCatalog((await catalog(deps.db.pool)).sites, args.query);
        const lines = sites.flatMap((s) =>
          s.datasets.map(
            (d) =>
              `${s.slug}/${d.slug}: ${d.type} (${s.name}), ${formatCount(d.records)} records, ` +
              `${formatPer1000(d.perRecordMicros)}`,
          ),
        );
        const n = lines.length;
        const summary =
          n === 0
            ? args.query
              ? `No datasets match "${args.query}". Call list_datasets with no query to see everything.`
              : 'No datasets are for sale yet.'
            : `${countNoun(n, 'datasets')} for sale (free to list):\n${lines.join('\n')}`;
        return ok(summary, { sites });
      }),
  );

  server.registerTool(
    'describe_dataset',
    {
      title: 'Describe a dataset',
      description:
        "A dataset's fields with the filter ops each supports, its price per record and per " +
        'change, the most records one call returns, and freshness. Free. Build search_records ' +
        'filters only from the fields and ops listed here.',
      inputSchema: siteDatasetInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(deps.log, 'describe_dataset', async () => {
        requireRead(callerOf(extra));
        const d = await describe(
          { db: deps.db.pool, baseUrl: deps.baseUrl },
          args.site,
          args.dataset,
        );
        const fields = d.fields.map((f) =>
          f.filterable.length > 0
            ? `${f.name}: ${f.type} [${f.filterable.join(', ')}]`
            : `${f.name}: ${f.type}`,
        );
        const summary =
          `${args.site}/${args.dataset}: ${d.type}, ${formatCount(d.records)} records, ` +
          `${formatMicros(d.pricing.perRecordMicros)} per record (${d.pricing.display}), ` +
          `${formatMicros(d.pricing.perChangeMicros)} per change, up to ` +
          `${formatCount(d.maxRecordsPerCall)} records per call.\n` +
          `Fields (filter ops in brackets):\n${fields.join('\n')}`;
        return ok(summary, { site: args.site, dataset: args.dataset, ...d });
      }),
  );

  server.registerTool(
    'quote',
    {
      title: 'Quote a search (free)',
      description:
        'Free: says how many records search_records would return for these filters and limit, ' +
        'what that would cost, and your balance. Nothing is charged. Call this first when unsure.',
      inputSchema: {
        ...siteDatasetInput,
        filters: filtersInput,
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Records wanted (default 50, capped by the dataset).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(deps.log, 'quote', async () => {
        const caller = callerOf(extra);
        requireRead(caller);
        const q = await quote(
          { db: deps.db.pool, buyerId: caller.buyerId },
          {
            site: args.site,
            dataset: args.dataset,
            ...(args.filters !== undefined ? { filters: args.filters } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
        );
        const summary =
          `${countNoun(q.records, args.dataset)} would cost ${q.display}; balance ` +
          `${formatMicros(q.balanceMicros)}. Nothing charged for this quote.` +
          (q.priceMicros > q.balanceMicros && !q.wouldAutoTopUp
            ? ' Your balance is too low for this search: ask your user to top up.'
            : '');
        return ok(summary, { ...q });
      }),
  );
};

export default register;
