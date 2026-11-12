import { TaskNotImplementedError } from '../tasks/notImplemented.js';

/** Workflows task placeholder (SP-001a). SP-020 replaces this file; keep the export name. */
export async function payoutRun(_args: unknown): Promise<never> {
  throw new TaskNotImplementedError('payoutRun', 'SP-020');
}
