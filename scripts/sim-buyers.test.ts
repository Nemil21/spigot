import { describe, expect, it } from 'vitest';
import {
  activityWeight,
  filterOptions,
  mulberry32,
  pickSpec,
  planWeek,
  sampleTimes,
  WEEK_MS,
  type CallSpec,
  type PlanBuyer,
} from './sim-buyers.lib.js';

const NOW = new Date('2026-11-12T10:30:00Z');
const WEEK_START = new Date('2026-11-05T00:00:00Z'); // seed:demo's top-up date for NOW

const spec = (kind: CallSpec['kind'], priceMicros: number): CallSpec => ({
  datasetId: 'd1',
  site: 'bluebonnet',
  dataset: 'listings',
  kind,
  limit: 50,
  priceMicros,
});
const CATALOGUE: CallSpec[] = [
  spec('records', 15_000),
  spec('records', 37_500),
  spec('records', 75_000),
  spec('records', 150_000),
  spec('changes', 50_000),
  spec('changes', 200_000),
];

function buyers(n: number, balanceUsd = 35): PlanBuyer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    balanceMicros: (balanceUsd + (i % 5) * 3) * 1_000_000,
    fundedAt: WEEK_START,
  }));
}

describe('planWeek', () => {
  it("plans ≈ the remaining gross across the buyers, inside each buyer's window, in time order", () => {
    const bs = buyers(20);
    const plan = planWeek({
      buyers: bs,
      catalogue: CATALOGUE,
      remainingMicros: 500_000_000,
      now: NOW,
      rng: mulberry32(7),
    });
    expect(plan.byBuyer.size).toBe(20);
    // Each buyer overshoots its share by less than one call.
    expect(plan.plannedMicros).toBeGreaterThanOrEqual(495_000_000);
    expect(plan.plannedMicros).toBeLessThanOrEqual(500_000_000 + 20 * 200_000);
    for (const b of bs) {
      const calls = plan.byBuyer.get(b.id)!;
      const total = calls.reduce((s, c) => s + c.spec.priceMicros, 0);
      expect(total).toBeLessThanOrEqual(b.balanceMicros);
      for (let i = 0; i < calls.length; i++) {
        const at = calls[i]!.at.getTime();
        expect(at).toBeGreaterThan(b.fundedAt.getTime());
        expect(at).toBeGreaterThanOrEqual(NOW.getTime() - WEEK_MS);
        expect(at).toBeLessThan(NOW.getTime());
        if (i > 0) expect(at).toBeGreaterThanOrEqual(calls[i - 1]!.at.getTime());
      }
    }
  });

  it('mixes records and changes calls', () => {
    const plan = planWeek({
      buyers: buyers(20),
      catalogue: CATALOGUE,
      remainingMicros: 500_000_000,
      now: NOW,
      rng: mulberry32(1),
    });
    const all = [...plan.byBuyer.values()].flat();
    const records = all.filter((c) => c.spec.kind === 'records').length;
    expect(records / all.length).toBeGreaterThan(0.6);
    expect(records / all.length).toBeLessThan(0.9);
  });

  it("never plans past a buyer's balance when the target is more than they hold", () => {
    const bs = buyers(3, 20);
    const plan = planWeek({
      buyers: bs,
      catalogue: CATALOGUE,
      remainingMicros: 10_000_000_000,
      now: NOW,
      rng: mulberry32(3),
    });
    for (const b of bs) {
      const total = plan.byBuyer.get(b.id)!.reduce((s, c) => s + c.spec.priceMicros, 0);
      expect(total).toBeLessThanOrEqual(b.balanceMicros);
      expect(total).toBeGreaterThan(b.balanceMicros - 150_000);
    }
  });

  it('plans nothing when the week already reached the target (a re-run)', () => {
    const plan = planWeek({
      buyers: buyers(20),
      catalogue: CATALOGUE,
      remainingMicros: 0,
      now: NOW,
      rng: mulberry32(1),
    });
    expect(plan.byBuyer.size).toBe(0);
  });

  it('keeps every call after a late top-up, and skips buyers with no balance or no room', () => {
    const late = new Date(NOW.getTime() - 3 * 86_400_000);
    const plan = planWeek({
      buyers: [
        { id: 'late', balanceMicros: 30_000_000, fundedAt: late },
        { id: 'broke', balanceMicros: 0, fundedAt: WEEK_START },
        { id: 'justnow', balanceMicros: 30_000_000, fundedAt: new Date(NOW.getTime() - 60_000) },
      ],
      catalogue: CATALOGUE,
      remainingMicros: 20_000_000,
      now: NOW,
      rng: mulberry32(9),
    });
    for (const c of plan.byBuyer.get('late')!)
      expect(c.at.getTime()).toBeGreaterThan(late.getTime());
    expect(plan.skipped.map((s) => s.buyerId).sort()).toEqual(['broke', 'justnow']);
  });

  it('is deterministic for a seed', () => {
    const run = () =>
      planWeek({
        buyers: buyers(5),
        catalogue: CATALOGUE,
        remainingMicros: 100_000_000,
        now: NOW,
        rng: mulberry32(42),
      });
    const a = [...run().byBuyer.values()].flat().map((c) => [c.at.getTime(), c.spec.priceMicros]);
    const b = [...run().byBuyer.values()].flat().map((c) => [c.at.getTime(), c.spec.priceMicros]);
    expect(a).toEqual(b);
  });
});

