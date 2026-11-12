import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../../api/client';
import versionsFixture from '../../fixtures/api/records/_/versions.json';
import { diffVersions, type RecordHistory, type RecordVersion } from './model';
import { VersionDrawer } from './VersionDrawer';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const REC = '00000000-0000-4000-8000-000000001000';
const history = versionsFixture as unknown as RecordHistory;

function clientWith(fetchImpl: FetchLike) {
  return createApiClient({ fetch: fetchImpl, fixtures: false });
}

describe('diffVersions', () => {
  it('replays the patches to show before → after, newest version first', () => {
    const [v2, v1] = diffVersions(history.versions, history.hiddenFields);
    expect(v2!.version.version).toBe(2);
    expect(v2!.beforeKnown).toBe(true);
    expect(v2!.lines).toEqual([
      {
        field: 'price_usd',
        path: '/price_usd',
        kind: 'changed',
        before: 1850,
        after: 1200,
        hidden: false,
      },
      {
        field: 'status',
        path: '/status',
        kind: 'changed',
        before: 'available',
        after: 'leased',
        hidden: false,
      },
      {
        field: 'agent_phone',
        path: '/agent_phone',
        kind: 'changed',
        before: '(512) 555-0199',
        after: '(512) 555-0100',
        hidden: true,
      },
    ]);
    expect(v1!.lines.every((l) => l.kind === 'added')).toBe(true);
    expect(v1!.lines.find((l) => l.field === 'agent_phone')?.hidden).toBe(true);
  });

  it('marks before-values unknown when history is cut by retention (no add)', () => {
    const update: RecordVersion = {
      seq: 9,
      version: 7,
      op: 'update',
      changedAt: '2026-11-12T09:00:00.000Z',
      crawlRunId: null,
      patch: [{ op: 'replace', path: '/price_usd', value: 1500 }],
    };
    const [d] = diffVersions([update], []);
    expect(d!.beforeKnown).toBe(false);
    expect(d!.lines[0]).toMatchObject({ kind: 'changed', before: undefined, after: 1500 });
  });

  it('handles field add / remove, nested paths, a removal and a revival', () => {
    const vs: RecordVersion[] = [
      {
        seq: 1,
        version: 1,
        op: 'add',
        changedAt: 'x',
        crawlRunId: null,
        patch: [{ op: 'add', path: '', value: { a: 1, tags: ['x'] } }],
      },
      {
        seq: 2,
        version: 2,
        op: 'update',
        changedAt: 'x',
        crawlRunId: null,
        patch: [
          { op: 'add', path: '/b', value: 2 },
          { op: 'remove', path: '/a' },
          { op: 'add', path: '/tags/1', value: 'y' },
        ],
      },
      {
        seq: 3,
        version: 3,
        op: 'remove',
        changedAt: 'x',
        crawlRunId: null,
        patch: [{ op: 'remove', path: '' }],
      },
      {
        seq: 4,
        version: 4,
        op: 'add',
        changedAt: 'x',
        crawlRunId: null,
        patch: [{ op: 'add', path: '', value: { b: 3 } }],
      },
    ];
    const [v4, , v2] = diffVersions([...vs].reverse(), []);
    expect(v2!.lines).toEqual([
      { field: 'b', path: '/b', kind: 'added', before: undefined, after: 2, hidden: false },
      { field: 'a', path: '/a', kind: 'removed', before: 1, after: undefined, hidden: false },
      {
        field: 'tags',
        path: '/tags/1',
        kind: 'added',
        before: undefined,
        after: 'y',
        hidden: false,
      },
    ]);
    expect(v4!.lines).toEqual([
      { field: 'b', path: '/b', kind: 'added', before: undefined, after: 3, hidden: false },
    ]);
  });
});

describe('diffVersions: array inserts', () => {
  it('shows an add at an existing array index as added, not as a change of the shifted element', () => {
    const vs: RecordVersion[] = [
      {
        seq: 1,
        version: 1,
        op: 'add',
        changedAt: 'x',
        crawlRunId: null,
        patch: [{ op: 'add', path: '', value: { tags: ['x'] } }],
      },
      {
        seq: 2,
        version: 2,
        op: 'update',
        changedAt: 'x',
        crawlRunId: null,
        patch: [{ op: 'add', path: '/tags/0', value: 'w' }],
      },
    ];
    const [v2] = diffVersions([...vs].reverse(), []);
    expect(v2!.lines).toEqual([
      {
        field: 'tags',
        path: '/tags/0',
        kind: 'added',
        before: undefined,
        after: 'w',
        hidden: false,
      },
    ]);
  });
});

describe('VersionDrawer', () => {
  it('lists versions and shows the selected version as a diff, hidden fields marked', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(200, history));
    const user = userEvent.setup();
    render(
      <VersionDrawer
        recordId={REC}
        recordKey={history.record.key}
        client={clientWith(fetchImpl)}
        onClose={() => {}}
      />,
    );

    expect(fetchImpl).toHaveBeenCalledWith(`/api/records/${REC}/versions`, expect.anything());
    const list = await screen.findByRole('list', { name: 'Versions' });
    const items = within(list).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^v2 updated · 3 fields/),
      expect.stringMatching(/^v1 added/),
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'true');

    // Newest version open by default: before → after per field.
    const v2 = screen.getByRole('region', { name: 'Changes in version 2' });
    const price = v2.querySelector('[data-field="price_usd"]') as HTMLElement;
    expect(within(price).getByText('1,850')).toHaveAttribute('data-before');
    expect(within(price).getByText('→ 1,200')).toHaveAttribute('data-after');
    const phone = v2.querySelector('[data-field="agent_phone"]') as HTMLElement;
    expect(within(phone).getByText('hidden')).toBeInTheDocument();
    expect(within(phone).getByText('agent_phone')).toHaveClass('line-through');
    // The stored patch, folded.
    expect(JSON.parse(v2.querySelector('[data-patch]')!.textContent!)).toEqual(
      history.versions[0]!.patch,
    );

    await user.click(items[1]!);
    const v1 = screen.getByRole('region', { name: 'Changes in version 1' });
    expect(v1.querySelectorAll('[data-kind="added"]')).toHaveLength(8);
    expect(items[1]).toHaveAttribute('aria-current', 'true');
  });

  it('says so when there is no history, and retries after an error', async () => {
    let calls = 0;
    const fetchImpl = vi.fn<FetchLike>(async () =>
      ++calls === 1
        ? json(500, { error: { code: 'INTERNAL', message: 'Database unavailable.' } })
        : json(200, { ...history, versions: [] }),
    );
    const user = userEvent.setup();
    render(
      <VersionDrawer
        recordId={REC}
        recordKey="listings/x"
        client={clientWith(fetchImpl)}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No changes recorded in the last 30 days/)).toBeInTheDocument();
  });

  it('closes on Escape and on the Close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <VersionDrawer
        recordId={REC}
        recordKey="listings/x"
        client={clientWith(async () => json(200, history))}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
