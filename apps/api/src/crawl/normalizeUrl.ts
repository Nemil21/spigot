/**
 * URL normalization for `pages.url` (SP-009a1, data-model §pages): absolute, http(s) only, no
 * fragment, no credentials, query parameters sorted by name (stable for repeated names), and an
 * empty `?` dropped. Host lowercasing, default ports and dot segments come from WHATWG `URL`.
 */

export class InvalidUrlError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`Invalid URL (${reason})`);
    this.name = 'InvalidUrlError';
  }
}

/** Parse and normalize `input` (resolved against `base` if relative). Throws `InvalidUrlError`. */
export function normalizeUrl(input: string, base?: string | URL): string {
  return toNormalizedUrl(input, base).toString();
}

/** As `normalizeUrl`, returning the `URL` object. */
export function toNormalizedUrl(input: string | URL, base?: string | URL): URL {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input.trim() : input.toString(), base);
  } catch {
    throw new InvalidUrlError(String(input), 'unparseable');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(String(input), 'only http and https are allowed');
  }
  if (url.username || url.password) {
    throw new InvalidUrlError(String(input), 'credentials are not allowed');
  }
  url.hash = '';
  url.searchParams.sort();
  // A bare `?` (or one with no parameters) is dropped.
  if (![...url.searchParams.keys()].length) url.search = '';
  return url;
}

/** `scheme://host[:port]` of a URL string, normalized. Throws `InvalidUrlError`. */
export function originOf(input: string | URL): string {
  return toNormalizedUrl(input).origin;
}

/** Normalized URL if it is on `origin`, else `null` (also `null` for unparseable input). */
export function normalizeOnOrigin(input: string, origin: string): string | null {
  try {
    const url = toNormalizedUrl(input, origin);
    return url.origin === originOf(origin) ? url.toString() : null;
  } catch {
    return null;
  }
}