describe('traffic shape', () => {
  it('US daytime outweighs the small hours, and the week trends up', () => {
    expect(activityWeight(new Date('2026-11-10T18:00:00Z'), 0.5)).toBeGreaterThan(
      activityWeight(new Date('2026-11-10T06:00:00Z'), 0.5),
    );
    const t = new Date('2026-11-10T18:00:00Z');
    expect(activityWeight(t, 1)).toBeGreaterThan(activityWeight(t, 0));
  });

  it('sampleTimes returns n sorted instants inside the window', () => {
    const start = new Date(NOW.getTime() - WEEK_MS);
    const ts = sampleTimes(mulberry32(5), 500, start, NOW);
    expect(ts).toHaveLength(500);
    for (let i = 0; i < ts.length; i++) {
      expect(ts[i]!.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(ts[i]!.getTime()).toBeLessThan(NOW.getTime());
      if (i > 0) expect(ts[i]!.getTime()).toBeGreaterThanOrEqual(ts[i - 1]!.getTime());
    }
    // Spread over the whole week, not bunched at one end.
    const days = new Set(ts.map((t) => t.toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(7);
  });

  it('pickSpec falls back to whichever kind exists', () => {
    const rng = mulberry32(2);
    const recordsOnly = CATALOGUE.filter((c) => c.kind === 'records');
    for (let i = 0; i < 20; i++) expect(pickSpec(rng, recordsOnly).kind).toBe('records');
  });
});

describe('filterOptions', () => {
  it('builds numeric ranges and common string values, only on filterable fields', () => {
    const opts = filterOptions(
      {
        fields: [
          { name: 'bedrooms', type: 'integer', visible: true, filterable: ['eq', 'gte', 'lte'] },
          { name: 'city', type: 'string', visible: true, filterable: ['eq', 'in'] },
          { name: 'sqft', type: 'integer', visible: true, filterable: [] },
        ],
      },
      [
        { bedrooms: 1, city: 'Austin', sqft: 600 },
        { bedrooms: 3, city: 'Austin', sqft: 1200 },
        { bedrooms: 2, city: 'Round Rock', sqft: 900 },
      ],
    );
    expect(opts).toEqual([
      [{ field: 'bedrooms', op: 'gte', value: 2 }],
      [{ field: 'bedrooms', op: 'lte', value: 2 }],
      [{ field: 'city', op: 'eq', value: 'Austin' }],
      [{ field: 'city', op: 'eq', value: 'Round Rock' }],
    ]);
  });
});
