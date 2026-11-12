import { z } from 'zod';
import { PASSWORD_MAX, PASSWORD_MIN } from './password.js';

/** Shared credential fields for publisher and buyer signup / login (Zod → 400 VALIDATION_ERROR). */

/** Emails are stored and compared trimmed and lowercased. */
export const emailField = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((e) => e.toLowerCase());

export const passwordField = z
  .string()
  .min(PASSWORD_MIN, `must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX);

export const nameField = z.string().trim().min(1).max(200);

export const loginBody = z.object({
  email: emailField,
  // Login never says "too short": any non-empty string is just a wrong password.
  password: z.string().min(1).max(PASSWORD_MAX),
});

export type LoginBody = z.infer<typeof loginBody>;

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
