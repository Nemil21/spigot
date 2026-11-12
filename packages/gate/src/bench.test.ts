import { describe, expect, it } from 'vitest';
import { benchInputs, benchPolicy, runBench } from './bench.js';
import { classify } from './classify.js';

describe('classify bench (features/02 §Performance budget)', () => {
  it('10k mixed requests: p50 < 1 ms, max < 50 ms', () => {
    const r = runBench(10_000);
    console.info(
      `classify bench: n=${r.n} p50=${(r.p50Ms * 1000).toFixed(1)}µs p99=${(r.p99Ms * 1000).toFixed(1)}µs max=${r.maxMs.toFixed(3)}ms`,
    );
    expect(r.n).toBe(10_000);
    expect(r.p50Ms).toBeLessThan(1);
    expect(r.maxMs).toBeLessThan(50);
  });

  it('the workload is mixed: every decision appears', () => {
    const policy = benchPolicy();
    const decisions = new Set(benchInputs(1000).map((i) => classify(i, policy).decision));
    expect(decisions).toEqual(new Set(['PASS', 'QUOTE', 'SPIGOT_CRAWLER']));
  });
});
