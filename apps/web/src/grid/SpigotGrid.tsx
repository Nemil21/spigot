import type { AgGridReactProps } from 'ag-grid-react';
import { AgGridReact } from 'ag-grid-react';
import type { Ref } from 'react';
import { registerAg } from './licence';
import { gridTheme } from './theme';

registerAg();

export type SpigotGridProps<TData> = AgGridReactProps<TData> & {
  gridRef?: Ref<AgGridReact<TData>>;
  /** Height of the grid container; AG Grid needs a sized parent. Default 400 px. */
  height?: number | string;
};

/** AG Grid Enterprise with the Spigot theme and licence. Every screen grid goes through this. */
export function SpigotGrid<TData>({ height = 400, gridRef, ...props }: SpigotGridProps<TData>) {
  return (
    <div style={{ height }} className="w-full [&_.ag-cell]:tabular-nums">
      <AgGridReact<TData> ref={gridRef} theme={gridTheme} suppressMenuHide={false} {...props} />
    </div>
  );
}
