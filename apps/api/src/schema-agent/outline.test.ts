import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OUTLINE_MAX_TOKENS,
  TRUNCATED_MARKER,
  domOutline,
  estimateTokens,
  jsonLdBlocks,
  jsonLdTypes,
} from './outline.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const listing = fixture('listing.html');
const agent = fixture('agent.html');
const openHouse = fixture('open-house.html');
const blogPost = fixture('blog-post.html');

describe('jsonLdBlocks', () => {
  it('returns the listing JSON-LD verbatim', () => {
    const blocks = jsonLdBlocks(listing);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      '@type': 'Apartment',
      numberOfRooms: 2,
      offers: { '@type': 'Offer', price: 1875, priceCurrency: 'USD' },
    });
    const raw = listing.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!;
    expect(blocks[0]).toEqual(JSON.parse(raw));
  });

  it('returns every block in order, skips invalid ones and non-JSON-LD scripts', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Organization","name":"A"}</script>
      <script type="application/ld+json">{not json</script>
      <script type="application/json">{"@type":"Nope"}</script>
      </head><body><script type="Application/LD+JSON; charset=utf-8">[{"@type":"Event"}]</script></body></html>`;
    expect(jsonLdBlocks(html)).toEqual([
      { '@type': 'Organization', name: 'A' },
      [{ '@type': 'Event' }],
    ]);
  });

  it('pages without JSON-LD return []', () => {
    expect(jsonLdBlocks(agent)).toEqual([]);
    expect(jsonLdBlocks(openHouse)).toEqual([]);
  });
});

describe('jsonLdTypes', () => {
  it('reads top-level and @graph types, not nested entities', () => {
    expect(jsonLdTypes(jsonLdBlocks(listing))).toEqual(['Apartment']);
    expect(
      jsonLdTypes([
        { '@graph': [{ '@type': ['Apartment', 'Product'] }, { '@type': 'Offer' }] },
        [{ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem' }] }],
      ]),
    ).toEqual(['Apartment', 'BreadcrumbList', 'Offer', 'Product']);
  });
});

describe('domOutline', () => {
  it('listing outline has the available_from selector and stays under the cap', () => {
    const out = domOutline(listing);
    expect(out).toContain('dl.facts dd[data-k=available]');
    expect(out).toMatch(/dd \[dl\.facts dd\[data-k=available\]\] "2026-12-01"/);
    expect(out).toContain('dl.facts dd[data-k=pets]');
    expect(out).toContain('.agent-card');
    expect(out).toContain('span.phone');
    expect(estimateTokens(out)).toBeLessThanOrEqual(OUTLINE_MAX_TOKENS);
    expect(out).not.toContain(TRUNCATED_MARKER);
  });

  it('keeps main content only: no scripts, styles, header, nav or footer', () => {
    const out = domOutline(listing);
    expect(out.split('\n')[0]).toMatch(/^main \[main\.listing\]/);
    expect(out).not.toMatch(/analytics|font-weight|application\/ld\+json|numberOfRooms/);
    expect(out).not.toContain('Fictional demo site');
    expect(out).not.toContain('site-nav');
  });

  it('agent outline exposes the stable class names', () => {
    const out = domOutline(agent);
    expect(out).toContain('[h1.agent-name] "Maya Okafor"');
    expect(out).toContain('[p.agent-phone] "(512) 555-0142"');
    expect(out).toContain('dl.facts dd[data-k=email]');
  });

  it('open house outline shows <time datetime>', () => {
    const out = domOutline(openHouse);
    expect(out).toContain(
      'time [p.when time] {datetime="2026-12-06T13:00:00-06:00"} "Sat, Dec 6 · 1:00 PM"',
    );
    expect(out).toContain('[time.ends] {datetime="2026-12-06T15:00:00-06:00"}');
    expect(out).toContain('{href="/listings/2br-mueller-1904-aldrich-st-214"}');
  });

  it('falls back to <article> and strips page chrome when there is no <main>', () => {
    const out = domOutline(blogPost);
    expect(out.split('\n')[0]).toMatch(/^article/);
    expect(out).toContain('Five things to ask');
    expect(out).not.toContain('Bluebonnet Rentals');
    expect(out).not.toContain('Fictional demo site');
  });

  it('falls back to <body> without page chrome', () => {
    const out = domOutline(
      '<body><nav>Menu</nav><div class="x">Hello</div><footer>Bye</footer></body>',
    );
    expect(out).toBe('body [body]\n  div [div.x] "Hello"');
  });

  it('flattens anonymous wrappers', () => {
    const out = domOutline('<main><div><div><p class="a">Hi</p></div></div></main>');
    expect(out).toBe('main [main]\n  p [p.a] "Hi"');
  });

  it('truncates each node text to 200 chars', () => {
    const long = 'word '.repeat(100);
    const out = domOutline(
      `<main><p class="d">${long}</p><a href="/${'x'.repeat(300)}">l</a></main>`,
    );
    const text = JSON.parse(out.split('\n')[1]!.match(/(".*")$/)![1]!) as string;
    expect(text).toHaveLength(200);
    expect(text.endsWith('…')).toBe(true);
    const href = out.split('\n')[2]!.match(/href="([^"]*)"/)![1]!;
    expect(href).toHaveLength(200);
  });

  it('caps a huge page at ~12k tokens and marks the cut', () => {
    const rows = Array.from(
      { length: 5000 },
      (_, i) => `<li class="row" data-k="r${i}">${'row text '.repeat(15)}${i}</li>`,
    ).join('');
    const out = domOutline(`<main><ul class="rows">${rows}</ul></main>`);
    expect(estimateTokens(out)).toBeLessThanOrEqual(OUTLINE_MAX_TOKENS);
    expect(estimateTokens(out)).toBeGreaterThan(OUTLINE_MAX_TOKENS - 200);
    expect(out.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(
      estimateTokens(domOutline(`<main>${rows}</main>`, { maxTokens: 500 })),
    ).toBeLessThanOrEqual(500);
  });

  it('prefers ids, and scopes non-unique classes to an ancestor', () => {
    const out = domOutline(
      '<main><section id="specs"><span class="v">1</span></section><section class="b"><span class="v">2</span></section></main>',
    );
    expect(out).toContain('[section#specs]');
    expect(out).toContain('[section#specs span.v] "1"');
    expect(out).toContain('[section.b span.v] "2"');
  });

  it('quotes attribute values that are not identifiers', () => {
    expect(
      domOutline('<main><div class="f"><span data-k="move in">x</span></div></main>'),
    ).toContain('div.f span[data-k="move in"]');
  });

  it('every candidate selector finds its node again', async () => {
    const cheerio = await import('cheerio');
    for (const html of [listing, agent, openHouse]) {
      const $ = cheerio.load(html);
      for (const line of domOutline(html).split('\n')) {
        const sel = line.match(/^\s*\S+ \[(.*?)\](?= \{| "|$)/)?.[1];
        if (!sel) continue;
        expect($(sel).length, sel).toBeGreaterThan(0);
      }
    }
  });
});
