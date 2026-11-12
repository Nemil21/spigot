import type { AgChartOptions } from 'ag-charts-enterprise';
import { AgCharts } from 'ag-charts-react';
import { useMemo } from 'react';
import { useThemeMode } from '../theme/mode';
import { registerAg } from './licence';
import { chartTheme } from './theme';

registerAg();

export interface SpigotChartProps {
  options: AgChartOptions;
  /** Default 300 px. */
  height?: number;
  className?: string;
}

/** AG Charts Enterprise with the Spigot palette; switches with light / dark mode. */
export function SpigotChart({ options, height = 300, className }: SpigotChartProps) {
  const mode = useThemeMode();
  const themed = useMemo(
    () => ({ height, ...options, theme: chartTheme(mode) }) as AgChartOptions,
    [options, height, mode],
  );
  return (
    <div className={className} style={{ height }}>
      <AgCharts options={themed} />
    </div>
  );
}
