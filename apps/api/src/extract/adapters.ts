// Node-only adapters for the browser-safe extractor in `@spigot/shared` (SP-011). The self-check
// (SP-012b), extractTemplate and extractPage (SP-013) pass both in:
//   extract(html, spec, url, { regex: re2Engine });  recordHash(rec.data, nodeSha256)
import { createHash } from 'node:crypto';
import { RE2 } from 're2-wasm';
import type { Hasher, RegexEngine } from '@spigot/shared';

export const nodeSha256: Hasher = (canonical) =>
  createHash('sha256').update(canonical, 'utf8').digest('hex');

/** RE2 (linear time, no backtracking) for `regex:` transforms. Throws on non-RE2 syntax. */
export const re2Engine: RegexEngine = {
  compile(pattern) {
    const re = new RE2(pattern, 'u');
    return {
      firstGroup(input) {
        const m = re.exec(input);
        if (!m) return null;
        return (m.length > 1 ? m[1] : m[0]) ?? null;
      },
    };
  },
};
