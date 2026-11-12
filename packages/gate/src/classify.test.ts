import { describe, expect, it } from 'vitest';
import { classify, HUMAN_BOT_NAME, SPIGOT_CRAWLER_NAME, type ClassifyInput } from './classify.js';
import { parsePolicy, type Category, type Decision } from './policy.js';
import { CRAWL_KEY, demoPolicyWire } from './fixtures.test-helpers.js';

const policy = parsePolicy(demoPolicyWire());
const GATED = '/listings/123-main-st-austin';

const req = (ua: string, over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  ua,
  ip: '203.0.113.7',
  path: GATED,
  headers: {},
  ...over,
});

// [label, UA, category, botName, decision on a gated path with the default policy]
const FIXTURES: Array<[string, string, Category, string, Decision]> = [
  // SEARCH → PASS
  [
    'Googlebot desktop',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'SEARCH',
    'Googlebot',
    'PASS',
  ],
  [
    'Googlebot smartphone',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'SEARCH',
    'Googlebot',
    'PASS',
  ],
  [
    'Bingbot',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'SEARCH',
    'Bingbot',
    'PASS',
  ],
  [
    'DuckDuckBot',
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    'SEARCH',
    'DuckDuckBot',
    'PASS',
  ],
  [
    'Applebot',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    'SEARCH',
    'Applebot',
    'PASS',
  ],
  [
    'YandexBot',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'SEARCH',
    'YandexBot',
    'PASS',
  ],
  // AI_TRAINING → QUOTE
  [
    'GPTBot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'AI_TRAINING',
    'GPTBot',
    'QUOTE',
  ],
  ['GPTBot bare', 'GPTBot', 'AI_TRAINING', 'GPTBot', 'QUOTE'],
  [
    'ClaudeBot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'AI_TRAINING',
    'ClaudeBot',
    'QUOTE',
  ],
  ['anthropic-ai', 'anthropic-ai', 'AI_TRAINING', 'anthropic-ai', 'QUOTE'],
  ['CCBot', 'CCBot/2.0 (https://commoncrawl.org/faq/)', 'AI_TRAINING', 'CCBot', 'QUOTE'],
  [
    'Applebot-Extended',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot-Extended/0.1)',
    'AI_TRAINING',
    'Applebot-Extended',
    'QUOTE',
  ],
  [
    'Bytespider',
    'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
    'AI_TRAINING',
    'Bytespider',
    'QUOTE',
  ],
  [
    'Amazonbot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36',
    'AI_TRAINING',
    'Amazonbot',
    'QUOTE',
  ],
  [
    'meta-externalagent',
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    'AI_TRAINING',
    'meta-externalagent',
    'QUOTE',
  ],
  ['cohere-ai', 'cohere-ai', 'AI_TRAINING', 'cohere-ai', 'QUOTE'],
  // AI_AGENT → QUOTE
  [
    'ChatGPT-User',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    'AI_AGENT',
    'ChatGPT-User',
    'QUOTE',
  ],
  [
    'Claude-User',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
    'AI_AGENT',
    'Claude-User',
    'QUOTE',
  ],
  [
    'Perplexity-User',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    'AI_AGENT',
    'Perplexity-User',
    'QUOTE',
  ],
  [
    'PerplexityBot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'AI_AGENT',
    'PerplexityBot',
    'QUOTE',
  ],
  [
    'OAI-SearchBot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    'AI_AGENT',
    'OAI-SearchBot',
    'QUOTE',
  ],
  // SCRAPER_TOOL → QUOTE
  ['python-requests', 'python-requests/2.32', 'SCRAPER_TOOL', 'python-requests', 'QUOTE'],
  ['python-urllib', 'Python-urllib/3.12', 'SCRAPER_TOOL', 'python-urllib', 'QUOTE'],
  ['aiohttp', 'Python/3.12 aiohttp/3.10.5', 'SCRAPER_TOOL', 'aiohttp', 'QUOTE'],
  ['Scrapy', 'Scrapy/2.11.2 (+https://scrapy.org)', 'SCRAPER_TOOL', 'Scrapy', 'QUOTE'],
  ['curl', 'curl/8.7.1', 'SCRAPER_TOOL', 'curl', 'QUOTE'],
  ['Wget', 'Wget/1.21.4', 'SCRAPER_TOOL', 'Wget', 'QUOTE'],
  ['Go-http-client', 'Go-http-client/2.0', 'SCRAPER_TOOL', 'Go-http-client', 'QUOTE'],
  [
    'node-fetch',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'SCRAPER_TOOL',
    'node-fetch',
    'QUOTE',
  ],
  ['axios', 'axios/1.7.7', 'SCRAPER_TOOL', 'axios', 'QUOTE'],
  [
    'HeadlessChrome',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
    'SCRAPER_TOOL',
    'HeadlessChrome',
    'QUOTE',
  ],
  ['Apify', 'Mozilla/5.0 (compatible; Apify/1.0)', 'SCRAPER_TOOL', 'Apify', 'QUOTE'],
  // HUMAN / UNKNOWN → PASS
  [
    'Chrome desktop',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'HUMAN',
    HUMAN_BOT_NAME,
    'PASS',
  ],
  [
    'Chrome macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'HUMAN',
    HUMAN_BOT_NAME,
    'PASS',
  ],
  [
    'Safari iPhone',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'HUMAN',
    HUMAN_BOT_NAME,
    'PASS',
  ],
  [
    'Firefox',
    'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'HUMAN',
    HUMAN_BOT_NAME,
    'PASS',
  ],
  [
    'Edge',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    'HUMAN',
    HUMAN_BOT_NAME,
    'PASS',
  ],
  [
    'unlisted bot',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'UNKNOWN',
    'Mozilla',
    'PASS',
  ],
  ['unknown client', 'MyCustomClient/0.3', 'UNKNOWN', 'MyCustomClient', 'PASS'],
  ['empty UA', '', 'UNKNOWN', 'unknown', 'PASS'],
];

