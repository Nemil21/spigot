/**
 * Placeholder body for pre-registered screens (SP-024a). A screen ticket replaces its own page file
 * (keeping the default export) and stops importing this; nobody edits this file or router.tsx.
 */
export function ComingSoon({ title, screen }: { title: string; screen: string }) {
  return (
    <section
      className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
      data-screen={screen}
    >
      <h1 className="text-2xl font-semibold text-ink">{title}</h1>
      <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center">
        <p className="text-md font-semibold text-ink">Coming soon</p>
        <p className="mt-1 text-sm text-muted">Screen {screen} is on its way.</p>
      </div>
    </section>
  );
}
