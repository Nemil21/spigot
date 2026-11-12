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
import type { BuyerPrincipal } from './sessions.js';

/** Buyer portal accounts (api.md §Buyer portal endpoints: `POST /api/buyer/signup|login|logout`). */

export const buyerSignupBody = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
});

export type BuyerSignup = z.infer<typeof buyerSignupBody>;

export interface BuyerAccount {
  id: string;
  name: string | null;
  email: string | null;
}

const COLUMNS = `id, name, email`;

/** Create a buyer. A taken email → `409 STATE_CONFLICT`. */
export async function signupBuyer(q: Queryable, input: BuyerSignup): Promise<BuyerAccount> {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await q.query<BuyerAccount>(
      `INSERT INTO buyers (name, email, password_hash)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM buyers WHERE lower(email) = $2)
       RETURNING ${COLUMNS}`,
      [input.name, input.email, passwordHash],
    );
    if (rows[0]) return rows[0];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  throw new ApiError('STATE_CONFLICT', 'An account with this email already exists.');
}

/** Check credentials. Unknown email and wrong password are the same `401 UNAUTHENTICATED`. */
export async function loginBuyer(q: Queryable, input: LoginBody): Promise<BuyerAccount> {
  const { rows } = await q.query<BuyerAccount & { passwordHash: string | null }>(
    `SELECT ${COLUMNS}, password_hash AS "passwordHash" FROM buyers WHERE lower(email) = $1
      ORDER BY created_at LIMIT 1`,
    [input.email],
  );
  const row = rows[0];
  const ok = await verifyPassword(row?.passwordHash, input.password);
  if (!row || !ok) throw new ApiError('UNAUTHENTICATED', 'Email or password is incorrect.');
  const { passwordHash: _omit, ...account } = row;
  return account;
}

export async function getBuyer(q: Queryable, id: string): Promise<BuyerAccount | null> {
  const { rows } = await q.query<BuyerAccount>(`SELECT ${COLUMNS} FROM buyers WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Route guard: the buyer making the request (portal session, or an API key once SP-007b's Bearer
 * hook runs), or `401 UNAUTHENTICATED`. Scope every buyer query by this id.
 */
export function requireBuyer(req: FastifyRequest): BuyerPrincipal {
  if (!req.buyer) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
  return req.buyer;
}

/** Portal-only guard: a buyer signed in with the session cookie (not an API key). */
export function requireBuyerSession(req: FastifyRequest): BuyerPrincipal {
  const buyer = requireBuyer(req);
  if (buyer.via !== 'session') throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
  return buyer;
}
