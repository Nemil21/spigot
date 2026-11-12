import { audit } from '../audit/audit.js';
import { crawlerUserAgent } from '../crawl/deps.js';
import { safeFetch, SafeFetchError } from '../crawl/safeFetch.js';
import { transition } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';
import { emitSiteVerified } from './hooks.js';
import { verifyBodyMatches, VERIFY_PATH } from './keys.js';
import { MESSAGES, PROBE_TIMEOUT_MS, type SitesDeps } from './sites.js';

/**
 * `POST /api/sites/:id/verify` (SP-008a; features/03 §Logic 2, api.md): GET
 * `<origin>/.well-known/spigot.txt` through `safeFetch` and compare it with `verify_token`.
 *
 * - Match → `transition(PENDING_VERIFY → VERIFIED)`, audit `SITE_VERIFIED` in the same
 *   transaction, then (after commit) `emitSiteVerified` (SP-009b starts the discovery crawl).
 * - No match / 404 → `409 STATE_CONFLICT` "Token not found at /.well-known/spigot.txt".
 * - Origin unreachable → `502 ORIGIN_ERROR` "We couldn't reach that site".
 * - Already past PENDING_VERIFY → no-op: the current status, no fetch, no audit, no hook. Two
 *   concurrent verifies race on the conditional update; the loser is the same no-op.
 */

export interface VerifyResult {
  status: string;
}

const VERIFY_MAX_BYTES = 64 * 1024;

export async function verifySite(
  deps: SitesDeps,
  publisherId: string,
  siteId: string,
): Promise<VerifyResult> {
  const scope = forPublisher(publisherId);
  const site = await scope.get<{
    id: string;
    origin: string;
    status: string;
    verify_token: string;
  }>(deps.db.pool, 'sites', siteId, { columns: 't.id, t.origin, t.status, t.verify_token' });
  if (site.status !== 'PENDING_VERIFY') return { status: site.status };

  let body: string;
  let status: number;
  try {
    const res = await (deps.fetch ?? safeFetch)(`${site.origin}${VERIFY_PATH}`, {
      origin: site.origin,
      allowLocal: deps.allowLocal,
      resolver: deps.resolver,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: VERIFY_MAX_BYTES,
      headers: { 'user-agent': crawlerUserAgent(deps.appBaseUrl) },
    });
    body = res.body.toString('utf8');
    status = res.status;
  } catch (err) {
    if (
      err instanceof SafeFetchError &&
      ['DNS_FAILED', 'NETWORK', 'TIMEOUT', 'TOO_MANY_REDIRECTS'].includes(err.code)
    ) {
      throw new ApiError('ORIGIN_ERROR', MESSAGES.unreachable, { reason: err.code });
    }
    // Off-origin redirect, oversized file, blocked address: the token isn't served there.
    body = '';
    status = 0;
  }

  if (status !== 200 || !verifyBodyMatches(body, site.verify_token)) {
    throw new ApiError('STATE_CONFLICT', `Token not found at ${VERIFY_PATH}`, {
      path: VERIFY_PATH,
      httpStatus: status || undefined,
    });
  }

  const moved = await deps.db.tx(async (tx) => {
    const row = await transition(tx, 'sites', site.id, 'PENDING_VERIFY', 'VERIFIED', {
      updated_at: new Date(),
    });
    if (!row) return null;
    await audit(tx, {
      actorType: 'PUBLISHER',
      actorId: scope.publisherId,
      publisherId: scope.publisherId,
      entity: 'sites',
      entityId: site.id,
      action: 'SITE_VERIFIED',
      data: { origin: site.origin },
    });
    return row;
  });

  if (!moved) {
    // Someone else verified it between our read and our update.
    const current = await scope.get<{ status: string }>(deps.db.pool, 'sites', site.id, {
      columns: 't.status',
    });
    return { status: current.status };
  }

  await emitSiteVerified(site.id, scope.publisherId);
  return { status: 'VERIFIED' };
}
