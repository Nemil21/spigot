import { audit } from '../audit/audit.js';
import { transition, type Db } from '../db/index.js';
import { bumpPolicyVersion, SOLD_DATASET_STATUSES } from '../gate/policy.js';
import { ApiError } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';

/**
 * `POST /api/datasets/:id/unpublish` (SP-014a; api.md, data-model §Dataset state machine):
 * `LIVE | LIVE_STALE → UNPUBLISHED` (the data API answers 410 `DATASET_UNPUBLISHED`, SP-017b),
 * policy bump so the gate stops quoting the template's paths, audit `DATASET_UNPUBLISHED`.
 * Records are kept. A second unpublish is a 409.
 */
export async function unpublishDataset(
  db: Db,
  publisherId: string,
  datasetId: string,
): Promise<{ status: 'UNPUBLISHED' }> {
  const scope = forPublisher(publisherId);
  return db.tx(async (tx) => {
    const ds = await scope.get<{ id: string; site_id: string; slug: string; status: string }>(
      tx,
      'datasets',
      datasetId,
      { columns: 't.id, t.site_id, t.slug, t.status', forUpdate: true },
    );
    const done = await transition(
      tx,
      'datasets',
      ds.id,
      [...SOLD_DATASET_STATUSES],
      'UNPUBLISHED',
      {
        updated_at: new Date(),
      },
    );
    if (!done) {
      throw new ApiError(
        'STATE_CONFLICT',
        `This dataset is ${ds.status}; only a live dataset can be unpublished.`,
        {
          status: ds.status,
        },
      );
    }
    const policyVersion = await bumpPolicyVersion(tx, ds.site_id);
    await audit(tx, {
      actorType: 'PUBLISHER',
      actorId: publisherId,
      publisherId,
      entity: 'datasets',
      entityId: ds.id,
      action: 'DATASET_UNPUBLISHED',
      data: { siteId: ds.site_id, slug: ds.slug, from: ds.status, policyVersion },
    });
    return { status: 'UNPUBLISHED' };
  });
}
