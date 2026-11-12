import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { onPageChanged, onRunFinished } from '../crawl/hooks.js';
import { approveBody, approveDataset, rejectDataset } from '../datasets/approve.js';
import {
  extractChangedPage,
  publishRunDatasets,
  runApproveExtract,
} from '../datasets/extractRun.js';
import { patchBody, patchDataset } from '../datasets/patch.js';
import { unpublishDataset } from '../datasets/unpublish.js';
import { parse } from '../http/errors.js';

/**
 * Dataset write API (SP-014a; api.md §Publisher endpoints). Publisher session only; another
 * publisher's dataset is a 404 (tenancy: `security/tenancy/datasets.cases.ts`).
 *
 * - `PATCH /api/datasets/:id` `{ fields?, perRecordMicros?, perChangeMicros?, slug? }`
 *   → `{ dataset, schemaVersion }` (`schemaVersion` is the new OWNER version, or null).
 * - `POST /api/datasets/:id/approve` `{ schemaVersionId, rightsAttested: true }`
 *   → `{ status: 'LIVE', endpoint, crawlRunId }`; extraction runs after the response (its
 *   progress: `dataset.extract.progress` on the publisher SSE, and the APPROVE `crawl_runs` row).
 * - `POST /api/datasets/:id/reject` → `{ status: 'REJECTED' }`.
 * - `POST /api/datasets/:id/unpublish` → `{ status: 'UNPUBLISHED' }`.
 *
 * Also wired here: the crawler's `onPageChanged` → `extractPage` into the page's sold datasets,
 * and `onRunFinished` → `publishWatermark` for the run's site. Read endpoints are SP-014b.
 */

/** How long `app.close()` waits for in-process APPROVE runs. */
const CLOSE_WAIT_MS = 10_000;

const datasetRoutes: FastifyPluginAsync = async (app) => {
  const running = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const t = p.catch(() => {}).finally(() => running.delete(t));
    running.add(t);
  };

  const offPage = onPageChanged(async (pageId, runId) => {
    await extractChangedPage(app.db, pageId, runId);
  });
  const offRun = onRunFinished(async (runId) => {
    await publishRunDatasets(app.db, runId);
  });
  app.addHook('onClose', async () => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise((r) => {
        timer = setTimeout(r, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    offPage();
    offRun();
  });

  app.patch<{ Params: { id: string } }>('/api/datasets/:id', async (req) => {
    const publisher = requirePublisher(req);
    const body = parse(patchBody, req.body ?? {}, 'dataset edit');
    return patchDataset(app.db, publisher.id, req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/api/datasets/:id/approve', async (req) => {
    const publisher = requirePublisher(req);
    const body = parse(approveBody, req.body ?? {}, 'approve request');
    const approved = await approveDataset(
      app.db,
      { appBaseUrl: app.config.APP_BASE_URL },
      publisher.id,
      req.params.id,
      body,
    );
    track(
      runApproveExtract(
        app.db,
        {
          datasetId: approved.datasetId,
          runId: approved.crawlRunId,
          publisherId: approved.publisherId,
          fields: approved.fields,
        },
        { log: app.log },
      ),
    );
    return {
      status: approved.status,
      endpoint: approved.endpoint,
      crawlRunId: approved.crawlRunId,
    };
  });

  app.post<{ Params: { id: string } }>('/api/datasets/:id/reject', async (req) => {
    const publisher = requirePublisher(req);
    return rejectDataset(app.db, publisher.id, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/datasets/:id/unpublish', async (req) => {
    const publisher = requirePublisher(req);
    return unpublishDataset(app.db, publisher.id, req.params.id);
  });
};

export default datasetRoutes;
