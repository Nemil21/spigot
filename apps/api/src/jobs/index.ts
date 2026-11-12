import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Background jobs (SP-001a). Each `jobs/*.job.ts` file default-exports a `Job`; `loadJobs` finds
 * them all, so a ticket adds a job by adding a file (never by editing this one).
 */
export interface Job {
  /** Unique name; also the advisory-lock key, so two API processes never run it twice. */
  name: string;
  everyMs: number;
  run: () => Promise<void> | void;
}

/** The shape of SP-002's `runEvery(name, ms, fn)` (advisory-locked interval). */
export type RunEvery = (name: string, everyMs: number, fn: () => Promise<void> | void) => unknown;

export const JOBS_DIR = fileURLToPath(new URL('.', import.meta.url));

const JOB_FILE = /\.job\.[cm]?[jt]s$/;
const NOT_A_JOB = /\.d\.[cm]?ts$|\.test\.[cm]?[jt]s$/;

function isJob(value: unknown): value is Job {
  const j = value as Job | null;
  return (
    !!j &&
    typeof j.name === 'string' &&
    j.name.length > 0 &&
    typeof j.everyMs === 'number' &&
    j.everyMs > 0 &&
    typeof j.run === 'function'
  );
}

/** Import every `*.job.ts` (or built `*.job.js`) in `dir`, sorted by file name. */
export async function loadJobs(dir: string = JOBS_DIR): Promise<Job[]> {
  const files = (await readdir(dir)).filter((f) => JOB_FILE.test(f) && !NOT_A_JOB.test(f)).sort();
  const jobs: Job[] = [];
  const names = new Set<string>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
    if (!isJob(mod.default)) {
      throw new Error(`${file} must default-export { name, everyMs, run } (see jobs/index.ts).`);
    }
    if (names.has(mod.default.name)) {
      throw new Error(`Duplicate job name "${mod.default.name}" in ${file}.`);
    }
    names.add(mod.default.name);
    jobs.push(mod.default);
  }
  return jobs;
}

/** Load every job and start it with `runEvery`. Returns the loaded jobs. */
export async function startJobs(runEvery: RunEvery, dir: string = JOBS_DIR): Promise<Job[]> {
  const jobs = await loadJobs(dir);
  for (const job of jobs) runEvery(job.name, job.everyMs, job.run);
  return jobs;
}