describe('classify fixture table', () => {
  it('has at least 30 UAs', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(FIXTURES)('%s', (_label, ua, category, botName, decision) => {
    expect(classify(req(ua), policy)).toEqual({ category, botName, decision });
  });
});

describe('classify rules', () => {
  it('valid X-Spigot-Key → SPIGOT_CRAWLER, whatever the UA or path', () => {
    for (const ua of ['GPTBot', 'SpigotCrawler/1.0', '']) {
      for (const path of [GATED, '/']) {
        expect(classify(req(ua, { path, headers: { 'x-spigot-key': CRAWL_KEY } }), policy)).toEqual(
          {
            decision: 'SPIGOT_CRAWLER',
            category: 'UNKNOWN',
            botName: SPIGOT_CRAWLER_NAME,
          },
        );
      }
    }
  });

  it('wrong crawl key → classified by UA', () => {
    expect(
      classify(req('GPTBot', { headers: { 'x-spigot-key': 'ck_wrong' } }), policy).decision,
    ).toBe('QUOTE');
    expect(
      classify(req('GPTBot', { headers: { 'x-spigot-key': `${CRAWL_KEY}x` } }), policy).decision,
    ).toBe('QUOTE');
    expect(
      classify(req('GPTBot', { headers: { 'x-spigot-key': 'x'.repeat(10_000) } }), policy).decision,
    ).toBe('QUOTE');
    expect(
      classify(req('Googlebot/2.1', { headers: { 'x-spigot-key': 'nope' } }), policy).decision,
    ).toBe('PASS');
  });

  it('crawl key is ignored when the policy has none', () => {
    const noKey = parsePolicy(demoPolicyWire({ crawlKeySha256: null }));
    expect(
      classify(req('GPTBot', { headers: { 'x-spigot-key': CRAWL_KEY } }), noKey).decision,
    ).toBe('QUOTE');
  });

  it('takes the first value of a repeated header', () => {
    expect(
      classify(req('GPTBot', { headers: { 'x-spigot-key': [CRAWL_KEY, 'other'] } }), policy)
        .decision,
    ).toBe('SPIGOT_CRAWLER');
  });

  it('non-gated path + GPTBot → PASS (still reported as GPTBot)', () => {
    for (const path of [
      '/',
      '/robots.txt',
      '/sitemap.xml',
      '/static/app.css',
      '/.well-known/spigot.txt',
      '/about',
    ]) {
      expect(classify(req('GPTBot/1.2', { path }), policy)).toEqual({
        decision: 'PASS',
        category: 'AI_TRAINING',
        botName: 'GPTBot',
      });
    }
  });

  it('decision follows policy.decisions[category]', () => {
    const agentsPass = parsePolicy(
      demoPolicyWire({
        decisions: {
          SEARCH: 'PASS',
          AI_TRAINING: 'QUOTE',
          AI_AGENT: 'PASS',
          SCRAPER_TOOL: 'QUOTE',
          UNKNOWN: 'QUOTE',
        },
      }),
    );
    expect(classify(req('ChatGPT-User/1.0'), agentsPass).decision).toBe('PASS');
    expect(classify(req('MyCustomClient/0.3'), agentsPass).decision).toBe('QUOTE');
    // Humans are never quoted, whatever the UNKNOWN decision.
    expect(
      classify(req(FIXTURES.find((f) => f[0] === 'Chrome desktop')![1]), agentsPass).decision,
    ).toBe('PASS');
  });

  it('matches case-insensitively', () => {
    expect(classify(req('gptbot/1.0'), policy).botName).toBe('GPTBot');
    expect(classify(req('PYTHON-REQUESTS/2.31'), policy).botName).toBe('python-requests');
  });

  it('a UA naming a search crawler and a scraper tool is quoted', () => {
    expect(classify(req('python-requests/2.32 (Googlebot)'), policy)).toMatchObject({
      category: 'SCRAPER_TOOL',
      decision: 'QUOTE',
    });
  });

  it('truncates unknown names so a flood of UAs stays bounded per key', () => {
    expect(classify(req(`${'A'.repeat(500)}/1.0`), policy).botName).toHaveLength(40);
  });

  it('is pure: same input, same output, input untouched', () => {
    const input = req('GPTBot', { headers: { 'x-spigot-key': 'nope' } });
    const snapshot = structuredClone(input);
    expect(classify(input, policy)).toEqual(classify(input, policy));
    expect(input).toEqual(snapshot);
  });
});
