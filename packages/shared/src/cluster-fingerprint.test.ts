import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clusterUrls,
  confirmCluster,
  confirmClusters,
  fingerprint,
  jaccard,
  type ClusterPage,
  type Fingerprint,
  type Template,
} from './cluster.js';

// Real pages rendered by apps/demo-site (SP-004a), one per distinct fingerprint at full scale.
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/dom/${name}.html`, import.meta.url), 'utf8');
const LISTING = fixture('listing');
const LISTING_OH = fixture('listing-open-house');
const AGENT = fixture('agent');
const OPEN_HOUSE = fixture('open-house');

const ORIGIN = 'https://bluebonnet.example.com';
const isListing = (fp: Fingerprint) => fp.has('main>article.listing');

/** One URL-pattern template whose pages are rendered from the given HTML bodies. */
function mixedTemplate(bodies: string[]) {
  const pages: ClusterPage[] = bodies.map((_, i) => ({
    id: `p${String(i).padStart(3, '0')}`,
    url: `${ORIGIN}/p/page-${i}`,
  }));
  const [template] = clusterUrls(pages, {}, { paramMinDistinct: 5 });
  const fps = new Map<string, Fingerprint>(pages.map((p, i) => [p.id, fingerprint(bodies[i]!)]));
  return { template: template!, fps, pages };
}

describe('fingerprint', () => {
  it('is tag-path shingles of the body, ignoring text, attributes and repeat counts', () => {
    const a = fingerprint(
      '<html><head><title>A</title></head><body><main class="x y"><ul><li>1<li>2</ul><p id=q>hi</p></main></body></html>',
    );
    const b = fingerprint(
      '<body><main class="x"><ul><li>one</li><li>two</li><li>three</li></ul><p>other text</p></main></body>',
    );
    expect([...a].sort()).toEqual(['main.x', 'main.x>p', 'main.x>ul', 'main.x>ul>li']);
    expect(b).toEqual(a);
  });

  it('skips scripts, styles, comments and void/self-closing elements as containers', () => {
    const fp = fingerprint(
      '<body><div><script>if (a < b) { document.write("<section>") }</script><style>p>a{}</style>' +
        '<!-- <aside> --><img src=x><br/><svg><g><path/></g></svg><span>t</span></div></body>',
    );
    expect([...fp].sort()).toEqual(['div', 'div>br', 'div>img', 'div>span']);
  });

  it('keeps only the last `depth` tags of each path', () => {
    const fp = fingerprint('<body><a><b><c><d><e></e></d></c></b></a></body>', { depth: 2 });
    expect([...fp].sort()).toEqual(['a', 'a>b', 'b>c', 'c>d', 'd>e']);
  });

  it('closes optional end tags (dt/dd, li, p) like a browser', () => {
    const open = fingerprint('<body><dl><dt>a<dd>b<dt>c<dd>d</dl></body>');
    const closed = fingerprint('<body><dl><dt>a</dt><dd>b</dd><dt>c</dt><dd>d</dd></dl></body>');
    expect(open).toEqual(closed);
  });

  it('ignores digit-bearing classes and stray close tags', () => {
    const a = fingerprint('<body><div class="p-123 card"></span><p>x</p></div></body>');
    expect([...a].sort()).toEqual(['div.card', 'div.card>p']);
  });
});

describe('jaccard', () => {
  it('is |A∩B| / |A∪B|', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });
});

describe('demo-site layouts (fixtures)', () => {
  it('pages of one demo template agree (≥ 0.8); different templates do not', () => {
    expect(jaccard(fingerprint(LISTING), fingerprint(LISTING_OH))).toBeGreaterThanOrEqual(0.8);
    const kinds = [LISTING, AGENT, OPEN_HOUSE].map((h) => fingerprint(h));
    for (const [i, a] of kinds.entries())
      for (const b of kinds.slice(i + 1)) expect(jaccard(a, b)).toBeLessThan(0.8);
  });
});

describe('confirmCluster', () => {
  it('splits a pattern mixing listing and agent layouts into two sub-templates', () => {
    const bodies = [
      ...Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? LISTING_OH : LISTING)),
      ...Array.from({ length: 12 }, () => AGENT),
    ];
    const { template, fps } = mixedTemplate(bodies);
    expect(template.pageCount).toBe(36);

    const split = confirmCluster(template, fps);
    expect(split.map((t) => [t.variant, t.pageCount])).toEqual([
      [1, 24],
      [2, 12],
    ]);
    const listingIds = template.pageIds.filter((id) => isListing(fps.get(id)!));
    expect(split[0]!.pageIds).toEqual(listingIds);
    expect(split[1]!.pageIds).toEqual(template.pageIds.filter((id) => !listingIds.includes(id)));
    for (const t of split) {
      expect(t.urlPattern).toBe(template.urlPattern);
      expect(t.pathPattern).toBe(template.pathPattern);
      expect(t.samplePageIds).toHaveLength(5);
      expect(t.samplePageIds.every((id) => t.pageIds.includes(id))).toBe(true);
    }
  });

  it('leaves every demo-site cluster unchanged', () => {
    const pages: ClusterPage[] = [];
    const types = new Map<string, string[]>();
    const fps = new Map<string, Fingerprint>();
    const fp = { LISTING: fingerprint(LISTING), LISTING_OH: fingerprint(LISTING_OH) };
    const add = (path: string, html: string | Fingerprint, jsonld?: string[]) => {
      const page = { id: `p${String(pages.length).padStart(5, '0')}`, url: ORIGIN + path };
      pages.push(page);
      fps.set(page.id, typeof html === 'string' ? fingerprint(html) : html);
      if (jsonld) types.set(page.url, jsonld);
    };
    for (let i = 0; i < 2341; i++)
      add(`/listings/listing-${i}`, i % 7 ? fp.LISTING : fp.LISTING_OH, ['Apartment', 'Offer']);
    const agent = fingerprint(AGENT);
    for (let i = 0; i < 88; i++) add(`/agents/agent-${i}`, agent);
    const openHouse = fingerprint(OPEN_HOUSE);
    for (let i = 0; i < 40; i++) add(`/open-houses/${1000 + i}`, openHouse);

    const templates = clusterUrls(pages, types);
    expect(templates.map((t) => [t.pathPattern, t.pageCount])).toEqual([
      ['/listings/:slug', 2341],
      ['/agents/:slug', 88],
      ['/open-houses/:id', 40],
    ]);
    const confirmed = confirmClusters(templates, fps);
    expect(confirmed).toHaveLength(3);
    confirmed.forEach((t, i) => expect(t).toBe(templates[i]));
  });

  it('drops a layout with fewer than minPages pages and keeps the rest without a variant', () => {
    const bodies = [
      ...Array.from({ length: 20 }, () => LISTING),
      ...Array.from({ length: 3 }, () => AGENT),
    ];
    const { template, fps } = mixedTemplate(bodies);
    const [only, ...rest] = confirmCluster(template, fps);
    expect(rest).toEqual([]);
    expect(only!.pageCount).toBe(20);
    expect(only!.variant).toBeUndefined();
    expect(only!.pageIds.every((id) => isListing(fps.get(id)!))).toBe(true);
  });

  it('drops a pattern whose pages share no structure (/about-like)', () => {
    const tags = [
      'section',
      'aside',
      'table',
      'form',
      'figure',
      'nav',
      'header',
      'footer',
      'ol',
      'blockquote',
      'pre',
      'details',
    ];
    const bodies = tags.map(
      (t, i) =>
        `<body><main><${t} class="c${'x'.repeat(i)}"><span>${i}</span></${t}></main></body>`,
    );
    const { template, fps } = mixedTemplate(bodies);
    expect(template.pageCount).toBe(12);
    expect(confirmCluster(template, fps)).toEqual([]);
  });

  it('keeps pages without a fingerprint with the largest layout', () => {
    const bodies = [
      ...Array.from({ length: 15 }, () => LISTING),
      ...Array.from({ length: 12 }, () => AGENT),
    ];
    const { template, fps } = mixedTemplate(bodies);
    const missing = [template.pageIds[0]!, template.pageIds[20]!];
    for (const id of missing) fps.delete(id);
    const split = confirmCluster(template, fps);
    expect(split.map((t) => t.pageCount)).toEqual([16, 11]);
    expect(split[0]!.pageIds).toEqual(expect.arrayContaining(missing));
  });

  it('returns the template as is with no fingerprints or a single layout', () => {
    const { template, fps } = mixedTemplate(Array.from({ length: 12 }, () => LISTING));
    expect(confirmCluster(template, new Map())[0]).toBe(template);
    expect(confirmCluster(template, fps)[0]).toBe(template);
    expect(confirmCluster(template, (id) => fps.get(id))[0]).toBe(template);
  });

  it('returns the template as is above maxDistinct fingerprints', () => {
    const bodies = [
      ...Array.from({ length: 12 }, () => LISTING),
      ...Array.from({ length: 12 }, () => AGENT),
    ];
    const { template, fps } = mixedTemplate(bodies);
    expect(confirmCluster(template, fps, { maxDistinct: 1 })).toEqual([template]);
  });

  it('is deterministic and independent of page order', () => {
    const bodies = [
      ...Array.from({ length: 14 }, () => AGENT),
      ...Array.from({ length: 22 }, () => LISTING),
    ];
    const { template, fps } = mixedTemplate(bodies);
    const shuffled: Template = { ...template, pageIds: [...template.pageIds].reverse() };
    const a = confirmCluster(template, fps);
    expect(confirmCluster(shuffled, fps)).toEqual(a);
    expect(confirmCluster(template, fps)).toEqual(a);
    expect(a.map((t) => t.pageCount)).toEqual([22, 14]);
  });

  it('honours a custom threshold', () => {
    const { template, fps } = mixedTemplate([
      ...Array.from({ length: 12 }, () => LISTING),
      ...Array.from({ length: 12 }, () => LISTING_OH),
    ]);
    expect(confirmCluster(template, fps)).toEqual([template]);
    expect(confirmCluster(template, fps, { threshold: 0.99 }).map((t) => t.pageCount)).toEqual([
      12, 12,
    ]);
  });
});
