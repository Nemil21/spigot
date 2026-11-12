// Shared bits of the server-rendered public pages (W13 catalog + terms; SP-033). No JS, one inline
// stylesheet, so a page is a single small response that works in curl, a browser and at 375 px.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Owner-controlled display strings (site name, type) are cut to this many characters. */
const MAX_LABEL = 80;
export const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** Tagged template that escapes every interpolated value; `raw()` marks already-built HTML. */
export class Raw {
  constructor(readonly html: string) {}
}
export const raw = (html: string) => new Raw(html);

type Part = string | number | Raw | null | undefined | false | readonly Part[];

function render(p: Part): string {
  if (p === null || p === undefined || p === false) return '';
  if (p instanceof Raw) return p.html;
  if (Array.isArray(p)) return p.map(render).join('');
  return escapeHtml(String(p));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new Raw(out);
}

const CSS =
  '*{box-sizing:border-box}' +
  'body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181b;background:#fafaf9}' +
  'main{max-width:56rem;margin:0 auto;padding:2rem 1rem 3rem}' +
  'a{color:#0b5cad}h1{font-size:1.75rem;line-height:1.2;margin:0 0 .25rem}h2{font-size:1.15rem;margin:0}' +
  '.sub{color:#52525b;margin:0 0 1.5rem}' +
  '.note{border-left:4px solid #d97706;background:#fffbeb;padding:.75rem 1rem;margin:0 0 1.5rem}' +
  '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr));gap:1rem;margin:0 0 2rem}' +
  '.card{background:#fff;border:1px solid #e4e4e7;border-radius:.5rem;padding:1rem}' +
  '.card dl{display:grid;grid-template-columns:auto 1fr;gap:.15rem .75rem;margin:.75rem 0;font-size:.95rem}' +
  '.card dt{color:#52525b}.card dd{margin:0}' +
  '.badge{display:inline-block;font-size:.8rem;padding:.1rem .5rem;border-radius:999px;background:#fef3c7;color:#92400e}' +
  '.fields{font-size:.85rem;color:#3f3f46;overflow-wrap:anywhere}' +
  'code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}' +
  'pre{background:#18181b;color:#f4f4f5;padding:.85rem;border-radius:.4rem;overflow-x:auto;margin:.5rem 0 0}' +
  '.tabs{margin:0 0 2rem}.tabs input{position:absolute;opacity:0}' +
  '.tabs label{display:inline-block;padding:.35rem .8rem;border:1px solid #d4d4d8;border-radius:.4rem;margin:0 .35rem .35rem 0;cursor:pointer;background:#fff}' +
  '.tabs input:checked+label{background:#18181b;color:#fff;border-color:#18181b}' +
  '.tabs input:focus-visible+label{outline:2px solid #0b5cad;outline-offset:2px}' +
  '.panel{display:none}' +
  '.cta{display:inline-block;background:#0b5cad;color:#fff;padding:.6rem 1rem;border-radius:.4rem;text-decoration:none;font-weight:600}' +
  'ul.links{padding-left:1.1rem}footer{margin-top:2.5rem;color:#71717a;font-size:.85rem}';

export function page(args: { title: string; extraCss?: string; body: Raw }): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(args.title)}</title>` +
    `<style>${CSS}${args.extraCss ?? ''}</style>` +
    `</head><body><main>${args.body.html}</main></body></html>`
  );
}
