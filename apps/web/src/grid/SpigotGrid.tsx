import type { AgGridReactProps } from 'ag-grid-react';
import { AgGridReact } from 'ag-grid-react';
import type { Ref } from 'react';
import { registerAg } from './licence';
import { gridTheme, gridThemeBare } from './theme';

registerAg();

export type SpigotGridProps<TData> = AgGridReactProps<TData> & {
  gridRef?: Ref<AgGridReact<TData>>;
  /** Height of the grid container; AG Grid needs a sized parent. Default 400 px. */
  height?: number | string;
  /** No outer border or radius, for a grid inside a `Panel` that already frames it. */
  bare?: boolean;
};

/** AG Grid Enterprise with the Spigot theme and licence. Every screen grid goes through this. */
export function SpigotGrid<TData>({
  height = 400,
  gridRef,
  bare = false,
  ...props
}: SpigotGridProps<TData>) {
  return (
    <div style={{ height }} className="w-full [&_.ag-cell]:tabular-nums [&_.ag-cell_span.inline-flex]:leading-4">
      <AgGridReact<TData>
        ref={gridRef}
        theme={bare ? gridThemeBare : gridTheme}
        suppressMenuHide={false}
        {...props}
      />
    </div>
  );
}
