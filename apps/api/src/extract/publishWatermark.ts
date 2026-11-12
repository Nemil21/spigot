import { TaskNotImplementedError } from '../tasks/notImplemented.js';

/** Workflows task placeholder (SP-001a). SP-013 replaces this file; keep the export name. */
export async function publishWatermark(_args: unknown): Promise<never> {
  throw new TaskNotImplementedError('publishWatermark', 'SP-013');
}
