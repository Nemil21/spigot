import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import {
  emailField,
  isUniqueViolation,
  nameField,
  passwordField,
  type LoginBody,
} from './credentials.js';
import { hashPassword, verifyPassword } from './password.js';
import type { PublisherPrincipal } from './sessions.js';

/** Publisher accounts (api.md §Publisher endpoints: `POST /api/auth/signup|login|logout`). */

export const publisherSignupBody = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  payoutEmail: emailField,
});

export type PublisherSignup = z.infer<typeof publisherSignupBody>;

export interface PublisherAccount {
  id: string;
  name: string;
  email: string;
  payoutEmail: string;
  isDemo: boolean;
  /** Linked with Log in with PayPal (SP-058): `paypal_payer_id` is set. */
  paypalConnected: boolean;
}

const COLUMNS = `id, name, email, payout_email AS "payoutEmail", is_demo AS "isDemo",
  paypal_payer_id IS NOT NULL AS "paypalConnected"`;

/** Create a publisher. A taken email → `409 STATE_CONFLICT` (race-safe: the unique index decides). */
export async function signupPublisher(
  q: Queryable,
  input: PublisherSignup,
): Promise<PublisherAccount> {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await q.query<PublisherAccount>(
      `INSERT INTO publishers (name, email, password_hash, payout_email)
       SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM publishers WHERE lower(email) = $2)
       RETURNING ${COLUMNS}`,
      [input.name, input.email, passwordHash, input.payoutEmail],
    );
    if (rows[0]) return rows[0];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  throw new ApiError('STATE_CONFLICT', 'An account with this email already exists.');
}

const BAD_LOGIN = 'Email or password is incorrect.';

/** Check credentials. Unknown email and wrong password are the same `401 UNAUTHENTICATED`. */
export async function loginPublisher(q: Queryable, input: LoginBody): Promise<PublisherAccount> {
  const { rows } = await q.query<PublisherAccount & { passwordHash: string | null }>(
    `SELECT ${COLUMNS}, password_hash AS "passwordHash" FROM publishers WHERE lower(email) = $1
      ORDER BY created_at LIMIT 1`,
    [input.email],
  );
  const row = rows[0];
  const ok = await verifyPassword(row?.passwordHash, input.password);
  if (!row || !ok) throw new ApiError('UNAUTHENTICATED', BAD_LOGIN);
  const { passwordHash: _omit, ...account } = row;
  return account;
}

export async function getPublisher(q: Queryable, id: string): Promise<PublisherAccount | null> {
  const { rows } = await q.query<PublisherAccount>(
    `SELECT ${COLUMNS} FROM publishers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Route guard: the signed-in publisher, or `401 UNAUTHENTICATED`. Use its `id` for every query
 * (`forPublisher(req.publisher.id)` in tenancy.ts); never take a publisher id from the body.
 */
export function requirePublisher(req: FastifyRequest): PublisherPrincipal {
  if (!req.publisher) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
  return req.publisher;
}

/** `preHandler` form of `requirePublisher`. */
export async function publisherOnly(req: FastifyRequest): Promise<void> {
  requirePublisher(req);
}
