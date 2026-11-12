import { describe, expect, it } from 'vitest';
import * as tasks from '@spigot/api/tasks';

describe('@spigot/api/tasks barrel', () => {
  it('exports the six Workflows task names, plus fetchBatch and the runtime (SP-041a)', () => {
    const helpers = ['TaskNotImplementedError', 'workflowTaskBodies', 'workflowsRuntime'];
    const names = Object.keys(tasks).filter((k) => !helpers.includes(k));
    expect(names.sort()).toEqual(
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
    for (const name of names) expect(typeof tasks[name as keyof typeof tasks]).toBe('function');
  });
});
