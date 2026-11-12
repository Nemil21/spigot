import type { ReactNode } from 'react';

/** Shield mark + "spigot" wordmark (Sora). The logo font is deliberately not the site font. */
export function Logo({ size = 24, suffix }: { size?: number; suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink" aria-label="Spigot">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 2.5 19.5 5.4v6c0 4.4-3 8.2-7.5 10.1C7.5 19.6 4.5 15.8 4.5 11.4v-6z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M12 8s-2.9 3-2.9 5a2.9 2.9 0 0 0 5.8 0c0-2-2.9-5-2.9-5z" fill="currentColor" />
      </svg>
      <span
        aria-hidden="true"
        className="font-[family-name:var(--font-logo)] text-xl font-semibold tracking-tight"
      >
        spigot
      </span>
      {suffix && (
        <span aria-hidden="true" className="text-xs text-muted">
          {suffix}
        </span>
      )}
    </span>
  );
}

const TILE = 32;
/** Same deterministic noise the Figma mock used, so the clusters match the design. */
const noise = (i: number) => (((Math.sin(i * 91.7) * 43758.5453) % 1) + 1) % 1;

function cluster(seed: number, top: number, rows: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    const n = Math.max(
      0,
      Math.round(top - r * (top / rows) * 1.05 + (noise(r + seed) * 2.4 - 1.2)),
    );
    for (let k = 0; k < n; k++) if (noise(r * 31 + k + seed) >= 0.06) cells.push([k, r]);
  }
  return cells;
}

const TOP_RIGHT = cluster(3, 14, 15);
const BOTTOM_LEFT = cluster(11, 16, 15);

/**
 * Full-screen auth backdrop (Figma "Publisher / Log in"): two staircase clusters of outlined
 * tiles in the corners that lift and tilt in 3D on hover (`.tile` in tokens.css), and a soft
 * glow behind the content.
 */
export function AuthBackdrop({ children }: { children: ReactNode }) {
  return (
    <main
      data-auth=""
      className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4 py-12"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 55% 60% at 50% 50%, color-mix(in srgb, var(--sp-accent) 13%, transparent), transparent 70%)',
        }}
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        {TOP_RIGHT.map(([k, r]) => (
          <span
            key={`tr${k}-${r}`}
            className="tile absolute border border-accent/15"
            style={{
              right: k * TILE,
              top: r * TILE,
              width: TILE,
              height: TILE,
              animationDelay: `${(k + r) * 18}ms`,
            }}
          />
        ))}
        {BOTTOM_LEFT.map(([k, r]) => (
          <span
            key={`bl${k}-${r}`}
            className="tile absolute border border-accent/15"
            style={{
              left: k * TILE,
              bottom: r * TILE,
              width: TILE,
              height: TILE,
              animationDelay: `${(k + r) * 18}ms`,
            }}
          />
        ))}
      </div>
      <div className="page-in contents">{children}</div>
    </main>
  );
}
