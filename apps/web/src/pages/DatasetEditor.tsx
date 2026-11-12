import { formatCount } from '@spigot/shared/money';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, api as defaultApi, type ApiClient } from '../api/client';
import { useEventStream, type EventStreamOptions } from '../api/sse';
import { ErrorBanner, Skeleton, SkeletonText, errorMessage } from '../components';
import { paths } from '../routes';
import { CopyButton, EndpointPreview } from './dataset-editor/EndpointPreview';
import { FieldList } from './dataset-editor/FieldList';
import { PriceInputs } from './dataset-editor/PriceInputs';
import { SchemaGrid } from './dataset-editor/SchemaGrid';
import { StaleBanner } from './dataset-editor/StaleBanner';
import {
  NO_VISIBLE_FIELDS,
  PRICE_EDITABLE,
  PUBLISHABLE,
  RIGHTS_NOT_TICKED,
  applyEdits,
  editsOf,
  endpointPath,
  fieldChanges,
  microsToPer1000Input,
  per1000InputToMicros,
  priceError,
  toggleFilterable,
  toggleVisible,
  type ApproveResult,
  type CrawlRun,
  type DatasetDetail,
  type DatasetStatus,
  type FieldEdits,
  type PatchBody,
  type PatchResult,
  type ReinferResult,
} from './dataset-editor/model';

export const EVENTS_URL = '/api/publishers/me/events';
/** While the APPROVE run extracts, the page re-reads its progress this often (SSE also nudges). */
export const PROGRESS_POLL_MS = 1500;
/** While re-inference runs (SP-052b), the page re-reads the dataset this often (SSE also nudges). */
export const REINFER_POLL_MS = 5000;

type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready' };

/** What the editor last saved: the PATCH diff is taken against this, not the first load. */
interface Baseline {
  edits: FieldEdits;
  perRecordMicros: number;
  perChangeMicros: number;
  /** The schema version Publish approves (a PATCH with field edits makes a new one). */
  schemaVersionId: string | null;
  /**
   * Whether that version can still be approved (PROPOSED). After drift with no re-inference yet,
   * a LIVE_STALE dataset's latest version is the active APPROVED one: approving it is a 409.
   */
  versionApprovable: boolean;
}

type Phase =
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'approving' }
  | {
      kind: 'publishing';
      runId: string;
      endpoint: string;
      siteId: string | null;
      run: CrawlRun | null;
    }
  | { kind: 'published'; endpoint: string; run: CrawlRun | null };

type Notice = { tone: 'info' | 'danger'; text: ReactNode } | null;

const STATUS_LABEL: Record<DatasetStatus, string> = {
  PROPOSED: 'Proposed',
  LIVE: 'Live',
  LIVE_STALE: 'Live · layout changed',
  UNPUBLISHED: 'Unpublished',
  REJECTED: 'Rejected',
};

const STATUS_TONE: Record<DatasetStatus, string> = {
  PROPOSED: 'bg-info-tint text-info',
  LIVE: 'bg-positive-tint text-positive',
  LIVE_STALE: 'bg-warning-tint text-warning',
  UNPUBLISHED: 'bg-surface-2 text-body',
  REJECTED: 'bg-surface-2 text-body',
};

function baselineOf(d: DatasetDetail): Baseline {
  return {
    edits: editsOf(d.fields),
    perRecordMicros: d.prices.perRecordMicros,
    perChangeMicros: d.prices.perChangeMicros,
    schemaVersionId: d.latestSchemaVersion?.id ?? null,
    versionApprovable: d.latestSchemaVersion?.status === 'PROPOSED',
  };
}

export interface DatasetEditorScreenProps {
  datasetId: string;
  client?: ApiClient;
  /** Tests pass a fake EventSource. */
  sse?: EventStreamOptions & { enabled?: boolean };
  pollMs?: number;
}

/**
 * W06 Dataset editor + publish (screens.md §W06; features/13 §3, 06 §Pricing, 04 §6; SP-029).
 * The owner toggles fields (the sample grid updates at once), sets prices, ticks the rights
 * attestation and publishes: PATCH (only if something changed) → approve → the APPROVE run's
 * re-extract progress → the live card. A LIVE dataset shows its live card, editable prices and
 * Unpublish; its fields change only through a new approved schema (SP-014a).
 */
