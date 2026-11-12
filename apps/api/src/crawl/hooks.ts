/**
 * Crawl hook registries (SP-009a2). The crawler announces what happened; other tickets subscribe,
 * so the crawler has no hard dependency on them (whichever merges second registers its handler):
 *
 * - `onPageChanged(pageId, runId)`: a page's body hash changed, or the page was removed
 *   (404/410 twice, or dropped from the sitemap). SP-014a wires extraction here.
 * - `onRunEnding(runId)`: every page of the run has been fetched and its `onPageChanged` handlers
 *   have returned; the run is about to end (still RUNNING). SP-052a releases pages it held back
 *   for the drift probe here, so their versions are written before the run is terminal. May fire
 *   more than once per run (pings drained at run end, a resumed run).
 * - `onRunFinished(runId)`: a run reached SUCCEEDED / PARTIAL / FAILED (after commit).
 * - `onDiscoveryDone(siteId, runId)`: the site's discovery run moved it VERIFIED → PROPOSING
 *   (after commit, after `onRunFinished`). SP-012a starts the schema agent here.
 *
 * Handlers run in registration order and are awaited. A handler that throws is reported to the
 * `onError` sink and doesn't stop the others or the crawl: the crawler's own writes are already
 * committed and every handler must be idempotent (a resumed run may fire it again).
 */

export type PageChangedHandler = (pageId: string, runId: string) => Promise<void> | void;
export type RunEndingHandler = (runId: string) => Promise<void> | void;
export type RunFinishedHandler = (runId: string) => Promise<void> | void;
export type DiscoveryDoneHandler = (siteId: string, runId: string) => Promise<void> | void;

export type HookName = 'pageChanged' | 'runEnding' | 'runFinished' | 'discoveryDone';
export type HookErrorSink = (hook: HookName, err: unknown) => void;

const handlers = {
  pageChanged: [] as PageChangedHandler[],
  runEnding: [] as RunEndingHandler[],
  runFinished: [] as RunFinishedHandler[],
  discoveryDone: [] as DiscoveryDoneHandler[],
};

let errorSink: HookErrorSink = (hook, err) => {
  console.error(`crawl hook ${hook} failed:`, err instanceof Error ? err.message : err);
};

function register<T>(list: T[], fn: T): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  };
}

/** Each `on*` returns an unsubscribe function. */
export const onPageChanged = (fn: PageChangedHandler) => register(handlers.pageChanged, fn);
export const onRunEnding = (fn: RunEndingHandler) => register(handlers.runEnding, fn);
export const onRunFinished = (fn: RunFinishedHandler) => register(handlers.runFinished, fn);
export const onDiscoveryDone = (fn: DiscoveryDoneHandler) => register(handlers.discoveryDone, fn);

/** Where handler failures go (default: console.error with the message only). */
export function setHookErrorSink(sink: HookErrorSink): void {
  errorSink = sink;
}

async function emit<A extends unknown[]>(
  name: HookName,
  list: ((...args: A) => Promise<void> | void)[],
  args: A,
): Promise<void> {
  for (const fn of [...list]) {
    try {
      await fn(...args);
    } catch (err) {
      errorSink(name, err);
    }
  }
}

export const emitPageChanged = (pageId: string, runId: string) =>
  emit('pageChanged', handlers.pageChanged, [pageId, runId]);
export const emitRunEnding = (runId: string) => emit('runEnding', handlers.runEnding, [runId]);
export const emitRunFinished = (runId: string) =>
  emit('runFinished', handlers.runFinished, [runId]);
export const emitDiscoveryDone = (siteId: string, runId: string) =>
  emit('discoveryDone', handlers.discoveryDone, [siteId, runId]);

/** Tests only: drop every handler. */
export function clearCrawlHooks(): void {
  handlers.pageChanged.length = 0;
  handlers.runEnding.length = 0;
  handlers.runFinished.length = 0;
  handlers.discoveryDone.length = 0;
}
