/**
 * Tiny inline SVG sparkline (W04 "Hits, 24 h" cell and the bot drawer). Plain SVG rather than AG
 * Charts' sparkline renderer: it draws in jsdom, costs nothing per row and follows the theme
 * through `currentColor`.
 */
export function Sparkline({
  points,
  width = 96,
  height = 22,
  label,
}: {
  points: readonly number[];
  width?: number;
  height?: number;
  label: string;
}) {
  const max = Math.max(1, ...points);
  const n = points.length;
  const x = (i: number) => (n <= 1 ? width : (i / (n - 1)) * width);
  const y = (v: number) => height - 1 - (v / max) * (height - 2);
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = n > 0 ? `${line.join(' ')} L${x(n - 1).toFixed(1)},${height} L0,${height} Z` : '';
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-accent"
      data-points={points.join(',')}
    >
      <path d={area} fill="currentColor" opacity={0.15} />
      <path d={line.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
