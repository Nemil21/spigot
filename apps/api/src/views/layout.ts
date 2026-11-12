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
  ':root{color-scheme:light dark;--canvas:#f7f8f9;--surface:#fff;--surface-2:#f1f3f5;--border:#d8dee3;--line:#e7ebee;' +
  '--ink:#0c1820;--body:#3a4952;--muted:#5f6e78;--accent:#0b6e75;--accent-strong:#085a60;--accent-tint:#e2f1f1;' +
  '--on-accent:#fff;--money:#8a5a00;--warning:#9a5800;--warning-tint:#fdf0d6;--shadow:12 24 32}' +
  '@media (prefers-color-scheme:dark){:root{--canvas:#0a0f13;--surface:#10171c;--surface-2:#162027;--border:#27333c;' +
  '--line:#1c262d;--ink:#e7eef2;--body:#b6c3cb;--muted:#84949f;--accent:#3cc0c8;--accent-strong:#7ad9de;' +
  '--accent-tint:#0e3135;--on-accent:#03191b;--money:#f0b445;--warning:#f0aa45;--warning-tint:#362609;--shadow:0 0 0}}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--body);background:var(--canvas);' +
  '-webkit-font-smoothing:antialiased}' +
  '::selection{background:var(--accent-tint);color:var(--ink)}' +
  ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
  '.top{border-bottom:1px solid var(--line);background:var(--surface)}' +
  '.top div{max-width:60rem;margin:0 auto;padding:0 1rem;height:3.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}' +
  '.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;color:var(--ink);text-decoration:none;letter-spacing:-.01em}' +
  '.brand svg{color:var(--accent)}.top div>span{color:var(--muted);font-size:.8125rem}' +
  'main{max-width:60rem;margin:0 auto;padding:2.5rem 1rem 4rem}' +
  'a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}a:hover{color:var(--accent-strong)}' +
  'h1,h2{color:var(--ink);text-wrap:balance}' +
  'h1{font-size:2.125rem;line-height:1.15;letter-spacing:-.022em;margin:0 0 .5rem;font-weight:650}' +
  'h2{font-size:1.0625rem;line-height:1.4;letter-spacing:-.01em;margin:0;font-weight:600}' +
  'main>h2{font-size:1.25rem;margin:2.5rem 0 .5rem}' +
  '.sub{color:var(--muted);margin:0 0 2rem;max-width:40rem;font-size:1.0625rem}' +
  '.note{border:1px solid color-mix(in srgb,var(--warning) 30%,transparent);background:var(--warning-tint);color:var(--ink);' +
  'border-radius:.625rem;padding:.75rem 1rem;margin:0 0 1.5rem}' +
  '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr));gap:1rem;margin:0 0 1rem}' +
  '.card{background:var(--surface);border:1px solid var(--line);border-radius:.625rem;padding:1.25rem;' +
  'box-shadow:0 1px 2px rgb(var(--shadow)/.05),0 1px 3px rgb(var(--shadow)/.04);display:flex;flex-direction:column}' +
  '.card>code{color:var(--muted);font-size:12px}' +
  '.card dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1rem;margin:1rem 0;padding:1rem 0;' +
  'border-block:1px solid var(--line);font-size:.875rem}' +
  '.card dt{color:var(--muted)}.card dd{margin:0;color:var(--ink);font-variant-numeric:tabular-nums}' +
  '.card dd small{color:var(--warning)}' +
  '.card dl dd:nth-of-type(2){color:var(--money);font-weight:600}' +
  '.card p{margin:auto 0 0;padding-top:.75rem;font-size:.875rem}' +
  '.badge{display:inline-block;vertical-align:middle;font-size:.6875rem;font-weight:600;padding:.05rem .45rem;' +
  'border-radius:999px;background:var(--warning-tint);color:var(--warning);margin-left:.25rem}' +
  '.fields{font-size:.8125rem;color:var(--body);overflow-wrap:anywhere}.fields strong{color:var(--ink);font-weight:600}' +
  'code,pre{font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
  'p code,li code,.fields code{color:var(--ink);background:var(--surface-2);border-radius:.25rem;padding:.05rem .3rem}' +
  'pre{background:var(--surface);color:var(--ink);border:1px solid var(--line);padding:1rem;border-radius:.625rem;' +
  'overflow-x:auto;margin:.75rem 0 0}' +
  '.tabs{margin:1rem 0 2rem}.tabs input{position:absolute;opacity:0}' +
  '.tabs label{display:inline-block;padding:.3rem .8rem;font-size:.8125rem;font-weight:500;border:1px solid var(--border);' +
  'border-radius:.375rem;margin:0 .35rem .35rem 0;cursor:pointer;background:var(--surface);color:var(--body)}' +
  '.tabs label:hover{color:var(--ink)}' +
  '.tabs input:checked+label{background:var(--ink);color:var(--canvas);border-color:var(--ink)}' +
  '.tabs input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}' +
  '.panel{display:none}.panel p{margin:.5rem 0 0}' +
  '.cta{display:inline-flex;align-items:center;height:2.5rem;background:var(--accent);color:var(--on-accent);padding:0 1.1rem;' +
  'border-radius:.375rem;text-decoration:none;font-weight:600;box-shadow:0 1px 2px rgb(var(--shadow)/.08)}' +
  '.cta:hover{background:var(--accent-strong);color:var(--on-accent)}' +
  'ul.links{list-style:none;padding:0;margin:2rem 0 0;border-top:1px solid var(--line)}' +
  'ul.links li{padding:.7rem 0;border-bottom:1px solid var(--line);font-size:.875rem;overflow-wrap:anywhere}' +
  'footer{margin-top:2rem;color:var(--muted);font-size:.8125rem}';

/** The Spigot mark (a tap spout with a falling drop), inline so the page stays one response. */
const MARK =
  '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 20 20"><rect width="20" height="20" rx="5" fill="currentColor"/>' +
  '<path d="M4.5 7.25h6.25a3 3 0 0 1 3 3v.5M8 5.25v2" fill="none" stroke="var(--on-accent)" stroke-width="2" stroke-linecap="round"/>' +
  '<path d="M13.75 12.6c.9 1.1 1.35 1.9 1.35 2.45a1.35 1.35 0 0 1-2.7 0c0-.55.45-1.35 1.35-2.45Z" fill="var(--on-accent)"/></svg>';

export function page(args: {
  title: string;
  extraCss?: string;
  body: Raw;
  /** Absolute URL of the Spigot home page; without it the brand is plain text. */
  home?: string;
}): string {
  const brand = args.home
    ? `<a class="brand" href="${escapeHtml(args.home)}">${MARK}Spigot</a>`
    : `<span class="brand">${MARK}Spigot</span>`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(args.title)}</title>` +
    `<style>${CSS}${args.extraCss ?? ''}</style>` +
    '</head><body>' +
    `<header class="top"><div>${brand}<span>Data catalog</span></div></header>` +
    `<main>${args.body.html}</main></body></html>`
  );
}
