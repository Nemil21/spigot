import { TaskRegistry } from '@renderinc/sdk/workflows';
import { describe, expect, it } from 'vitest';
import { registered, taskNames, TASKS } from './index.js';

/** The options as the SDK sends them to Render at registration (its wire format). */
interface WireOptions {
  retry?: { max_retries: number; wait_duration_ms: number };
  timeout_seconds?: number;
  plan?: string;
}
const wire = (name: string) =>
  TaskRegistry.getInstance().get(name)?.options as WireOptions | undefined;

/** SP-041a/b: what the workflow service registers with the Render SDK (no task server here). */
describe('apps/workflows entry', () => {
  it('registers the six crawl / extract tasks, fetchBatch and payoutRun', () => {
    expect([...taskNames].sort()).toEqual(
      [
        'crawlSite',
        'extractPage',
        'extractTemplate',
        'fetchBatch',
        'fetchPage',
        'payoutRun',
        'publishWatermark',
      ].sort(),
    );
    expect(registered.map((t) => t.name).sort()).toEqual([...taskNames].sort());
    for (const name of taskNames) expect(TaskRegistry.getInstance().has(name)).toBe(true);
  });

  it('payoutRun: Render-level retries off (SP-020 owns money retries), bounded timeout', () => {
    expect(wire(TASKS.payoutRun)).toMatchObject({
      retry: { max_retries: 0 },
      timeout_seconds: 600,
      plan: 'starter',
    });
  });

  it('crawl tasks keep spec 03 retry counts', () => {
    const retries = (name: string) => wire(name)?.retry?.max_retries;
    expect(retries(TASKS.crawlSite)).toBe(1);
    expect(retries(TASKS.fetchBatch)).toBe(1);
    expect(retries(TASKS.fetchPage)).toBe(3);
    expect(retries(TASKS.extractTemplate)).toBe(2);
    expect(retries(TASKS.extractPage)).toBe(2);
    expect(retries(TASKS.publishWatermark)).toBe(3);
  });
});
