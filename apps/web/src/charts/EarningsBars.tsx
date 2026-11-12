import type { AgChartOptions } from 'ag-charts-enterprise';
import { useMemo } from 'react';
import { SpigotChart } from '../grid';
import type { BarData } from '../pages/earningsData';

/**
 * W08 "earnings per day by dataset" (SP-030b; features/13 §4): AG Charts stacked bars of the
 * publisher's net (after the 20% commission) per UTC day, one stack segment per dataset.
 */
export function EarningsBars({ bars, height = 260 }: { bars: BarData; height?: number }) {
  const options = useMemo<AgChartOptions>(
    () => ({
      data: bars.data,
      series: bars.series.map((s) => ({
        type: 'bar' as const,
        xKey: 'day',
        yKey: s.yKey,
        yName: s.yName,
        stacked: true,
        tooltip: {
          renderer: ({ datum, yKey }: { datum: Record<string, number>; yKey: string }) => ({
            title: s.yName,
            content: `${datum.day as unknown as string}: $${(datum[yKey] ?? 0).toFixed(4)}`,
          }),
        },
      })),
      axes: {
        x: { type: 'category', position: 'bottom' },
        y: {
          type: 'number',
          position: 'left',
          label: { formatter: ({ value }: { value: number }) => `$${value.toFixed(2)}` },
        },
      },
      legend: { position: 'bottom' },
    }),
    [bars],
  );
  return (
    <figure aria-label="Your earnings per day, by dataset">
      <SpigotChart options={options} height={height} />
    </figure>
  );
}
