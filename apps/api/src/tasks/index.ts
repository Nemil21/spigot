/**
 * The task functions Render Workflows runs (`@spigot/api/tasks`, imported by apps/workflows) and
 * the in-process dispatcher calls (WORKFLOWS_MODE=inproc). The six names are fixed here so no
 * ticket edits this barrel: the owning ticket replaces the target file, keeping the export name.
 * SP-041a adds `fetchBatch` (the 2-per-host fan-out unit) and the workflow service's runtime.
 */
export { crawlSite } from '../crawl/crawlSite.js';
export { fetchPage } from '../crawl/fetchPage.js';
export { fetchBatch } from '../crawl/fetchBatch.js';
export { extractTemplate } from '../extract/extractTemplate.js';
export { extractPage } from '../extract/extractPage.js';
export { publishWatermark } from '../extract/publishWatermark.js';
export { payoutRun } from '../payouts/payoutRun.js';
export { TaskNotImplementedError } from './notImplemented.js';
export {
  workflowTaskBodies,
  workflowsRuntime,
  type TaskRunContext,
  type WorkflowsRuntime,
} from '../workflows/runtime.js';
