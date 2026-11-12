import type {
  ColDef,
  GetRowIdParams,
  ICellRendererParams,
  IServerSideDatasource,
  RowClickedEvent,
  ValueFormatterParams,
} from 'ag-grid-community';
import { formatCount } from '@spigot/shared/money';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api as defaultApi, type ApiClient } from '../api/client';
import { EmptyState, ErrorBanner, SkeletonText } from '../components';
import { SpigotGrid } from '../grid';
import {
  ago,
  formatDateTime,
  formatValue,
  isStale,
  type BrowserDataset,
  type BrowserField,
  type RecordRow,
  type RecordsBlock,
} from './records/model';
import { VersionDrawer } from './records/VersionDrawer';
import { href, paths } from '../routes';
import { PAGE, PageHeader } from './Panel';

/**
 * W07 Records browser (SP-053; screens.md §W07, features/05, features/13).
 *
 * Data: `GET /api/sites` (first site, or `?site=<id>`) → `GET /api/sites/:id/datasets` (record-backed
 * datasets with their schema; `?dataset=<id>` picks one) → AG Grid's server-side row model over
 * `GET /api/datasets/:id/records` in blocks of 100, sorting and filtering on the server. A row
 * opens the version drawer (`GET /api/records/:id/versions`).
 *
 * Columns: record key, every schema field (hidden fields shown to the owner, struck through and
 * labelled), version, last changed, freshness (when we last checked the page).
 * States: empty (no site / nothing published); live; stale dataset banner.
 */

export const BLOCK_SIZE = 100;

interface SiteSummary {
  id: string;
  origin: string;
}

type Loaded = { site: SiteSummary | null; datasets: BrowserDataset[] };

/** AG Grid server-side datasource over the records endpoint. */
export function recordsDatasource(
  client: ApiClient,
  datasetId: string,
  onBlock?: (block: RecordsBlock) => void,
): IServerSideDatasource<RecordRow> {
  return {
    getRows(params) {
      const {
        startRow = 0,
        endRow = startRow + BLOCK_SIZE,
        sortModel,
        filterModel,
      } = params.request;
      const qs = new URLSearchParams({
        startRow: String(startRow),
        endRow: String(endRow),
        sortModel: JSON.stringify(sortModel ?? []),
        filterModel: JSON.stringify(filterModel ?? {}),
      });
      client.get<RecordsBlock>(`/api/datasets/${encodeURIComponent(datasetId)}/records?${qs}`).then(
        (block) => {
          params.success({ rowData: block.rows, rowCount: block.rowCount });
          onBlock?.(block);
        },
        () => params.fail(),
      );
    },
  };
}

const FILTER_BY_TYPE: Record<BrowserField['type'], string> = {
  string: 'agTextColumnFilter',
  url: 'agTextColumnFilter',
  boolean: 'agTextColumnFilter',
  'string[]': 'agTextColumnFilter',
  integer: 'agNumberColumnFilter',
  number: 'agNumberColumnFilter',
  date: 'agDateColumnFilter',
  datetime: 'agDateColumnFilter',
};

const TEXT_OPTIONS = [
  'contains',
  'notContains',
  'equals',
  'notEqual',
  'startsWith',
  'endsWith',
  'blank',
  'notBlank',
];
const NUMBER_OPTIONS = [
  'equals',
  'notEqual',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'inRange',
  'blank',
  'notBlank',
];
const DATE_OPTIONS = [
  'equals',
  'notEqual',
  'lessThan',
  'greaterThan',
  'inRange',
  'blank',
  'notBlank',
];

function filterParams(filter: string) {
  const filterOptions =
    filter === 'agNumberColumnFilter'
      ? NUMBER_OPTIONS
      : filter === 'agDateColumnFilter'
        ? DATE_OPTIONS
        : TEXT_OPTIONS;
  return { filterOptions, maxNumConditions: 2, buttons: ['reset'] };
}

