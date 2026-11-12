import type { AgChartOptions } from 'ag-charts-enterprise';
import { useMemo } from 'react';
import { SpigotChart } from '../grid';
import { CHART_CATEGORIES, categoryLabel } from '../overview/labels';
import type { BotsReport } from '../overview/types';

const STEP_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

export type HitsPoint = { time: Date } & Record<string, number | Date>;

/**
 * One point per bucket across the whole range, one key per bot category (HUMAN left out: people
 * outnumber bots ~30:1 and would flatten the chart). Buckets with no hits are 0, so the stacked
 * area doesn't interpolate over quiet hours.
 */
export function pivotSeries(
  report: Pick<BotsReport, 'range' | 'series'>,
  categories: readonly string[] = CHART_CATEGORIES,
): HitsPoint[] {
  const step = STEP_MS[report.range.bucketSize];
  const from = Date.parse(report.range.from);
  const to = Date.parse(report.range.to);
  const start = Math.floor(from / step) * step;
  const byTime = new Map<number, HitsPoint>();
  for (let t = start; t < to; t += step) {
    const p = { time: new Date(t) } as HitsPoint;
    for (const c of categories) p[c] = 0;
    byTime.set(t, p);
  }
  for (const s of report.series) {
    if (!categories.includes(s.category)) continue;
    const p = byTime.get(Date.parse(s.bucket));
    if (p) p[s.category] = (p[s.category] as number) + s.hits;
  }
  return [...byTime.values()];
}

/** W04 stacked area of bot hits by category (AG Charts Enterprise). */
export function HitsArea({
  report,
  categories = CHART_CATEGORIES,
  height = 260,
}: {
  report: Pick<BotsReport, 'range' | 'series'>;
  categories?: readonly string[];
  height?: number;
}) {
  const options = useMemo<AgChartOptions>(() => {
    const data = pivotSeries(report, categories);
    return {
      data,
      series: categories.map((c) => ({
        type: 'area' as const,
        xKey: 'time',
        yKey: c,
        yName: categoryLabel(c),
        stacked: true,
        marker: { enabled: false },
      })),
      axes: {
        x: { type: 'time', position: 'bottom' },
        y: { type: 'number', position: 'left' },
      },
      legend: { position: 'bottom' },
    };
  }, [report, categories]);
  return (
    <div aria-label="Bot hits by category over time" role="figure">
      <SpigotChart options={options} height={height} />
    </div>
  );
}
