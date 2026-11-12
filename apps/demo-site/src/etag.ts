import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/** Strong ETag over the exact bytes sent. */
export function etagFor(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
}

/**
 * Send a rendered body with an ETag; answer `304 Not Modified` when `If-None-Match` matches.
 * Express's own (weak) ETag is turned off in createApp so every response goes through here.
 */
export function sendWithEtag(req: Request, res: Response, body: string, contentType: string): void {
  res.set('ETag', etagFor(body));
  res.set('Cache-Control', 'no-cache');
  res.type(contentType);
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.send(body);
}