export function DatasetEditorScreen({
  datasetId,
  client = defaultApi,
  sse,
  pollMs = PROGRESS_POLL_MS,
}: DatasetEditorScreenProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [edits, setEdits] = useState<FieldEdits>({});
  const [perRecord, setPerRecord] = useState('');
  const [perChange, setPerChange] = useState('');
  const [rights, setRights] = useState(false);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const busy = useRef(false);

  const base = `/api/datasets/${encodeURIComponent(datasetId)}`;

  /** Read the dataset and reset the form to it. */
  const reload = useCallback(async () => {
    const d = await client.get<DatasetDetail>(base);
    const b = baselineOf(d);
    setDetail(d);
    setBaseline(b);
    setEdits(b.edits);
    setPerRecord(microsToPer1000Input(b.perRecordMicros));
    setPerChange(microsToPer1000Input(b.perChangeMicros));
    return d;
  }, [client, base]);

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    reload().then(
      () => live && setLoad({ status: 'ready' }),
      (error: unknown) => live && setLoad({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [reload, attempt]);

  // --- derived ---------------------------------------------------------------------------------

  const shownFields = useMemo(
    () => (detail ? applyEdits(detail.fields, edits) : []),
    [detail, edits],
  );
  const perRecordMicros = per1000InputToMicros(perRecord);
  const perChangeMicros = per1000InputToMicros(perChange);
  const pricesValid = !priceError(perRecordMicros) && !priceError(perChangeMicros);
  const visibleCount = shownFields.filter((f) => f.visible).length;

  const status = detail?.status;
  const fieldsEditable = !!status && PUBLISHABLE.includes(status) && phase.kind === 'editing';
  const pricesEditable =
    !!status &&
    PRICE_EDITABLE.includes(status) &&
    (phase.kind === 'editing' || phase.kind === 'published');

  function patchBody({ fields }: { fields: boolean }): PatchBody | null {
    if (!baseline || perRecordMicros === null || perChangeMicros === null) return null;
    const body: PatchBody = {};
    const changes = fieldChanges(baseline.edits, edits);
    if (fields && changes.length && status && PUBLISHABLE.includes(status)) body.fields = changes;
    if (perRecordMicros !== baseline.perRecordMicros) body.perRecordMicros = perRecordMicros;
    if (perChangeMicros !== baseline.perChangeMicros) body.perChangeMicros = perChangeMicros;
    return Object.keys(body).length ? body : null;
  }

  /** PATCH what changed and move the baseline, so a retry never re-sends (or re-versions) it. */
  async function saveEdits({ fields }: { fields: boolean }): Promise<string | null> {
    const body = patchBody({ fields });
    let versionId = baseline?.schemaVersionId ?? null;
    if (!body) return versionId;
    const r = await client.patch<PatchResult>(base, body);
    if (r.schemaVersion) versionId = r.schemaVersion.id;
    setBaseline({
      edits: body.fields ? edits : (baseline?.edits ?? edits),
      perRecordMicros: r.dataset.perRecordMicros,
      perChangeMicros: r.dataset.perChangeMicros,
      schemaVersionId: versionId,
      versionApprovable: r.schemaVersion ? true : (baseline?.versionApprovable ?? false),
    });
    return versionId;
  }

  async function siteIdFor(slug: string | null): Promise<string | null> {
    if (!slug) return null;
    try {
      const { sites } = await client.get<{ sites: { id: string; slug: string }[] }>('/api/sites');
      return sites.find((s) => s.slug === slug)?.id ?? null;
    } catch {
      return null;
    }
  }

  // --- publish ---------------------------------------------------------------------------------

  async function publish() {
    setTried(true);
    setNotice(null);
    if (!detail || busy.current) return;
    if (visibleCount === 0 || !rights || !pricesValid) return;
    if (!baseline?.versionApprovable && fieldChanges(baseline?.edits ?? {}, edits).length === 0) {
      return;
    }
    busy.current = true;
    try {
      setPhase({ kind: 'saving' });
      const versionId = await saveEdits({ fields: true });
      if (!versionId) throw new Error('This dataset has no schema to publish yet.');
      setPhase({ kind: 'approving' });
      const a = await client.post<ApproveResult>(`${base}/approve`, {
        schemaVersionId: versionId,
        rightsAttested: true,
      });
      const siteId = await siteIdFor(detail.siteSlug);
      if (!siteId) {
        // No way to watch the run: go straight to live; extraction carries on server-side.
        setPhase({ kind: 'published', endpoint: a.endpoint, run: null });
        await reload().catch(() => undefined);
        return;
      }
      setPhase({
        kind: 'publishing',
        runId: a.crawlRunId,
        endpoint: a.endpoint,
        siteId,
        run: null,
      });
    } catch (err) {
      setPhase({ kind: 'editing' });
      if (err instanceof ApiError && err.code === 'STATE_CONFLICT') {
        // Published elsewhere (another tab) or the version moved on: show the current state.
        await reload().catch(() => undefined);
      }
      setNotice({ tone: 'danger', text: errorMessage(err) });
    } finally {
      busy.current = false;
    }
  }

  const publishing = phase.kind === 'publishing' ? phase : null;

  /** Re-read the APPROVE run; on SUCCEEDED / FAILED show the live card. */
  const pollRun = useCallback(async () => {
    if (!publishing?.siteId) return;
    const { runs } = await client.get<{ runs: CrawlRun[] }>(
      `/api/sites/${encodeURIComponent(publishing.siteId)}/crawl-runs?limit=20`,
    );
    const run = runs.find((r) => r.id === publishing.runId) ?? null;
    if (run && (run.status === 'SUCCEEDED' || run.status === 'FAILED')) {
      setPhase({ kind: 'published', endpoint: publishing.endpoint, run });
      await reload().catch(() => undefined);
    } else {
      setPhase((p) =>
        p.kind === 'publishing' && p.runId === publishing.runId ? { ...p, run } : p,
      );
    }
  }, [client, publishing?.siteId, publishing?.runId, publishing?.endpoint, reload]);

  const quietPoll = useCallback(() => {
    pollRun().catch(() => undefined); // The next tick or event tries again.
  }, [pollRun]);

  const pollRef = useRef(quietPoll);
  pollRef.current = quietPoll;
  const runId = publishing?.runId;
  useEffect(() => {
    if (!runId) return;
    // Restart only when a new run starts, not on each progress update.
    pollRef.current();
    const t = setInterval(() => pollRef.current(), pollMs);
    return () => clearInterval(t);
  }, [runId, pollMs]);

  useEventStream(
    publishing ? EVENTS_URL : null,
    {
      onEvent: (m) => {
        const ids = (m.data as { ids?: unknown } | null)?.ids;
        if (
          m.type === 'dataset.extract.progress' &&
          (!Array.isArray(ids) || ids.length === 0 || ids.includes(publishing?.runId))
        ) {
          quietPoll();
        }
      },
      onRefetch: quietPoll,
    },
    { ...sse, events: ['dataset.extract.progress'] },
  );

  // --- re-inference (SP-052b) -----------------------------------------------------------------

  // Re-read while Claude re-proposes the extractor; `proposal.ready` brings the new version.
  const reinferPending =
    detail?.status === 'LIVE_STALE' &&
    phase.kind === 'editing' &&
    (!detail.reinference ||
      detail.reinference.state === 'QUEUED' ||
      detail.reinference.state === 'RUNNING');
  const reloadQuietly = useCallback(() => {
    reload().catch(() => undefined); // The next tick or event tries again.
  }, [reload]);
  useEffect(() => {
    if (!reinferPending) return;
    const t = setInterval(reloadQuietly, REINFER_POLL_MS);
    return () => clearInterval(t);
  }, [reinferPending, reloadQuietly]);
  useEventStream(
    reinferPending ? EVENTS_URL : null,
    {
      onEvent: (m) => {
        const ids = (m.data as { ids?: unknown } | null)?.ids;
        if (m.type === 'proposal.ready' && (!Array.isArray(ids) || ids.includes(datasetId))) {
          reloadQuietly();
        }
      },
      onRefetch: reloadQuietly,
    },
    { ...sse, events: ['proposal.ready'] },
  );

  async function retryReinfer() {
    if (retrying) return;
    setRetrying(true);
    setNotice(null);
    try {
      await client.post<ReinferResult>(`${base}/reinfer`, {});
      await reload();
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setRetrying(false);
    }
  }

  // --- other actions ---------------------------------------------------------------------------

  async function savePrices() {
    if (busy.current || !pricesValid) return;
    busy.current = true;
    setNotice(null);
    setPhase({ kind: 'saving' });
    try {
      await saveEdits({ fields: false }); // Prices only; field edits go out with Publish.
      setNotice({
        tone: 'info',
        text: 'Prices saved. New calls use them; past charges keep theirs.',
      });
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setPhase((p) => (p.kind === 'saving' ? { kind: 'editing' } : p));
      busy.current = false;
    }
  }

  async function unpublish() {
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
    try {
      await client.post(`${base}/unpublish`, {});
      setConfirmUnpublish(false);
      setPhase({ kind: 'editing' });
      await reload();
      setNotice({
        tone: 'info',
        text: 'Unpublished. Buyers get “dataset unpublished” and your gate stops sending bots here.',
      });
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err) });
    } finally {
      busy.current = false;
    }
  }

  // --- render ----------------------------------------------------------------------------------

  if (load.status === 'error') {
    return (
      <Frame title="Dataset editor">
        <ErrorBanner error={load.error} onRetry={() => setAttempt((n) => n + 1)} />
      </Frame>
    );
  }
  if (load.status === 'loading' || !detail || !baseline) {
    return (
      <Frame title="Dataset editor">
        <div aria-busy="true" className="rounded-lg border border-line bg-surface p-5 shadow-card">
          <Skeleton className="mb-4 h-6 w-64" />
          <SkeletonText lines={6} />
        </div>
      </Frame>
    );
  }

  const path = endpointPath(detail);
  const endpointUrl =
    (phase.kind === 'published' || phase.kind === 'publishing' ? phase.endpoint : null) ??
    detail.endpoint ??
    path;
  const isLive = detail.status === 'LIVE' || detail.status === 'LIVE_STALE';
  const publishable = PUBLISHABLE.includes(detail.status);
  // Something approve can take: a PROPOSED version, or field edits that PATCH turns into one.
  const hasApprovable =
    baseline.versionApprovable || fieldChanges(baseline.edits, edits).length > 0;
  const dirtyPrices =
    perRecordMicros !== baseline.perRecordMicros || perChangeMicros !== baseline.perChangeMicros;
  const working = phase.kind === 'saving' || phase.kind === 'approving' || !!publishing;

  return (
    <Frame
      title={`${detail.typeName} · ${formatCount(detail.recordCount)} records`}
      status={detail.status}
    >
      {detail.status === 'LIVE_STALE' && (
        <StaleBanner detail={detail} retrying={retrying} onRetry={() => void retryReinfer()} />
      )}

      {notice && (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={`rounded-md px-4 py-3 text-sm ${
            notice.tone === 'danger' ? 'bg-danger-tint text-danger' : 'bg-info-tint text-info'
          }`}
        >
          {notice.text}
        </p>
      )}

      {publishing && <ProgressCard run={publishing.run} recordCount={detail.recordCount} />}

      {(phase.kind === 'published' || (isLive && !publishing)) && (
        <LiveCard
          endpoint={endpointUrl}
          run={phase.kind === 'published' ? phase.run : null}
          onUnpublish={() => setConfirmUnpublish(true)}
        />
      )}

      {confirmUnpublish && (
        <div
          role="alertdialog"
          aria-label="Unpublish dataset"
          className="rounded-lg border border-danger bg-surface p-4 shadow-card"
        >
          <p className="text-sm text-ink">
            Unpublish {detail.typeName}? Buyers can no longer read it and your gate stops sending
            bots to it. Past charges stay as they are.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void unpublish()}
              className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-on-accent"
            >
              Unpublish
            </button>
            <button
              type="button"
              onClick={() => setConfirmUnpublish(false)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-body"
            >
              Keep it live
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section
          aria-label="Fields"
          className="rounded-lg border border-line bg-surface p-4 shadow-card"
        >
          <h2 className="text-sm font-semibold text-ink">
            Fields{' '}
            <span className="font-normal text-muted">
              · {visibleCount} of {shownFields.length} sold
            </span>
          </h2>
          {isLive && !publishable && (
            <p className="mt-1 text-xs text-muted">
              Fields of a live dataset change only through a new approved schema.
            </p>
          )}
          {visibleCount === 0 && (
            <p role="alert" className="mt-2 text-sm text-danger" data-validation="no-visible">
              {NO_VISIBLE_FIELDS}
            </p>
          )}
          <FieldList
            fields={shownFields}
            editable={fieldsEditable}
            onToggleVisible={(n) => setEdits((e) => toggleVisible(e, n))}
            onToggleFilterable={(n) => setEdits((e) => toggleFilterable(e, n))}
          />
        </section>

        <div className="min-w-0 space-y-4">
          <section
            aria-label="Sample rows"
            className="rounded-lg border border-line bg-surface p-4 shadow-card"
          >
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Sample rows{' '}
              <span className="font-normal text-muted">· {detail.sampleRows.length}</span>
            </h2>
            <SchemaGrid fields={shownFields} rows={detail.sampleRows} />
          </section>

          <section
            aria-label="Pricing"
            className="rounded-lg border border-line bg-surface p-4 shadow-card"
          >
            <h2 className="mb-3 text-sm font-semibold text-ink">Price</h2>
            <PriceInputs
              perRecord={perRecord}
              perChange={perChange}
              perRecordMicros={perRecordMicros}
              perChangeMicros={perChangeMicros}
              recordCount={detail.recordCount}
              slug={detail.slug}
              disabled={!pricesEditable}
              onChange={(n) => {
                if (n.perRecord !== undefined) setPerRecord(n.perRecord);
                if (n.perChange !== undefined) setPerChange(n.perChange);
              }}
            />
            {isLive && pricesEditable && (
              <button
                type="button"
                onClick={() => void savePrices()}
                disabled={!dirtyPrices || !pricesValid || working}
                className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
              >
                Save prices
              </button>
            )}
          </section>

          <section
            aria-label="Endpoint preview"
            className="rounded-lg border border-line bg-surface p-4 shadow-card"
          >
            <h2 className="mb-3 text-sm font-semibold text-ink">What buyers get</h2>
            <EndpointPreview
              path={path}
              fields={shownFields}
              rows={detail.sampleRows}
              perRecordMicros={perRecordMicros ?? baseline.perRecordMicros}
            />
          </section>

          {publishable && (
            <section
              aria-label="Publish"
              className="rounded-lg border border-line bg-surface p-4 shadow-card"
            >
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={rights}
                  disabled={working}
                  onChange={(e) => setRights(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>I own this content or have the right to license these fields.</span>
              </label>
              {tried && !rights && (
                <p role="alert" className="mt-1 text-sm text-danger" data-validation="rights">
                  {RIGHTS_NOT_TICKED}
                </p>
              )}
              <button
                type="button"
                onClick={() => void publish()}
                disabled={working || visibleCount === 0 || !pricesValid || !hasApprovable}
                className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-50"
              >
                {phase.kind === 'saving'
                  ? 'Saving new version…'
                  : phase.kind === 'approving'
                    ? 'Publishing…'
                    : publishing
                      ? 'Extracting…'
                      : 'Publish'}
              </button>
              {!hasApprovable && (
                <p className="mt-2 text-sm text-muted" data-validation="nothing-to-approve">
                  Nothing new to publish: this schema is already live. Change which fields you sell
                  to publish a new version, or use Save prices for a price change.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </Frame>
  );
}

function ProgressCard({ run, recordCount }: { run: CrawlRun | null; recordCount: number }) {
  const total = run?.pagesTotal ?? null;
  const done = run?.pagesFetched ?? 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <section
      role="status"
      aria-label="Publishing"
      className="rounded-lg border border-accent bg-accent-tint p-4"
    >
      <p className="text-sm font-medium text-ink">
        Publishing: extracting all pages
        {total
          ? ` · ${formatCount(done)} of ${formatCount(total)}`
          : ` (about ${formatCount(recordCount)})`}
      </p>
      <div
        role="progressbar"
        aria-label="Extraction progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface"
      >
        <div
          className={`h-full bg-accent ${pct === null ? 'w-1/4 animate-pulse' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        No AI calls: the approved extractor runs on every page.
      </p>
    </section>
  );
}

function LiveCard({
  endpoint,
  run,
  onUnpublish,
}: {
  endpoint: string;
  run: CrawlRun | null;
  onUnpublish: () => void;
}) {
  return (
    <section
      aria-label="Live"
      data-live-card=""
      className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-positive bg-positive-tint p-4"
    >
      <div className="min-w-0 space-y-2">
        <p className="text-base font-semibold text-positive">
          Live. Your gate now sends bots here.
        </p>
        <div className="flex items-center gap-2">
          <code
            className="min-w-0 truncate rounded bg-surface px-2 py-1 font-mono text-xs text-ink"
            data-live-endpoint=""
          >
            {endpoint}
          </code>
          <CopyButton text={endpoint} label="Copy endpoint" />
        </div>
        {run?.status === 'FAILED' && (
          <p role="alert" className="text-sm text-warning">
            Extraction stopped early{run.error ? ` (${run.error})` : ''}. The dataset is live; the
            next crawl extracts the rest.
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onUnpublish}
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-body hover:bg-surface-2"
      >
        Unpublish
      </button>
    </section>
  );
}

function Frame({
  title,
  status,
  children,
}: {
  title: string;
  status?: DatasetStatus;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl space-y-4" data-screen="W06">
      <Link to={paths.recordTypes} className="text-sm text-accent hover:underline">
        ← Record types
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {status && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
            data-dataset-status={status}
          >
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export default function DatasetEditorPage() {
  const { datasetId = '' } = useParams();
  return <DatasetEditorScreen key={datasetId} datasetId={datasetId} />;
}
