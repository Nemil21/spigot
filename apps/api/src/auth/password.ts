import argon2 from 'argon2';

/**
 * Password hashing (features/14 §Auth): argon2id with the library's defaults (OWASP-grade).
 * Hashes are self-describing (`$argon2id$v=19$m=…`), so parameters can change later without a
 * migration.
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** A hash of a random string, used to keep "no such account" as slow as "wrong password". */
let dummyHash: Promise<string> | undefined;

/**
 * Whether `password` matches `hash`. With no hash (unknown email, or an account without a
 * password) it still spends one argon2 verify, so response time doesn't reveal which emails exist.
 */
export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword(`no-account-${Math.random()}`);
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash is a failed login, not a 500.
    return false;
  }
}
