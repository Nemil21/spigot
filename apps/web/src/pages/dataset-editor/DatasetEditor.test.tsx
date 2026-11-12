import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { commissionSplit } from '@spigot/shared/money';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import proposedFixture from '../../fixtures/api/datasets/_.json';
import liveFixture from '../../fixtures/api/datasets/fx-live.json';
import { DatasetEditorScreen } from '../DatasetEditor';
import {
  buyerLine,
  editsOf,
  fieldChanges,
  microsToPer1000Input,
  per1000InputToMicros,
  rightsFlagText,
  toggleVisible,
  type DatasetDetail,
  type DatasetField,
} from './model';
import { HIDDEN_CELL_CLASS, SchemaGrid, cellKind, schemaColumnDefs } from './SchemaGrid';

const PROPOSED = proposedFixture as unknown as DatasetDetail;
const LIVE = liveFixture as unknown as DatasetDetail;
const ID = PROPOSED.id;
const SITE_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const NEW_VERSION = '00000000-0000-4000-8000-0000000000e9';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake API over the W06 endpoints. `runs` is consumed one per crawl-runs read. */
function fakeApi(
  opts: {
    detail?: DatasetDetail;
    afterPublish?: DatasetDetail;
    runs?: string[];
    approve?: () => Response;
  } = {},
) {
  const calls: Call[] = [];
  let detail = structuredClone(opts.detail ?? PROPOSED);
  const runs = [...(opts.runs ?? ['RUNNING', 'SUCCEEDED'])];
  let approved = false;
  const fetch: FetchLike = async (path, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path === `/api/datasets/${detail.id}`) {
      return json(200, approved && opts.afterPublish ? opts.afterPublish : detail);
    }
    if (method === 'PATCH' && path === `/api/datasets/${detail.id}`) {
      const b = body as { fields?: unknown[]; perRecordMicros?: number; perChangeMicros?: number };
      detail = {
        ...detail,
        prices: {
          perRecordMicros: b.perRecordMicros ?? detail.prices.perRecordMicros,
          perChangeMicros: b.perChangeMicros ?? detail.prices.perChangeMicros,
        },
      };
      return json(200, {
        dataset: { id: detail.id, slug: detail.slug, status: detail.status, ...detail.prices },
        schemaVersion: b.fields
          ? { id: NEW_VERSION, version: 2, status: 'PROPOSED', proposedBy: 'OWNER' }
          : null,
      });
    }
    if (method === 'POST' && path === `/api/datasets/${detail.id}/approve`) {
      if (opts.approve) return opts.approve();
      if (approved) {
        return json(409, { error: { code: 'STATE_CONFLICT', message: 'Already live.' } });
      }
      approved = true;
      return json(200, { status: 'LIVE', endpoint: PROPOSED.endpoint, crawlRunId: RUN_ID });
    }
    if (method === 'POST' && path === `/api/datasets/${detail.id}/unpublish`) {
      detail = { ...detail, status: 'UNPUBLISHED' };
      return json(200, { status: 'UNPUBLISHED' });
    }
    if (method === 'GET' && path === '/api/sites') {
      return json(200, { sites: [{ id: SITE_ID, slug: 'bluebonnet' }] });
    }
    if (method === 'GET' && path.startsWith(`/api/sites/${SITE_ID}/crawl-runs`)) {
      const status = runs.length > 1 ? runs.shift()! : (runs[0] ?? 'SUCCEEDED');
      return json(200, {
        runs: [
          {
            id: RUN_ID,
            trigger: 'APPROVE',
            status,
            pagesTotal: 2341,
            pagesFetched: status === 'RUNNING' ? 1200 : 2341,
            error: null,
          },
        ],
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${path}` } });
  };
  return { calls, client: createApiClient({ fetch, fixtures: false }) };
}

function renderEditor(api: ReturnType<typeof fakeApi>, datasetId = ID) {
  return render(
    <MemoryRouter>
      <DatasetEditorScreen
        datasetId={datasetId}
        client={api.client}
        sse={{ enabled: false }}
        pollMs={20}
      />
    </MemoryRouter>,
  );
}

const headerNames = () =>
  [...document.querySelectorAll('[data-schema-grid] .ag-header-cell-text')].map(
    (e) => e.textContent,
  );

const sampleJson = () =>
  JSON.parse(document.querySelector('[data-sample-json]')!.textContent!) as {
    records: { data: Record<string, unknown> }[];
  };

// ------------------------------------------------------------------------------------------------

describe('schemaColumnDefs (columns generated from schema_versions.fields)', () => {
  it('one column per field, in schema order, typed renderers, hidden ones struck through', () => {
    const defs = schemaColumnDefs(PROPOSED.fields);
    expect(defs.map((d) => d.colId)).toEqual(PROPOSED.fields.map((f) => f.name));
    const by = Object.fromEntries(defs.map((d) => [d.colId, d]));
    expect(by.price_usd!.context).toMatchObject({ kind: 'money', hidden: false });
    expect(by.bedrooms!.context).toMatchObject({ kind: 'number' });
    expect(by.available_from!.context).toMatchObject({ kind: 'date' });
    expect(by.pets_allowed!.context).toMatchObject({ kind: 'boolean' });
    expect(by.url!.context).toMatchObject({ kind: 'url' });
    expect(by.title!.context).toMatchObject({ kind: 'text' });
    // agent_phone (PII) and photo_credit (rights) are hidden by default.
    expect(by.agent_phone).toMatchObject({
      headerName: 'agent_phone (hidden)',
      cellClass: HIDDEN_CELL_CLASS,
      headerClass: HIDDEN_CELL_CLASS,
    });
    expect(by.title).toMatchObject({ headerName: 'title', cellClass: undefined });
  });

  it('maps every schema type to a renderer kind', () => {
    const k = (name: string, type: string) => cellKind({ name, type });
    expect(k('deposit_cents', 'integer')).toBe('money');
    expect(k('sqft', 'integer')).toBe('number');
    expect(k('listed_at', 'datetime')).toBe('date');
    expect(k('tags', 'string[]')).toBe('list');
    expect(k('anything', 'mystery')).toBe('text');
  });

  it('renders the 20 sample rows with money, boolean chips and safe links', async () => {
    render(<SchemaGrid fields={PROPOSED.fields} rows={PROPOSED.sampleRows} />);
    await waitFor(() => expect(headerNames()).toContain('price_usd'));
    expect(headerNames()).toContain('agent_phone (hidden)');
    const firstPrice = PROPOSED.sampleRows[0]!.price_usd as number;
    expect(await screen.findAllByText(`$${firstPrice.toLocaleString('en-US')}`)).not.toHaveLength(
      0,
    );
    expect(document.querySelector('[data-bool="true"]')).toHaveTextContent('Yes');
    const link = screen.getAllByRole('link')[0]!;
    expect(link).toHaveAttribute('href', expect.stringMatching(/^https:\/\//));
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never links a javascript: URL', async () => {
    const fields: DatasetField[] = [{ ...PROPOSED.fields.find((f) => f.name === 'url')! }];
    render(<SchemaGrid fields={fields} rows={[{ url: 'javascript:alert(1)' }]} />);
    expect(await screen.findByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('W06 model', () => {
  it('parses prices per 1,000 without floats, within $0.10–$100', () => {
    expect(per1000InputToMicros('1.50')).toBe(1500);
    expect(per1000InputToMicros('$1.537')).toBe(1537);
    expect(per1000InputToMicros('0.1')).toBe(100);
    expect(per1000InputToMicros('100')).toBe(100_000);
    expect(per1000InputToMicros('.5')).toBe(500);
    expect(per1000InputToMicros('1.5375')).toBeNull();
    expect(per1000InputToMicros('abc')).toBeNull();
    expect(per1000InputToMicros('')).toBeNull();
    expect(microsToPer1000Input(1500)).toBe('1.50');
    expect(microsToPer1000Input(1537)).toBe('1.537');
    expect(microsToPer1000Input(100_000)).toBe('100.00');
  });

  it('the buyer line matches commissionSplit, including odd prices', () => {
    expect(buyerLine(2341, 1500, 'listings').text).toBe(
      "A buyer pulling all 2,341 listings pays $3.5115; you get $2.8092 after Spigot's 20%",
    );
    for (const [count, unit] of [
      [2341, 1537],
      [88, 101],
      [40, 99_999],
      [7, 333],
      [1, 100],
    ] as const) {
      const line = buyerLine(count, unit, 'records');
      const split = commissionSplit(count * unit, 2000);
      expect(line.totalMicros).toBe(count * unit);
      expect(line.commissionMicros).toBe(split.commission);
      expect(line.publisherMicros).toBe(split.publisher);
      expect(line.commissionMicros + line.publisherMicros).toBe(count * unit);
    }
  });

  it('PATCH diff: only changed fields; hiding clears the filter; no-op toggles cancel out', () => {
    const base = editsOf(PROPOSED.fields);
    expect(fieldChanges(base, base)).toEqual([]);
    const hidden = toggleVisible(base, 'price_usd');
    expect(hidden.price_usd).toEqual({ visible: false, filterable: false });
    expect(fieldChanges(base, hidden)).toEqual([{ name: 'price_usd', visible: false }]);
    expect(fieldChanges(base, toggleVisible(hidden, 'price_usd'))).toEqual([
      { name: 'price_usd', filterable: false },
    ]);
  });

  it('names the wire service in the rights flag', () => {
    expect(rightsFlagText({ example: 'Photo: AP / Eric Gay' })).toBe(
      "Byline 'AP' found: excluded by default",
    );
    expect(rightsFlagText({ example: 'staff photo' })).toBe(
      'Wire-service byline found: excluded by default',
    );
  });
});

describe('W06 dataset editor screen', () => {
  it('loads a proposal: field list with PII and rights badges, price line, endpoint preview', async () => {
    renderEditor(fakeApi());
    expect(
      await screen.findByRole('heading', { name: 'Listing · 2,341 records' }),
    ).toBeInTheDocument();
    const phone = document.querySelector('[data-field="agent_phone"]')!;
    expect(within(phone as HTMLElement).getByText('PII')).toBeInTheDocument();
    expect(screen.getByText("Byline 'AP' found: excluded by default")).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Sell agent_phone' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Filterable: agent_phone' })).toBeDisabled();
    expect(document.querySelector('[data-buyer-line]')).toHaveTextContent(
      "A buyer pulling all 2,341 listings pays $3.5115; you get $2.8092 after Spigot's 20%",
    );
    expect(document.querySelector('[data-endpoint-request]')).toHaveTextContent(
      /^GET \/v1\/bluebonnet\/datasets\/listings\/records\?price_usd\[gte\]=\d+$/,
    );
    const sample = sampleJson();
    expect(sample.records[0]!.data).not.toHaveProperty('agent_phone');
    expect(sample.records[0]!.data).toHaveProperty('city');
  });

  it('hiding a field updates the grid and the sample JSON instantly (no request)', async () => {
    const api = fakeApi();
    renderEditor(api);
    await waitFor(() => expect(headerNames()).toContain('city'));
    const before = api.calls.length;
    await userEvent.click(screen.getByRole('switch', { name: 'Sell city' }));
    await waitFor(() => expect(headerNames()).toContain('city (hidden)'));
    expect(headerNames()).not.toContain('city');
    expect(document.querySelectorAll(`[col-id="city"].spigot-hidden-field`).length).toBeGreaterThan(
      0,
    );
    expect(sampleJson().records[0]!.data).not.toHaveProperty('city');
    expect(screen.getByRole('button', { name: 'Filterable: city' })).toBeDisabled();
    expect(api.calls.length).toBe(before);
  });

  it('price edits update the buyer line live; out-of-bounds blocks Publish', async () => {
    renderEditor(fakeApi());
    const input = await screen.findByLabelText('Per record');
    await userEvent.clear(input);
    await userEvent.type(input, '1.537');
    const split = commissionSplit(2341 * 1537, 2000);
    expect(split).toEqual({ commission: 719_623, publisher: 2_878_494 });
    expect(document.querySelector('[data-buyer-line]')).toHaveTextContent(
      'pays $3.598117; you get $2.878494',
    );
    await userEvent.clear(input);
    await userEvent.type(input, '0.05');
    expect(screen.getByText('Between $0.10 and $100 per 1,000.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('validation: no visible fields, rights not ticked', async () => {
    const api = fakeApi();
    renderEditor(api);
    await screen.findByRole('button', { name: 'Publish' });
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByText('Confirm you own or may license these fields.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);

    for (const f of PROPOSED.fields.filter((x) => x.visible)) {
      await userEvent.click(screen.getByRole('switch', { name: `Sell ${f.name}` }));
    }
    expect(screen.getByText('Pick at least one field to sell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('Publish: PATCH (edits only) → approve the new version → progress → live card', async () => {
    const api = fakeApi({ afterPublish: LIVE, runs: ['RUNNING', 'RUNNING', 'SUCCEEDED'] });
    renderEditor(api);
    await userEvent.click(await screen.findByRole('switch', { name: 'Sell agent_name' }));
    const input = screen.getByLabelText('Per record');
    await userEvent.clear(input);
    await userEvent.type(input, '1.537');
    await userEvent.click(screen.getByRole('checkbox', { name: /I own this content/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByRole('status', { name: 'Publishing' })).toHaveTextContent(
      'Publishing: extracting all pages',
    );
    const card = await screen.findByRole('region', { name: 'Live' });
    expect(card).toHaveTextContent('Your gate now sends bots here.');
    expect(within(card).getByText(PROPOSED.endpoint!)).toBeInTheDocument();

    const writes = api.calls.filter((c) => c.method !== 'GET');
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `/api/datasets/${ID}`,
        body: { fields: [{ name: 'agent_name', visible: false }], perRecordMicros: 1537 },
      },
      {
        method: 'POST',
        path: `/api/datasets/${ID}/approve`,
        body: { schemaVersionId: NEW_VERSION, rightsAttested: true },
      },
    ]);
    expect(api.calls.some((c) => c.path.startsWith(`/api/sites/${SITE_ID}/crawl-runs`))).toBe(true);
    // Reloaded as LIVE: fields are read-only now.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Sell title' })).toBeDisabled());
  });

  it('Publish with no edits approves the proposal as it is (no PATCH)', async () => {
    const api = fakeApi({ afterPublish: LIVE });
    renderEditor(api);
    await userEvent.click(await screen.findByRole('checkbox', { name: /I own this content/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByRole('region', { name: 'Live' });
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([
      {
        method: 'POST',
        path: `/api/datasets/${ID}/approve`,
        body: { schemaVersionId: PROPOSED.latestSchemaVersion!.id, rightsAttested: true },
      },
    ]);
  });

  it('a retry after a failed approve does not PATCH again and approves the saved version', async () => {
    let fail = true;
    const api = fakeApi({
      afterPublish: LIVE,
      approve: () => {
        if (fail) {
          fail = false;
          return json(503, { error: { code: 'INTERNAL', message: 'Try again in a moment.' } });
        }
        return json(200, { status: 'LIVE', endpoint: PROPOSED.endpoint, crawlRunId: RUN_ID });
      },
    });
    renderEditor(api);
    await userEvent.click(await screen.findByRole('switch', { name: 'Sell agent_name' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /I own this content/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a moment.');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByRole('region', { name: 'Live' });
    const writes = api.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => c.method)).toEqual(['PATCH', 'POST', 'POST']);
    expect(writes[2]!.body).toEqual({ schemaVersionId: NEW_VERSION, rightsAttested: true });
  });

  it('a double click publishes once', async () => {
    const api = fakeApi({ afterPublish: LIVE });
    renderEditor(api);
    await userEvent.click(await screen.findByRole('checkbox', { name: /I own this content/ }));
    const btn = screen.getByRole('button', { name: 'Publish' });
    await act(async () => {
      btn.click();
      btn.click();
    });
    await screen.findByRole('region', { name: 'Live' });
    expect(api.calls.filter((c) => c.path.endsWith('/approve'))).toHaveLength(1);
  });

  it('approve 409 (already published elsewhere): reloads and says why', async () => {
    const api = fakeApi({
      approve: () =>
        json(409, { error: { code: 'STATE_CONFLICT', message: 'This dataset is already LIVE.' } }),
    });
    renderEditor(api);
    await userEvent.click(await screen.findByRole('checkbox', { name: /I own this content/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This dataset is already LIVE.');
    expect(
      api.calls.filter((c) => c.method === 'GET' && c.path === `/api/datasets/${ID}`),
    ).toHaveLength(2);
  });

  it('a LIVE dataset: live card, read-only fields, price save, Unpublish', async () => {
    const api = fakeApi({ detail: LIVE });
    renderEditor(api, LIVE.id);
    const card = await screen.findByRole('region', { name: 'Live' });
    expect(card).toHaveTextContent('Your gate now sends bots here.');
    expect(screen.getByRole('switch', { name: 'Sell title' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();

    const input = screen.getByLabelText('Per record');
    await userEvent.clear(input);
    await userEvent.type(input, '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    expect(await screen.findByText(/Prices saved/)).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'Unpublish' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Unpublish dataset' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));
    await waitFor(() =>
      expect(document.querySelector('[data-dataset-status]')).toHaveAttribute(
        'data-dataset-status',
        'UNPUBLISHED',
      ),
    );
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([
      { method: 'PATCH', path: `/api/datasets/${LIVE.id}`, body: { perRecordMicros: 2000 } },
      { method: 'POST', path: `/api/datasets/${LIVE.id}/unpublish`, body: {} },
    ]);
  });

  describe('LIVE_STALE (drift)', () => {
    /** After drift, before re-inference: the latest version is the active APPROVED one. */
    const STALE: DatasetDetail = {
      ...LIVE,
      status: 'LIVE_STALE',
      staleSince: '2026-11-12T08:00:00.000Z',
    };

    it('latest version APPROVED: Save prices saves prices only; Publish is off with a reason', async () => {
      const api = fakeApi({ detail: STALE });
      renderEditor(api, STALE.id);
      expect(await screen.findByText(/The page layout changed/)).toBeInTheDocument();
      const publish = screen.getByRole('button', { name: 'Publish' });
      expect(publish).toBeDisabled();
      expect(document.querySelector('[data-validation="nothing-to-approve"]')).toHaveTextContent(
        'Nothing new to publish',
      );

      const input = screen.getByLabelText('Per record');
      await userEvent.clear(input);
      await userEvent.type(input, '2');
      // A field edit made alongside isn't sent by Save prices (it goes out with Publish).
      await userEvent.click(screen.getByRole('switch', { name: 'Sell agent_name' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save prices' }));
      expect(await screen.findByText(/Prices saved/)).toBeInTheDocument();
      expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([
        { method: 'PATCH', path: `/api/datasets/${STALE.id}`, body: { perRecordMicros: 2000 } },
      ]);
    });

    it('latest version APPROVED + a field edit: Publish makes a new version and approves it', async () => {
      const api = fakeApi({ detail: STALE, afterPublish: LIVE });
      renderEditor(api, STALE.id);
      await userEvent.click(await screen.findByRole('switch', { name: 'Sell agent_name' }));
      await userEvent.click(screen.getByRole('checkbox', { name: /I own this content/ }));
      const publish = screen.getByRole('button', { name: 'Publish' });
      expect(publish).toBeEnabled();
      await userEvent.click(publish);
      await screen.findByRole('region', { name: 'Live' });
      expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([
        {
          method: 'PATCH',
          path: `/api/datasets/${STALE.id}`,
          body: { fields: [{ name: 'agent_name', visible: false }] },
        },
        {
          method: 'POST',
          path: `/api/datasets/${STALE.id}/approve`,
          body: { schemaVersionId: NEW_VERSION, rightsAttested: true },
        },
      ]);
    });

    it('a re-inferred PROPOSED v(n+1): Publish approves it as it is', async () => {
      const proposed: DatasetDetail = {
        ...STALE,
        latestSchemaVersion: { id: NEW_VERSION, version: 3, status: 'PROPOSED', proposedBy: 'AI' },
      };
      const api = fakeApi({ detail: proposed, afterPublish: LIVE });
      renderEditor(api, proposed.id);
      await userEvent.click(await screen.findByRole('checkbox', { name: /I own this content/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
      await screen.findByRole('region', { name: 'Live' });
      expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([
        {
          method: 'POST',
          path: `/api/datasets/${proposed.id}/approve`,
          body: { schemaVersionId: NEW_VERSION, rightsAttested: true },
        },
      ]);
    });
  });

  it('shows the API error with retry when the dataset fails to load', async () => {
    const api = fakeApi();
    renderEditor(api, 'missing');
    expect(await screen.findByRole('alert')).toHaveTextContent("This didn't load.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
