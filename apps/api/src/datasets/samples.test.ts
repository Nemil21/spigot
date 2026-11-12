import { describe, expect, it } from 'vitest';
import { AUTO_SCHEMA_LABEL } from '../schema-agent/fallback.js';
import { fieldView, isAutoSchema, sourceOf } from './samples.js';

const extractor = (...sources: Record<string, unknown>[]) => ({
  recordKey: { from: 'url' },
  fields: sources.map((source, i) => ({ name: `f${i}`, type: 'string', source })),
});
const ai = { ai_model: 'claude-x', proposed_by: 'AI' };

describe('sourceOf', () => {
  it('names JSON-LD types and counts CSS fields', () => {
    expect(
      sourceOf(
        extractor({ jsonld: '$.name' }, { css: '.a' }, { css: '.b' }),
        ['Apartment', 'Offer'],
        ai,
      ),
    ).toEqual({ badge: 'JSON-LD', source: 'JSON-LD (Apartment, Offer) + 2 CSS fields' });
    expect(sourceOf(extractor({ css: '.a' }), null, ai)).toEqual({
      badge: 'CSS',
      source: 'CSS (1 CSS field)',
    });
  });

  it('labels a version with no model behind it "auto (no AI)"', () => {
    const auto = sourceOf(extractor({ jsonld: '$.name' }), ['Apartment'], {
      ai_model: AUTO_SCHEMA_LABEL,
      proposed_by: 'AI',
    });
    expect(auto.badge).toBe('auto (no AI)');
    expect(auto.source).toBe('auto (no AI): JSON-LD (Apartment)');
    expect(isAutoSchema({ ai_model: 'claude-x', proposed_by: 'AI' })).toBe(false);
    expect(isAutoSchema({ ai_model: null, proposed_by: 'AI' })).toBe(false);
    expect(isAutoSchema({ ai_model: AUTO_SCHEMA_LABEL, proposed_by: 'OWNER' })).toBe(false);
  });
});

describe('fieldView', () => {
  const stored = [
    {
      name: 'price',
      type: 'integer',
      visible: true,
      pii: false,
      rights_flag: false,
      filterable: ['gte'],
    },
    { name: 'phone', type: 'string', visible: false, pii: true, filterable: [] },
    { name: 'byline', type: 'string', visible: 'yes', rightsFlag: true },
    { type: 'string' },
  ];
  const rows = [
    { price: 1, phone: '(512) 555-0100', byline: null },
    { price: 2, phone: null, byline: null },
  ];

  it('prefers sample_stats, falls back to the rows (hidden-field examples included)', () => {
    const stats = {
      fields: { price: { nullRate: 0.25, example: 1850 }, phone: { nullRate: 0.5 } },
    };
    expect(fieldView(stored, stats, rows)).toEqual([
      {
        name: 'price',
        type: 'integer',
        description: null,
        visible: true,
        pii: false,
        rightsFlag: false,
        filterable: ['gte'],
        nullRate: 0.25,
        example: 1850,
      },
      {
        name: 'phone',
        type: 'string',
        description: null,
        visible: false,
        pii: true,
        rightsFlag: false,
        filterable: [],
        nullRate: 0.5,
        example: '(512) 555-0100',
      },
      {
        name: 'byline',
        type: 'string',
        description: null,
        visible: false,
        pii: false,
        rightsFlag: true,
        filterable: [],
        nullRate: 1,
        example: null,
      },
    ]);
  });

  it('no rows and no stats → null rate unknown', () => {
    expect(fieldView(stored, null, [])[0]).toMatchObject({ nullRate: null, example: null });
    expect(fieldView('nope', null, rows)).toEqual([]);
  });
});