/** Grid columns from the schema. Hidden fields: struck through, "(hidden)" in the header. */
export function recordColumns(fields: readonly BrowserField[]): ColDef<RecordRow>[] {
  const fieldCols: ColDef<RecordRow>[] = fields.map((f) => {
    const filter = FILTER_BY_TYPE[f.type] ?? 'agTextColumnFilter';
    return {
      colId: `data.${f.name}`,
      headerName: f.visible ? f.name : `${f.name} (hidden)`,
      headerTooltip: f.visible
        ? `${f.name} · ${f.type}`
        : `${f.name} · ${f.type} · hidden: never sold to buyers${f.pii ? ' (personal data)' : ''}`,
      headerClass: f.visible ? undefined : 'sp-hidden-field',
      cellClass: f.visible ? undefined : 'line-through text-muted',
      valueGetter: (p) => p.data?.data[f.name],
      valueFormatter: (p: ValueFormatterParams<RecordRow>) =>
        p.value == null ? '' : formatValue(p.value),
      type: f.type === 'integer' || f.type === 'number' ? 'rightAligned' : undefined,
      filter,
      filterParams: filterParams(filter),
      minWidth: 120,
    };
  });
  return [
    {
      colId: 'key',
      field: 'key',
      headerName: 'Record',
      pinned: 'left',
      minWidth: 220,
      filter: 'agTextColumnFilter',
      filterParams: filterParams('agTextColumnFilter'),
      cellRenderer: (p: ICellRendererParams<RecordRow>) =>
        p.data ? <span className="font-mono text-xs">{p.data.key}</span> : null,
    },
    ...fieldCols,
    {
      colId: 'version',
      field: 'version',
      headerName: 'Version',
      type: 'rightAligned',
      width: 110,
      filter: 'agNumberColumnFilter',
      filterParams: filterParams('agNumberColumnFilter'),
      cellRenderer: (p: ICellRendererParams<RecordRow>) =>
        p.data ? <span className="tabular-nums">v{p.data.version}</span> : null,
    },
    {
      colId: 'updatedAt',
      field: 'updatedAt',
      headerName: 'Last changed',
      headerTooltip: 'When the record last changed (a new version)',
      sort: 'desc',
      minWidth: 140,
      filter: 'agDateColumnFilter',
      filterParams: filterParams('agDateColumnFilter'),
      tooltipValueGetter: (p) => (p.data ? formatDateTime(p.data.updatedAt) : undefined),
      valueFormatter: (p: ValueFormatterParams<RecordRow>) => ago(p.data?.updatedAt ?? null),
    },
    {
      colId: 'crawledAt',
      field: 'crawledAt',
      headerName: 'Freshness',
      headerTooltip: 'When Spigot last checked the source page',
      minWidth: 140,
      filter: 'agDateColumnFilter',
      filterParams: filterParams('agDateColumnFilter'),
      tooltipValueGetter: (p) => (p.data?.crawledAt ? formatDateTime(p.data.crawledAt) : undefined),
      valueFormatter: (p: ValueFormatterParams<RecordRow>) =>
        p.data?.crawledAt ? `checked ${ago(p.data.crawledAt)}` : 'not checked yet',
    },
  ];
}

