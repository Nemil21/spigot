/**
 * Placeholder body for pre-registered screens (SP-024a). A screen ticket replaces its own page file
 * (keeping the default export) and stops importing this; nobody edits this file or router.tsx.
 */
export function ComingSoon({ title, screen }: { title: string; screen: string }) {
  return (
    <section className="mx-auto max-w-3xl px-6 py-16" data-screen={screen}>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{screen}</p>
      <h1 className="mt-1 text-2xl font-semibold text-ink">{title}</h1>
      <p className="mt-4 text-body">Coming soon</p>
    </section>
  );
}
