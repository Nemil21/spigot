import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { runEvery, runJobTick } from './jobs.js';
import { twoPools, testDatabaseUrl, type TwoPools } from './test-db.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!testDatabaseUrl)('runEvery', () => {
  let pools: TwoPools;

  beforeAll(async () => {
    pools = await twoPools();
  });
  afterAll(async () => {
    await pools?.close();
  });

  test('started in two processes (two pools), the job runs once per tick', async () => {
    // Fake clock, real Postgres: step one tick boundary at a time and wait until both
    // processes have finished their attempt, so a slow runner can't lose a tick.
    const EVERY = 100;
    const TICKS = 12;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = Math.floor(Date.now() / EVERY) + 1;
    vi.setSystemTime((first - 1) * EVERY + EVERY / 2); // mid-tick: each step crosses one boundary

    const ran: number[] = [];
    let settled = 0;
    let onSettled = () => {};
    const job = (pool: pg.Pool) =>
      runEvery(pool, 'once_per_tick', EVERY, async () => {}, {
        onRun: (tick) => ran.push(tick),
        onSettled: () => {
          settled++;
          onSettled();
        },
      });
    const handles = [job(pools.a), job(pools.b)];
    try {
      for (let i = 1; i <= TICKS; i++) {
        const bothSettled = new Promise<void>((resolve) => {
          onSettled = () => settled === 2 * i && resolve();
        });
        await vi.advanceTimersByTimeAsync(EVERY);
        await bothSettled;
      }
    } finally {
      await Promise.all(handles.map((h) => h.stop()));
      vi.useRealTimers();
    }

    // Every tick ran exactly once across the two processes: none skipped, none twice.
    expect(ran.sort((x, y) => x - y)).toEqual(Array.from({ length: TICKS }, (_, i) => first + i));
  });

  test('a process whose timer fires after the other finished does not rerun the tick', async () => {
    let runs = 0;
    const fn = async () => {
      runs++;
    };
    expect(await runJobTick(pools.a, 'late_timer', 1_000, fn)).toBe(true);
    // Process b wakes for the same tick only after a released the lock.
    expect(await runJobTick(pools.b, 'late_timer', 1_000, fn)).toBe(false);
    expect(await runJobTick(pools.b, 'late_timer', 999, fn)).toBe(false); // an older tick never reruns
    expect(await runJobTick(pools.b, 'late_timer', 1_001, fn)).toBe(true);
    expect(runs).toBe(2);
  });

  test('a run slower than the interval never overlaps itself across processes', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const fn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(180);
      active--;
      runs++;
    };
    const handles = [
      runEvery(pools.a, 'slow_job', 50, fn),
      runEvery(pools.b, 'slow_job', 50, fn),
    ];
    await sleep(1_000);
    await Promise.all(handles.map((h) => h.stop()));
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(3);
  });

  test('a throwing job is reported and keeps its schedule', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const h = runEvery(
      pools.a,
      'flaky_job',
      50,
      async () => {
        calls++;
        throw new Error('nope');
      },
      { onError: (e) => errors.push(e) },
    );
    await sleep(400);
    await h.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(errors).toHaveLength(calls);
    // The advisory lock was released each time: another process can take the job now.
    const { rows } = await pools.b.query(
      `SELECT pg_try_advisory_lock(hashtextextended('job:flaky_job', 0)) AS ok`,
    );
    expect(rows[0].ok).toBe(true);
    await pools.b.query(`SELECT pg_advisory_unlock_all()`);
  });

  test('rejects bad names and intervals', () => {
    expect(() => runEvery(pools.a, 'bad name', 100, async () => {})).toThrow(/bad job name/);
    expect(() => runEvery(pools.a, 'ok', 0, async () => {})).toThrow(/bad interval/);
  });
});
