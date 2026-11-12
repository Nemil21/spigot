/**
 * Loading placeholder (screens.md shared states: Loading = skeletons, never spinners on money
 * numbers). Hidden from assistive tech; put `aria-busy` on the region that is loading.
 */
export function Skeleton({ className = 'h-4 w-24' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      className={`inline-block animate-skeleton rounded-sm bg-surface-2 align-middle dark:bg-border/60 ${className}`}
    />
  );
}

/** A few lines of text-shaped skeletons, the last one shorter. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span aria-hidden="true" className="block space-y-2.5">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`block h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </span>
  );
}
