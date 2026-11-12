/** Thrown by a task placeholder until its owning ticket replaces the target file. */
export class TaskNotImplementedError extends Error {
  constructor(
    readonly task: string,
    readonly ticket: string,
  ) {
    super(`Task ${task} is not implemented yet (${ticket} replaces its file).`);
    this.name = 'TaskNotImplementedError';
  }
}
