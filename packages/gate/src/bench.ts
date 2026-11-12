// classify bench (features/02 §Performance budget): 10k mixed requests, p50 < 1 ms,
// max < 50 ms. Run in CI by bench.test.ts in the `check` job.

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { classify, type ClassifyInput } from './classify.js';
import { parsePolicy, type Policy } from './policy.js';

export interface BenchResult {
  n: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export const BENCH_CRAWL_KEY = 'ck_bench_crawl_key';

export function benchPolicy(): Policy {
  return parsePolicy({
    siteId: 'site_bench',
    policyVersion: 1,
    apiBase: 'https://spigot.onrender.com/v1/bluebonnet',
    catalogUrl: 'https://spigot.onrender.com/c/bluebonnet',
    crawlKeySha256: createHash('sha256').update(BENCH_CRAWL_KEY).digest('hex'),
    gatedPaths: ['^/listings/', '^/agents/', '^/open-houses/'],
    decisions: {
      SEARCH: 'PASS',
      AI_TRAINING: 'QUOTE',
      AI_AGENT: 'QUOTE',
      SCRAPER_TOOL: 'QUOTE',
      UNKNOWN: 'PASS',
    },
    prices: [{ dataset: 'listings', perRecordMicros: 1500 }],
  });
}

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'python-requests/2.32.3',
  'curl/8.7.1',
  'Scrapy/2.11.2 (+https://scrapy.org)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'SomeRandomClient/0.1',
  '',
];
const PATHS = [
  '/listings/123-main-st',
  '/',
  '/agents/jane-doe',
  '/static/app.css',
  '/open-houses/42',
  '/sitemap.xml',
];

/** Deterministic mixed workload: browsers, search, AI, tools, crawl keys, gated and not. */
export function benchInputs(n: number): ClassifyInput[] {
  const out: ClassifyInput[] = [];
  for (let i = 0; i < n; i++) {
    const headers: ClassifyInput['headers'] = {};
    if (i % 50 === 0) headers['x-spigot-key'] = BENCH_CRAWL_KEY;
    else if (i % 97 === 0) headers['x-spigot-key'] = 'ck_wrong_key';
    out.push({
      ua: UAS[i % UAS.length] ?? '',
      ip: `10.0.${(i >> 8) & 255}.${i & 255}`,
      path: PATHS[i % PATHS.length] ?? '/',
      headers,
    });
  }
  return out;
}

export function runBench(n = 10_000, policy: Policy = benchPolicy()): BenchResult {
  const inputs = benchInputs(n);
  for (let i = 0; i < 1000; i++) classify(inputs[i % inputs.length]!, policy); // warm up the JIT
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    classify(inputs[i]!, policy);
    times[i] = performance.now() - t0;
  }
  times.sort();
  return {
    n,
    p50Ms: times[Math.floor(n * 0.5)]!,
    p99Ms: times[Math.floor(n * 0.99)]!,
    maxMs: times[n - 1]!,
  };
}
