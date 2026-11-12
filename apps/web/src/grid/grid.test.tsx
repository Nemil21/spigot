// @vitest-environment-options { "url": "https://spigot.example/app" }
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SpigotChart } from './SpigotChart';
import { SpigotGrid } from './SpigotGrid';
import { agLicenceState, isValidAgKey } from './licence';

/**
 * Real key check. Vitest reads VITE_AG_GRID_LICENSE_KEY / AG_GRID_LICENSE_KEY from the shell
 * (CI has none, so the "valid key" case is skipped there). The key is never printed. The page URL is
 * not localhost because AG never shows its watermark on localhost.
 */
const key = process.env.VITE_AG_GRID_LICENSE_KEY || process.env.AG_GRID_LICENSE_KEY || '';
const validKey = isValidAgKey(key);

type Row = { category: string; bot: string; hits: number };
const rows: Row[] = [
  { category: 'AI crawler', bot: 'GPTBot', hits: 120 },
  { category: 'AI crawler', bot: 'ClaudeBot', hits: 80 },
  { category: 'Scraper', bot: 'python-requests', hits: 40 },
];

describe('AG Grid Enterprise + AG Charts', () => {
  it('rejects junk keys without throwing', () => {
    expect(isValidAgKey('')).toBe(false);
    expect(isValidAgKey('not-a-key')).toBe(false);
  });

  it('renders an Enterprise grid (row grouping) with the Spigot theme', async () => {
    render(
      <SpigotGrid<Row>
        rowData={rows}
        columnDefs={[
          { field: 'category', rowGroup: true, hide: true },
          { field: 'bot' },
          { field: 'hits', aggFunc: 'sum' },
        ]}
        groupDefaultExpanded={-1}
      />,
    );
    // Group rows exist only with the Enterprise RowGroupingModule registered.
    expect(await screen.findByText('AI crawler')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.ag-root-wrapper')).not.toBeNull());
  });

  it('renders an AG Charts chart', async () => {
    const { container } = render(
      <SpigotChart
        options={{
          data: [
            { day: 'Mon', ai: 3, scraper: 1 },
            { day: 'Tue', ai: 5, scraper: 2 },
          ],
          series: [
            { type: 'area', xKey: 'day', yKey: 'ai', stacked: true },
            { type: 'area', xKey: 'day', yKey: 'scraper', stacked: true },
          ],
        }}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('.ag-charts-wrapper, canvas')).not.toBeNull(),
    );
  });

  it.runIf(validKey)('shows no licence watermark with a valid key', async () => {
    expect(agLicenceState()).toEqual({ keyPresent: true, valid: true });
    render(<SpigotGrid<Row> rowData={rows} columnDefs={[{ field: 'bot' }]} />);
    await screen.findByText('GPTBot');
    expect(document.querySelector('.ag-watermark:not(.ag-hidden)')).toBeNull();
  });

  it.runIf(!validKey)(
    'shows the watermark without a valid key (sanity check of the probe)',
    async () => {
      render(<SpigotGrid<Row> rowData={rows} columnDefs={[{ field: 'bot' }]} />);
      await screen.findByText('GPTBot');
      expect(agLicenceState()?.valid).toBe(false);
      await waitFor(() =>
        expect(document.querySelector('.ag-watermark:not(.ag-hidden)')).not.toBeNull(),
      );
    },
  );
});
