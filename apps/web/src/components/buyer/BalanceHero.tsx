import { formatCount, formatMicros } from '@spigot/shared/money';
import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '../Skeleton';

const ANIMATION_MS = 700;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

const nextFrame = (cb: (t: number) => void): number =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(() => cb(performance.now()), 16) as unknown as number);
const cancelFrame = (id: number) =>
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id);

/**
 * The balance hero (W11): "$19.94 balance", exact micros in the tooltip. When the balance goes up
 * (a PayPal top-up completed) the number counts up to the new value; it never counts down, and it
 * jumps straight there with reduced motion. Screen readers get the final amount only.
 */
export function BalanceHero({ balanceMicros }: { balanceMicros: number | null }) {
  const [shown, setShown] = useState<number | null>(balanceMicros);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (balanceMicros === null) return;
    const from = shownRef.current;
    if (from === null || balanceMicros <= from || prefersReducedMotion()) {
      setShown(balanceMicros);
      return;
    }
    let frame = 0;
    // Timed from the first frame's own clock (rAF timestamps and performance.now() can differ).
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const p = Math.max(0, Math.min(1, (now - start) / ANIMATION_MS));
      const eased = 1 - (1 - p) ** 3;
      setShown(Math.round(from + (balanceMicros - from) * eased));
      if (p < 1) frame = nextFrame(step);
    };
    frame = nextFrame(step);
    return () => cancelFrame(frame);
  }, [balanceMicros]);

  // Before the first effect runs, show the loaded value as is.
  const display = shown ?? balanceMicros;
  const rising = display !== null && balanceMicros !== null && display < balanceMicros;

  return (
    <section
      aria-labelledby="balance-title"
      className="rounded-[20px] border border-accent/30 bg-gradient-to-br from-accent/25 via-sim/12 to-positive/8 p-7 shadow-card"
    >
      <h2 id="balance-title" className="text-sm font-medium text-muted">
        Prepaid balance, funded with PayPal
      </h2>
      {display === null || balanceMicros === null ? (
        <p className="mt-2" aria-busy="true">
          <Skeleton className="h-10 w-40" />
        </p>
      ) : (
        <p className="mt-2 font-[family-name:var(--font-display)] text-6xl font-light tracking-tight text-ink">
          <span
            className={`tabular-nums ${rising ? 'text-positive' : ''}`}
            title={`${formatCount(balanceMicros)} micros`}
            data-micros={balanceMicros}
            data-testid="balance-amount"
            aria-hidden="true"
          >
            {formatMicros(display)}
          </span>{' '}
          <span className="text-lg font-normal text-muted" aria-hidden="true">
            balance
          </span>
          <span className="sr-only" aria-live="polite">
            {formatMicros(balanceMicros)} balance
          </span>
        </p>
      )}
    </section>
  );
}