export function RecordsBrowserScreen({ client = defaultApi }: { client?: ApiClient }) {
  const [params, setParams] = useSearchParams();
  const wantedSite = params.get('site');
  const wantedDataset = params.get('dataset');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: Loaded }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<{ id: string; key: string } | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    (async () => {
      const { sites } = await client.get<{ sites: SiteSummary[] }>('/api/sites');
      const site = sites.find((s) => s.id === wantedSite) ?? sites[0] ?? null;
      const datasets = site
        ? (
            await client.get<{ datasets: BrowserDataset[] }>(
              `/api/sites/${encodeURIComponent(site.id)}/datasets`,
            )
          ).datasets
        : [];
      return { site, datasets };
    })().then(
      (data) => live && setState({ status: 'ready', data }),
      (error: unknown) => live && setState({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [client, wantedSite, attempt]);

  const data = state.status === 'ready' ? state.data : null;
  const dataset = data
    ? (data.datasets.find((d) => d.id === wantedDataset) ?? data.datasets[0] ?? null)
    : null;

  const columnDefs = useMemo(() => (dataset ? recordColumns(dataset.fields) : []), [dataset]);
  const datasource = useMemo(
    () =>
      dataset
        ? recordsDatasource(client, dataset.id, (b) => setFilteredCount(b.rowCount))
        : undefined,
    [client, dataset],
  );
  useEffect(() => setFilteredCount(null), [dataset?.id]);

  const onRowClicked = useCallback((e: RowClickedEvent<RecordRow>) => {
    if (e.data) setOpen({ id: e.data.id, key: e.data.key });
  }, []);
  const closeDrawer = useCallback(() => setOpen(null), []);

  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <div aria-busy="true" className="rounded-lg border border-line bg-surface p-6">
        <SkeletonText lines={6} />
      </div>
    );
  } else if (state.status === 'error') {
    body = <ErrorBanner error={state.error} onRetry={() => setAttempt((n) => n + 1)} />;
  } else if (!data?.site) {
    body = (
      <EmptyState
        message="Connect your site to browse the records Spigot extracts from it."
        action={{ label: 'Connect your site', to: paths.connectSite }}
      />
    );
  } else if (!dataset) {
    body = (
      <EmptyState
        message="No published record types yet. Publish one to browse its records here."
        action={{ label: 'See record types', to: paths.recordTypes }}
      />
    );
  } else {
    const hiddenCount = dataset.fields.filter((f) => !f.visible).length;
    body = (
      <>
        {isStale(dataset) && <StaleBanner dataset={dataset} />}

        <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3">
            <label className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm font-medium text-ink">
              Record type
              <select
                value={dataset.id}
                onChange={(e) =>
                  setParams((p) => {
                    const next = new URLSearchParams(p);
                    next.set('dataset', e.target.value);
                    return next;
                  })
                }
                className="h-8 max-w-full rounded-md border border-border bg-surface pl-2.5 pr-8 text-sm font-normal text-ink hover:border-muted"
              >
                {data.datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.typeName} ({d.slug}) · {formatCount(d.recordCount)} records
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted tabular-nums" aria-live="polite">
              {filteredCount === null
                ? `${formatCount(dataset.recordCount)} records`
                : filteredCount === dataset.recordCount
                  ? `${formatCount(filteredCount)} records`
                  : `${formatCount(filteredCount)} of ${formatCount(dataset.recordCount)} records match`}
              {hiddenCount > 0 &&
                ` · ${hiddenCount} hidden ${hiddenCount === 1 ? 'field' : 'fields'} shown to you only`}
            </p>
          </div>

          <SpigotGrid<RecordRow>
            bare
            key={dataset.id}
            height={600}
            rowModelType="serverSide"
            serverSideDatasource={datasource}
            cacheBlockSize={BLOCK_SIZE}
            maxBlocksInCache={30}
            columnDefs={columnDefs}
            defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: false }}
            getRowId={(p: GetRowIdParams<RecordRow>) => p.data.id}
            onRowClicked={onRowClicked}
            rowClass="cursor-pointer"
            tooltipShowDelay={400}
            overlayNoRowsTemplate="No records match these filters."
          />
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            Click a record to see its version history.
          </p>
        </div>
      </>
    );
  }

  return (
    <div className={PAGE} data-screen="W07">
      <PageHeader
        title="Records"
        description="Every record Spigot extracted from your site, with its version history."
      />
      {body}
      {open && (
        <VersionDrawer
          recordId={open.id}
          recordKey={open.key}
          client={client}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

function StaleBanner({ dataset }: { dataset: BrowserDataset }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-warning/30 bg-warning-tint px-4 py-3 text-warning"
      data-stale-banner=""
    >
      <p className="font-medium">
        Your site&apos;s layout changed
        {dataset.staleSince ? ` (${formatDateTime(dataset.staleSince)})` : ''}.
      </p>
      <p className="mt-1 text-sm">
        These {dataset.typeName} records may be out of date until you review the updated fields.{' '}
        <Link className="underline" to={href('datasetEditor', { datasetId: dataset.id })}>
          Review in the dataset editor
        </Link>
      </p>
    </div>
  );
}

export default function RecordsBrowserPage() {
  return <RecordsBrowserScreen />;
}
