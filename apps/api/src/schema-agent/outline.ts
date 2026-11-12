// The compact page view the schema agent reads (features/04 §2): JSON-LD blocks verbatim and a
// cleaned DOM outline of the main content, each node annotated with a candidate CSS selector.
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export const OUTLINE_MAX_TEXT = 200;
export const OUTLINE_MAX_TOKENS = 12_000;
/** Char-based token estimate (~4 chars per token for English text and markup). */
export const CHARS_PER_TOKEN = 4;
export const TRUNCATED_MARKER = '… [outline truncated]';

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Every `application/ld+json` block, parsed, in document order. Unparseable blocks are skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  const $ = cheerio.load(html);
  const out: unknown[] = [];
  $('script').each((_, el) => {
    const type = ($(el).attr('type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/ld+json') return;
    try {
      out.push(JSON.parse($(el).text()));
    } catch {
      // A broken block carries nothing the model can use; the extractor skips it too.
    }
  });
  return out;
}

/**
 * Top-level `@type` values across all JSON-LD blocks (arrays and `@graph` items included), for
 * `clusterUrls`. Nested entities (`PostalAddress`, an optional `Offer`) are ignored so a missing
 * optional sub-object can't split one template in two.
 */
export function jsonLdTypes(blocks: unknown[]): string[] {
  const types = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    const t = obj['@type'];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === 'string') types.add(x);
    if (obj['@graph'] !== undefined) visit(obj['@graph']);
  };
  blocks.forEach(visit);
  return [...types].sort();
}

const DROP =
  'script, style, noscript, template, svg, iframe, canvas, link, meta, head, object, embed';
const CHROME = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]';
const SHOWN_ATTRS = ['href', 'src', 'alt', 'datetime', 'content', 'value', 'title'] as const;
/** Attributes good enough to identify a node on their own, in priority order. */
const KEY_ATTRS = ['itemprop', 'name', 'data-k', 'data-field', 'data-key', 'data-testid'] as const;

export interface OutlineOptions {
  maxTokens?: number;
  maxText?: number;
}

/**
 * Indented outline of the main content. One line per meaningful element:
 * `<indent><tag> [<candidate selector>] {attr=value} "own text"`.
 * Wrapper elements with no class, id, key attribute or own text are flattened away.
 */
export function domOutline(html: string, options: OutlineOptions = {}): string {
  const maxChars = (options.maxTokens ?? OUTLINE_MAX_TOKENS) * CHARS_PER_TOKEN;
  const maxText = options.maxText ?? OUTLINE_MAX_TEXT;
  const $ = cheerio.load(html);
  $(DROP).remove();
  $('*')
    .contents()
    .filter((_, n) => n.type === 'comment')
    .remove();

  let root = $('main, [role=main]').first();
  if (!root.length) {
    $(CHROME).remove();
    root = $('article').first();
  }
  if (!root.length) root = $('body').first();
  if (!root.length) return '';

  const lines: string[] = [];
  let size = 0;
  let truncated = false;
  const budget = maxChars - TRUNCATED_MARKER.length - 1;

  const emit = (line: string) => {
    if (truncated) return;
    if (size + line.length + 1 > budget) {
      truncated = true;
      return;
    }
    lines.push(line);
    size += line.length + 1;
  };

  const visit = (el: Element, depth: number) => {
    if (truncated) return;
    const $el = $(el);
    const text = truncate(ownText($, el), maxText);
    const attrs = SHOWN_ATTRS.flatMap((a) => {
      const v = $el.attr(a);
      return v === undefined || v === '' ? [] : [`${a}=${JSON.stringify(truncate(v, maxText))}`];
    });
    const meaningful =
      depth === 0 ||
      text !== '' ||
      attrs.length > 0 ||
      !!$el.attr('id') ||
      classes($el).length > 0 ||
      !!keyAttr($el);

    let childDepth = depth;
    if (meaningful) {
      const parts = [`${'  '.repeat(depth)}${el.tagName}`, `[${candidateSelector($, el)}]`];
      if (attrs.length) parts.push(`{${attrs.join(' ')}}`);
      if (text) parts.push(JSON.stringify(text));
      emit(parts.join(' '));
      childDepth = depth + 1;
    }
    for (const child of $el.children().toArray()) visit(child as Element, childDepth);
  };
  visit(root.get(0) as Element, 0);

  if (truncated) lines.push(TRUNCATED_MARKER);
  return lines.join('\n');
}

function ownText($: cheerio.CheerioAPI, el: Element): string {
  return $(el)
    .contents()
    .toArray()
    .filter((n: AnyNode) => n.type === 'text')
    .map((n) => $(n).text())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

function classes($el: cheerio.Cheerio<Element>): string[] {
  return ($el.attr('class') ?? '').split(/\s+/).filter((c) => IDENT.test(c));
}

function keyAttr($el: cheerio.Cheerio<Element>): [string, string] | undefined {
  for (const a of KEY_ATTRS) {
    const v = $el.attr(a);
    if (v) return [a, v];
  }
  return undefined;
}

function attrSel(name: string, value: string): string {
  return IDENT.test(value) ? `[${name}=${value}]` : `[${name}=${JSON.stringify(value)}]`;
}

/**
 * `tag#id`, or `tag.class1.class2[key=value]` (any part may be absent). `anchored` means the node
 * has its own id or class and may stand alone; otherwise it is always scoped to an ancestor.
 */
function selfSelector(
  $el: cheerio.Cheerio<Element>,
  tag: string,
): { sel: string; anchored: boolean } {
  const id = $el.attr('id');
  if (id && IDENT.test(id)) return { sel: `${tag}#${id}`, anchored: true };
  const cls = classes($el).slice(0, 2);
  const key = keyAttr($el);
  const sel = tag + cls.map((c) => `.${c}`).join('') + (key ? attrSel(key[0], key[1]) : '');
  return { sel, anchored: cls.length > 0 };
}

/**
 * A short selector likely to find this node again: its own tag/class/key attribute, prefixed with
 * the nearest ancestor that has an id or class when the node alone isn't unique (e.g. a `dd` with
 * `data-k=available` under `dl.facts` → `dl.facts dd[data-k=available]`).
 */
export function candidateSelector($: cheerio.CheerioAPI, el: Element): string {
  const self = selfSelector($(el), el.tagName);
  if (self.sel.includes('#')) return self.sel;
  if (self.anchored && $(self.sel).length === 1) return self.sel;

  for (let p = el.parent; p && p.type === 'tag'; p = p.parent) {
    const pe = p as Element;
    const $p = $(pe);
    if (!$p.attr('id') && classes($p).length === 0) continue;
    const anc = selfSelector($p, pe.tagName).sel;
    return `${anc} ${self.sel}`;
  }
  return self.sel;
}
