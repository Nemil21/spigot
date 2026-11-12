import { compileExtractor } from '@spigot/shared';
import { describe, expect, it } from 'vitest';
import { re2Engine } from './adapters.js';
import { baselineOf, countNulls, fieldExtractors, judgeDrift, type NullCounts } from './drift.js';

const counts = (pages: number, nulls: Record<string, number>): NullCounts => ({ pages, nulls });

describe('judgeDrift (features/04 §7)', () => {
  const baseline = { price: 0, city: 0, status: 0.05, pets: 0.1, agent: 0 };
  const required = new Set(['price', 'city']);

  it('no change → no drift', () => {
    const v = judgeDrift(
      baseline,
      counts(20, { price: 0, city: 0, status: 1, pets: 2, agent: 0 }),
      required,
    );
    expect(v).toMatchObject({ drift: false, sampled: 20, reasons: [] });
    expect(v.fields.pets).toEqual({ nullRate: 0.1, baseline: 0.1, required: false });
  });

  it('a required field up by more than 25 points is drift on its own', () => {
    // 6 / 20 = 30% vs 0%.
    const v = judgeDrift(
      baseline,
      counts(20, { price: 6, city: 0, status: 0, pets: 0, agent: 0 }),
      required,
    );
    expect(v.drift).toBe(true);
    expect(v.reasons).toEqual(['required field "price" empty on 30% of pages (was 0%)']);
  });

  it('exactly +25 points is not drift (the rule is "more than")', () => {
    const v = judgeDrift(baseline, counts(20, { price: 5, city: 0 }), required);
    expect(v.drift).toBe(false);
  });

  it('an optional field jumping is not drift unless a second one crosses 40%', () => {
    expect(judgeDrift(baseline, counts(10, { pets: 10, agent: 0 }), required).drift).toBe(false);
    const v = judgeDrift(baseline, counts(10, { pets: 10, agent: 5 }), required);
    expect(v.drift).toBe(true);
    expect(v.reasons).toEqual([
      '2 fields empty on more than 40% of pages: "pets" 100%, "agent" 50%',
    ]);
  });

  it('exactly 40% does not count; fields already above 40% in the baseline do not count', () => {
    expect(judgeDrift(baseline, counts(10, { pets: 4, agent: 4 }), required).drift).toBe(false);
    const sparse = { ...baseline, pets: 0.6 };
    expect(judgeDrift(sparse, counts(10, { pets: 10, agent: 5 }), required).drift).toBe(false);
  });

  it('fields without a baseline are reported but never counted', () => {
    const v = judgeDrift(baseline, counts(10, { newA: 10, newB: 10, pets: 10 }), new Set(['newA']));
    expect(v.drift).toBe(false);
    expect(v.fields.newA).toEqual({ nullRate: 1, baseline: null, required: true });
  });

  it('no pages measured → no drift', () => {
    expect(judgeDrift(baseline, counts(0, { price: 0 }), required)).toMatchObject({
      drift: false,
      sampled: 0,
    });
  });
});

describe('baselineOf', () => {
  it('reads nullRate from SP-012a sample stats and SP-012b self-check stats', () => {
    expect(
      baselineOf({
        source: 'samples',
        fields: { a: { nullRate: 0 }, b: { nullRate: 0.2, distinct: 3 } },
      }),
    ).toEqual({
      a: 0,
      b: 0.2,
    });
    expect(
      baselineOf({ source: 'selfcheck', fields: { a: { nullRate: 0.05, typeConformance: 1 } } }),
    ).toEqual({ a: 0.05 });
  });

  it('null when there is nothing to compare with', () => {
    expect(baselineOf(null)).toBeNull();
    expect(baselineOf({})).toBeNull();
    expect(baselineOf({ fields: { a: {} } })).toBeNull();
    expect(baselineOf({ fields: { a: { nullRate: 'x' } } })).toBeNull();
  });
});

describe('countNulls', () => {
  const { spec } = compileExtractor(
    {
      recordKey: { from: 'url' },
      fields: [
        {
          name: 'price',
          type: 'integer',
          required: true,
          source: { jsonld: '$.offers.price' },
          transforms: ['toInt'],
        },
        { name: 'pets', type: 'string', source: { css: 'dl.facts dd[data-k=pets]', attr: 'text' } },
        { name: 'tags', type: 'string[]', source: { css: '.tag', attr: 'text', all: true } },
      ],
    },
    { regex: re2Engine },
  );
  const page = (body: string, price: number | null = 1500) => ({
    url: 'https://x.test/listings/a',
    html: `<html><head>${
      price === null
        ? ''
        : `<script type="application/ld+json">{"@type":"Offer","offers":{"price":"${price}"}}</script>`
    }</head><body>${body}</body></html>`,
  });

  it('counts per field, even when a required field empties the whole record', () => {
    const c = countNulls(fieldExtractors(spec), [
      page('<dl class="facts"><dd data-k="pets">Yes</dd></dl><span class="tag">a</span>'),
      page('<dl class="specs"><dd data-spec="pets">Yes</dd></dl>'),
      page('<dl class="facts"><dd data-k="pets">No</dd></dl>', null),
    ]);
    expect(c).toEqual({ pages: 3, nulls: { price: 1, pets: 1, tags: 2 } });
  });

  it('accumulates into an existing count', () => {
    const into = countNulls(fieldExtractors(spec), [page('')]);
    countNulls(
      fieldExtractors(spec),
      [page('<dl class="facts"><dd data-k="pets">Yes</dd></dl>')],
      into,
    );
    expect(into).toEqual({ pages: 2, nulls: { price: 0, pets: 1, tags: 2 } });
  });
});
