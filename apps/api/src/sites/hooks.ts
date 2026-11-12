/**
 * Site hook registry (SP-008a), same shape as crawl/hooks.ts:
 *
 * - `onSiteVerified(siteId, publisherId)`: a site moved PENDING_VERIFY → VERIFIED (after commit,
 *   once per site: a repeated or concurrent verify doesn't fire it again). SP-009b subscribes and
 *   starts the discovery crawl.
 *
 * Handlers run in registration order and are awaited. A handler that throws goes to the error
 * sink and doesn't fail the verify call: the transition is already committed.
 */

export type SiteVerifiedHandler = (siteId: string, publisherId: string) => Promise<void> | void;
export type SiteHookErrorSink = (hook: 'siteVerified', err: unknown) => void;

const siteVerified: SiteVerifiedHandler[] = [];

let errorSink: SiteHookErrorSink = (hook, err) => {
  console.error(`site hook ${hook} failed:`, err instanceof Error ? err.message : err);
};

/** Returns an unsubscribe function. */
export function onSiteVerified(fn: SiteVerifiedHandler): () => void {
  siteVerified.push(fn);
  return () => {
    const i = siteVerified.indexOf(fn);
    if (i !== -1) siteVerified.splice(i, 1);
  };
}

export function setSiteHookErrorSink(sink: SiteHookErrorSink): void {
  errorSink = sink;
}

export async function emitSiteVerified(siteId: string, publisherId: string): Promise<void> {
  for (const fn of [...siteVerified]) {
    try {
      await fn(siteId, publisherId);
    } catch (err) {
      errorSink('siteVerified', err);
    }
  }
}

/** Tests only: drop every handler. */
export function clearSiteHooks(): void {
  siteVerified.length = 0;
}
