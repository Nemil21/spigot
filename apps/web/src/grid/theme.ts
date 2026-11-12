import type { AgChartTheme } from 'ag-charts-enterprise';
import { themeQuartz } from 'ag-grid-community';
import { chartPalette, font, tokens, type ThemeMode } from '../theme/tokens';

const v = (name: string) => `var(--sp-${name})`;

/**
 * AG Grid Quartz customised with Spigot tokens (features/13 §6). Colours are CSS variables, so the
 * one theme follows `data-theme` on <html> for light and dark with no re-render.
 *
 * The look is a quiet ledger: headers sit on the same surface as the rows with muted labels, rows
 * are divided by hairlines only (no zebra, no column rules), hover is a faint wash and only the
 * selected row carries the accent. Tabular figures for cells are set on the wrapper in SpigotGrid.tsx.
 */
export const gridTheme = themeQuartz.withParams({
  fontFamily: font.sans,
  fontSize: 13,
  backgroundColor: v('surface'),
  foregroundColor: v('ink'),
  textColor: v('ink'),
  subtleTextColor: v('muted'),
  accentColor: v('accent'),
  borderColor: v('line'),
  chromeBackgroundColor: v('surface'),
  headerBackgroundColor: v('surface'),
  headerTextColor: v('muted'),
  headerFontSize: 12,
  headerFontWeight: 500,
  headerColumnBorder: false,
  headerRowBorder: { color: v('border') },
  rowBorder: { color: v('line') },
  columnBorder: false,
  headerColumnResizeHandleColor: v('line'),
  rowHoverColor: v('surface-2'),
  selectedRowBackgroundColor: v('accent-tint'),
  oddRowBackgroundColor: v('surface'),
  rangeSelectionBorderColor: v('accent'),
  borderRadius: 6,
  wrapperBorderRadius: 10,
  wrapperBorder: { color: v('line') },
  iconSize: 14,
  rowHeight: 38,
  headerHeight: 36,
  spacing: 6,
  cellHorizontalPaddingScale: 1.4,
  dataFontSize: 13,
  menuBackgroundColor: v('surface'),
  menuShadow: 'var(--shadow-overlay)',
  inputFocusBorder: { color: v('focus') },
});

/** For a grid that sits inside a panel: the panel draws the frame, so the grid has none. */
export const gridThemeBare = gridTheme.withParams({ wrapperBorder: false, wrapperBorderRadius: 0 });

/** AG Charts theme for a mode. Charts draw on canvas, so values are hex from tokens.ts. */
export function chartTheme(mode: ThemeMode): AgChartTheme {
  const t = tokens[mode];
  const palette = [...chartPalette[mode]];
  const axisLabel = { color: t.muted, fontSize: 11 };
  return {
    baseTheme: mode === 'dark' ? 'ag-default-dark' : 'ag-default',
    palette: { fills: palette, strokes: palette },
    params: {
      fontFamily: font.sans,
      fontSize: 12,
      textColor: t.ink,
      subtleTextColor: t.muted,
      backgroundColor: t.surface,
      axisLineColor: t.border,
      axisLabelColor: t.muted,
      tooltipBackgroundColor: t.surface,
      tooltipTextColor: t.ink,
      gridLineColor: t.line,
      chartPadding: 8,
    },
    overrides: {
      common: {
        legend: {
          item: {
            marker: { shape: 'square', size: 8 },
            label: { color: t.body, fontSize: 12 },
          },
        },
        axes: {
          number: {
            line: { enabled: false },
            label: axisLabel,
            gridLine: { style: [{ stroke: t.line, lineDash: [3, 3] }] },
          },
          category: {
            line: { stroke: t.border },
            label: axisLabel,
            gridLine: { enabled: false },
          },
          time: {
            line: { stroke: t.border },
            label: axisLabel,
            gridLine: { enabled: false },
          },
        },
      },
      area: { series: { fillOpacity: 0.22, strokeWidth: 1.5 } },
      bar: { series: { cornerRadius: 2 } },
    },
  };
}
