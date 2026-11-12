import type { AgChartTheme } from 'ag-charts-enterprise';
import { themeQuartz } from 'ag-grid-community';
import { chartPalette, font, tokens, type ThemeMode } from '../theme/tokens';

const v = (name: string) => `var(--sp-${name})`;

/**
 * AG Grid Quartz customised with Spigot tokens (features/13 §6). Colours are CSS variables, so the
 * one theme follows `data-theme` on <html> for light and dark with no re-render.
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
  chromeBackgroundColor: v('surface-2'),
  headerBackgroundColor: v('surface-2'),
  headerTextColor: v('body'),
  headerFontWeight: 600,
  rowHoverColor: v('accent-tint'),
  selectedRowBackgroundColor: v('accent-tint'),
  oddRowBackgroundColor: v('surface'),
  rangeSelectionBorderColor: v('accent'),
  borderRadius: 6,
  wrapperBorderRadius: 8,
  rowHeight: 38,
  headerHeight: 36,
  spacing: 6,
});

/** AG Charts theme for a mode. Charts draw on canvas, so values are hex from tokens.ts. */
export function chartTheme(mode: ThemeMode): AgChartTheme {
  const t = tokens[mode];
  const palette = [...chartPalette[mode]];
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
      chartPadding: 16,
    },
  };
}
