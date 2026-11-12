import { PAYOUT_ITEM_STATUSES, TOPUP_STATUSES } from '@spigot/shared/copy';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import {
  EmptyState,
  ErrorBanner,
  Kpi,
  Money,
  PayPalId,
  SimChip,
  Skeleton,
  StatusPill,
} from './index';

describe('Money', () => {
  it('shows micros exactly, in tabular figures, with the micros in the tooltip', () => {
    render(<Money micros={55_500} />);
    const el = screen.getByText('$0.0555');
    expect(el).toHaveClass('tabular-nums');
    expect(el).toHaveAttribute('title', '55,500 micros');
  });

  it('shows PayPal cents and still gives micros in the tooltip', () => {
    render(<Money cents={41_275} />);
    expect(screen.getByText('$412.75')).toHaveAttribute('title', '412,750,000 micros');
  });

  it('appends money-copy-rule words from @spigot/shared/copy', () => {
    const { container } = render(
      <>
        <Money micros={55_500} word="charged" />
        <Money micros={55_500} word="credited" />
        <Money cents={740} word="refundedToPayPal" />
        <Money cents={41_275} word="paidOut" />
        <Money cents={41_275} word="waitingToClaim" />
      </>,
    );
    expect([...container.querySelectorAll('span')].map((s) => s.textContent)).toEqual([
      '$0.0555 charged',
      '$0.0555 credited',
      '$7.40 refunded to PayPal',
      '$412.75 paid out',
      '$412.75 waiting for you to claim',
    ]);
  });

  it('shows rates per 1,000 ("$1.50 / 1,000 records")', () => {
    render(<Money micros={1_500} per1000="records" />);
    expect(screen.getByText('$1.50 / 1,000 records')).toHaveAttribute('title', '1,500,000 micros');
  });

  it('loads as a skeleton, never a spinner', () => {
    const { container } = render(<Money micros={1} loading />);
    expect(container.querySelector('[data-skeleton]')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('$');
    expect(container.querySelector('[role="progressbar"], [aria-label*="oading"]')).toBeNull();
  });

  it('refuses a float, so a rounding error never reaches the screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Money micros={0.5} />)).toThrow(RangeError);
    vi.restoreAllMocks();
  });
});

describe('SimChip', () => {
  it('labels simulated rows', () => {
    render(<SimChip />);
    expect(screen.getByText('SIM')).toHaveAttribute('title', 'Simulated demo data');
  });

  it('labels a ledger-only SIM top-up', () => {
    render(<SimChip noPayPal />);
    expect(screen.getByText('SIM (no PayPal)')).toBeInTheDocument();
  });
});

describe('StatusPill', () => {
  it('words every payout and top-up status with the copy-rule words', () => {
    const { container } = render(
      <>
        {PAYOUT_ITEM_STATUSES.map((s) => (
          <StatusPill key={`p${s}`} kind="payout" status={s} />
        ))}
        {TOPUP_STATUSES.map((s) => (
          <StatusPill key={`t${s}`} kind="topup" status={s} />
        ))}
      </>,
    );
    const pills = [...container.querySelectorAll('[data-status]')].map(
      (el) =>
        `${el.getAttribute('data-status')} [${el.getAttribute('data-tone')}] ${el.textContent}`,
    );
    expect(pills).toMatchInlineSnapshot(`
      [
        "PENDING [info] Sent",
        "SUCCESS [positive] Paid out",
        "UNCLAIMED [warning] Waiting for you to claim",
        "FAILED [danger] Failed → retrying next batch",
        "RETURNED [danger] Returned → retrying next batch",
        "CREATED [neutral] Started",
        "AWAITING_APPROVAL [info] Waiting for PayPal approval",
        "COMPLETED [positive] Added via PayPal",
        "FAILED [danger] PayPal couldn't complete this payment",
        "ABANDONED [neutral] Not approved in PayPal",
        "PARTIALLY_REFUNDED [warning] Partly refunded to PayPal",
        "REFUNDED [neutral] Refunded to PayPal",
      ]
    `);
  });
});

describe('PayPalId', () => {
  it('truncates long ids on screen and copies the full id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const id = '5O190127TN364715TABCDEFGH';
    render(<PayPalId id={id} label="PayPal order id" />);
    expect(screen.getByText('5O190127…CDEFGH')).toHaveAttribute('title', id);
    await userEvent.click(screen.getByRole('button', { name: 'Copy PayPal order id' }));
    expect(writeText).toHaveBeenCalledWith(id);
    expect(screen.getByRole('button', { name: 'Copy PayPal order id' })).toHaveTextContent(
      'Copied',
    );
  });

  it('shows a dash when there is no id yet', () => {
    render(<PayPalId id={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('shared states', () => {
  it('Kpi shows a skeleton while loading, then the value and hint', () => {
    const { rerender, container } = render(
      <Kpi label="Earned this week" value={<Money micros={1} />} hint="incl. $1 SIM" loading />,
    );
    expect(container.querySelector('[data-skeleton]')).toBeInTheDocument();
    expect(screen.queryByText('incl. $1 SIM')).toBeNull();
    rerender(<Kpi label="Earned this week" value={<Money cents={41_275} />} hint="incl. $1 SIM" />);
    expect(screen.getByText('$412.75')).toBeInTheDocument();
    expect(screen.getByText('incl. $1 SIM')).toBeInTheDocument();
  });

  it('ErrorBanner shows the API message and retries', () => {
    const onRetry = vi.fn();
    render(
      <ErrorBanner
        error={new ApiError(500, 'INTERNAL_ERROR', 'Database unavailable.')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Database unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('EmptyState is one sentence and one action', () => {
    render(
      <MemoryRouter>
        <EmptyState
          message="Install the gate to see who's crawling you."
          action={{ label: 'Install the gate', to: '/app/install' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Install the gate' })).toHaveAttribute(
      'href',
      '/app/install',
    );
  });

  it('Skeleton is hidden from assistive tech', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});
