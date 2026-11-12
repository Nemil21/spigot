// Render Workflows entry (placeholder). SP-041a registers each task with the Render SDK; the task
// bodies stay in apps/api and are imported from here.
import * as tasks from '@spigot/api/tasks';

export const taskNames = Object.keys(tasks);
