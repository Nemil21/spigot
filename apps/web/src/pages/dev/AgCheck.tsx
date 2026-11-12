import type { AgChartOptions } from 'ag-charts-enterprise';
import type { ColDef } from 'ag-grid-community';
import { formatCount, formatMicros } from '@spigot/shared';
import { SpigotChart, SpigotGrid, agLicenceState } from '../../grid';
import { setThemeMode, useThemeMode } from '../../theme/mode';

/**
 * Dev check page (SP-024a), `/app/dev/ag`: one AG Grid Enterprise grid (row grouping) and one AG
 * Charts chart with the Spigot theme, plus the licence state. Open it on a non-localhost host
 * (AG never watermarks localhost) to confirm there's no watermark. Not linked from any nav.
 */
type Row = { category: string; bot: string; hits: number; wouldPayMicros: number };
const rows: Row[] = [
  { category: 'AI crawler', bot: 'GPTBot', hits: 1204, wouldPayMicros: 1_806_000 },
  { category: 'AI crawler', bot: 'ClaudeBot', hits: 811, wouldPayMicros: 1_216_500 },
  { category: 'Search', bot: 'Googlebot', hits: 2210, wouldPayMicros: 0 },
  { category: 'Scraper', bot: 'python-requests', hits: 402, wouldPayMicros: 603_000 },
];
const columnDefs: ColDef<Row>[] = [
  { field: 'category', rowGroup: true, hide: true },
  { field: 'bot' },
  {
    field: 'hits',
    aggFunc: 'sum',
    type: 'numericColumn',
    valueFormatter: (p) => formatCount(Number(p.value ?? 0)),
  },
  {
    field: 'wouldPayMicros',
    headerName: 'Would have paid',
    aggFunc: 'sum',
    type: 'numericColumn',
    cellClass: 'tabular italic',
    // @spigot/shared in the browser bundle: the build proves it needs no Node polyfills.
    valueFormatter: (p) => formatMicros(Number(p.value ?? 0)),
  },
];
const chart: AgChartOptions = {
  data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day, i) => ({
    day,
    ai: 120 + i * 40,
    search: 200 + i * 10,
    scraper: 30 + i * 5,
  })),
  series: (['ai', 'search', 'scraper'] as const).map((yKey) => ({
    type: 'area' as const,
    xKey: 'day',
    yKey,
    stacked: true,
  })),
};

export default function AgCheckPage() {
  const mode = useThemeMode();
  const lic = agLicenceState();
  return (
    <section className="space-y-6 p-6" data-screen="dev-ag">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">AG Grid / AG Charts check</h1>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-body"
          onClick={() => setThemeMode(mode === 'dark' ? 'light' : 'dark')}
        >
          {mode === 'dark' ? 'Light' : 'Dark'} mode
        </button>
      </header>
      <p className="text-sm text-body">
        Licence key {lic?.keyPresent ? 'present' : 'missing'} ·{' '}
        <span className={lic?.valid ? 'text-positive' : 'text-danger'}>
          {lic?.valid ? 'valid for AG Grid + AG Charts Enterprise' : 'not a valid Enterprise key'}
        </span>
      </p>
      <SpigotGrid<Row>
        rowData={rows}
        columnDefs={columnDefs}
        groupDefaultExpanded={-1}
        height={260}
      />
      <SpigotChart options={chart} />
    </section>
  );
}
