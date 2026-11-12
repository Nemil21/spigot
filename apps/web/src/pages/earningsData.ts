/**
 * W08 Earnings data (SP-030b). The page makes one read,
 * `GET /api/publishers/me/earnings?groupBy=buyer,dataset,channel,day`, and derives everything on
 * screen from it: the KPI tiles are the API's own `kpis`; the grid's leaf rows are those rows
 * summed over `day`; the bars are the same rows summed over buyer and channel. One snapshot, so
 * the grid's grouped totals and the bars always add up to the tiles.
 */

export type Channel = 'REST' | 'MCP';

/** `GET /api/publishers/me/earnings` (api.md; apps/api/src/reports/earnings.ts). */
export interface EarningsKpis {
  grossMicros: number;
  commissionMicros: number;
  netMicros: number;
  payableMicros: number;
  calls: number;
  recordsSold: number;
  changesSold: number;
  buyers: number;
}

export interface EarningsApiRow {
  key: string;
  id: string;
  dims: {
    buyer?: { id: string; name: string };
    dataset?: { id: string; key: string };
    day?: string;
    channel?: Channel;
  };
  isSimulated: boolean;
  calls: number;
  records: number;
  changes: number;
  grossMicros: number;
  commissionMicros: number;
  netMicros: number;
  channels: Record<Channel, { calls: number; grossMicros: number }>;
}

export interface Earnings {
  kpis: EarningsKpis;
  rows: EarningsApiRow[];
}

export const EARNINGS_GROUP_BY = 'buyer,dataset,channel,day';

export function earningsPath(includeSim: boolean): string {
  return `/api/publishers/me/earnings?groupBy=${EARNINGS_GROUP_BY}&includeSim=${includeSim}`;
}

/** One grid leaf: a buyer's calls to one dataset over one channel (REST or MCP), SIM apart. */
export interface EarningsGridRow {
  /** Stable across refetches, so AG Grid updates rows in place and can flash them. */
  rowId: string;
  buyerId: string;
  buyer: string;
  datasetId: string;
  dataset: string;
  channel: Channel;
  isSimulated: boolean;
  calls: number;
  records: number;
  changes: number;
  grossMicros: number;
  commissionMicros: number;
  netMicros: number;
  /** Latest UTC day with a charge (`YYYY-MM-DD`). */
  lastDay: string;
}

export function gridRowId(r: {
  buyerId: string;
  datasetId: string;
  channel: Channel;
  isSimulated: boolean;
}): string {
  return `${r.buyerId}|${r.datasetId}|${r.channel}|${r.isSimulated ? 'sim' : 'real'}`;
}

/** Sum the API rows over `day` into grid leaves (gross first, as the API ranks). */
export function toGridRows(rows: readonly EarningsApiRow[]): EarningsGridRow[] {
  const out = new Map<string, EarningsGridRow>();
  for (const r of rows) {
    const { buyer, dataset, channel, day = '' } = r.dims;
    if (!buyer || !dataset || !channel) continue;
    const base = {
      buyerId: buyer.id,
      datasetId: dataset.id,
      channel,
      isSimulated: r.isSimulated,
    };
    const rowId = gridRowId(base);
    const cur = out.get(rowId);
    if (cur) {
      cur.calls += r.calls;
      cur.records += r.records;
      cur.changes += r.changes;
      cur.grossMicros += r.grossMicros;
      cur.commissionMicros += r.commissionMicros;
      cur.netMicros += r.netMicros;
      if (day > cur.lastDay) cur.lastDay = day;
    } else {
      out.set(rowId, {
        rowId,
        ...base,
        buyer: buyer.name,
        dataset: dataset.key,
        calls: r.calls,
        records: r.records,
        changes: r.changes,
        grossMicros: r.grossMicros,
        commissionMicros: r.commissionMicros,
        netMicros: r.netMicros,
        lastDay: day,
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => b.grossMicros - a.grossMicros || a.rowId.localeCompare(b.rowId),
  );
}

/**
 * Leaves that are new or sold more since `prev` (the rows to flash after a `call.charged`). The
 * first load flashes nothing.
 */
export function changedRowIds(
  prev: readonly EarningsGridRow[] | null,
  next: readonly EarningsGridRow[],
): string[] {
  if (!prev) return [];
  const before = new Map(prev.map((r) => [r.rowId, r]));
  return next
    .filter((r) => {
      const b = before.get(r.rowId);
      return !b || b.calls !== r.calls || b.grossMicros !== r.grossMicros;
    })
    .map((r) => r.rowId);
}

export interface BarSeries {
  /** Field in each datum (`d0`, `d1`…): dataset keys contain `/`, which isn't a safe field name. */
  yKey: string;
  /** Dataset key, e.g. `bluebonnet/listings`. */
  yName: string;
}

export interface BarData {
  /** One datum per UTC day, oldest first: `{ day, d0: dollars, d1: dollars, … }`. */
  data: Array<Record<string, string | number>>;
  series: BarSeries[];
}

/** Earnings (net, in dollars) per day, stacked by dataset. */
export function toBarData(rows: readonly EarningsApiRow[]): BarData {
  const datasets = new Map<string, BarSeries>();
  const days = new Map<string, Record<string, string | number>>();
  for (const r of rows) {
    const { dataset, day } = r.dims;
    if (!dataset || !day) continue;
    let s = datasets.get(dataset.id);
    if (!s) {
      s = { yKey: `d${datasets.size}`, yName: dataset.key };
      datasets.set(dataset.id, s);
    }
    let datum = days.get(day);
    if (!datum) {
      datum = { day };
      days.set(day, datum);
    }
    datum[s.yKey] = Number(datum[s.yKey] ?? 0) + r.netMicros / 1_000_000;
  }
  const series = [...datasets.values()];
  const data = [...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  // Every datum carries every series (0 when nothing sold), so the stacks line up.
  for (const d of data) for (const s of series) d[s.yKey] ??= 0;
  return { data, series };
}

/** Gross sold to SIM buyers, for the "incl. … SIM" hint on the tiles. */
export function simGrossMicros(rows: readonly EarningsApiRow[]): number {
  return rows.reduce((t, r) => (r.isSimulated ? t + r.grossMicros : t), 0);
}
