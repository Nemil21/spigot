import type { FastifyRequest } from 'fastify';
import { isAdminEmail } from '../config.js';
import { ApiError } from '../http/errors.js';
import { getPublisher, requirePublisher } from './publisherAuth.js';
import type { PublisherPrincipal } from './sessions.js';

/**
 * Admin (features/14 §Auth): a signed-in **publisher** whose email is in `ADMIN_EMAILS`
 * (case-insensitive). Buyer sessions never qualify. The email is read from the database on each
 * call (the session token carries ids only), so removing an address from `ADMIN_EMAILS` takes
 * effect on the next request after a restart.
 *
 * No session → 401 UNAUTHENTICATED; signed in but not an admin → 403 FORBIDDEN.
 */
export async function requireAdmin(req: FastifyRequest): Promise<PublisherPrincipal> {
  const principal = requirePublisher(req);
  const publisher = await getPublisher(req.server.db.pool, principal.id);
  if (!publisher || !isAdminEmail(req.server.config, publisher.email)) {
    throw new ApiError('FORBIDDEN', 'Admins only.');
  }
  return principal;
}

/** `preHandler` form: `app.get('/admin/health', { preHandler: adminOnly }, …)`. */
export async function adminOnly(req: FastifyRequest): Promise<void> {
  await requireAdmin(req);
}

/** Whether the publisher's email is an admin email (for `/api/auth/me`). */
export function isAdmin(req: FastifyRequest, email: string | null | undefined): boolean {
  return isAdminEmail(req.server.config, email);
}
