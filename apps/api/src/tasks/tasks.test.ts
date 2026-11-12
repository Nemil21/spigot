import { describe, expect, it } from 'vitest';
import * as tasks from '@spigot/api/tasks';

describe('@spigot/api/tasks barrel', () => {
  it('pre-stubs the six Workflows task names', () => {
    const names = Object.keys(tasks).filter((k) => k !== 'TaskNotImplementedError');
    expect(names.sort()).toEqual(
      [
        'crawlSite',
        'extractPage',
        'extractTemplate',
        'fetchPage',
        'payoutRun',
        'publishWatermark',
      ].sort(),
    );
    for (const name of names) expect(typeof tasks[name as keyof typeof tasks]).toBe('function');
  });
});
