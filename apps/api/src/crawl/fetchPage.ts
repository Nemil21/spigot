import { TaskNotImplementedError } from '../tasks/notImplemented.js';

/** Workflows task placeholder (SP-001a). SP-009a2 replaces this file; keep the export name. */
export async function fetchPage(_args: unknown): Promise<never> {
  throw new TaskNotImplementedError('fetchPage', 'SP-009a2');
}
