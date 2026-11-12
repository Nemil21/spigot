import { useEffect, useState } from 'react';

/**
 * A PayPal id (order, capture, batch, payout item) in mono with a copy button, so a publisher or
 * buyer can paste it into PayPal's own activity search. Long ids are middle-truncated on screen;
 * the full id is in the tooltip and is what gets copied.
 */
export function PayPalId({
  id,
  label = 'PayPal id',
}: {
  id: string | null | undefined;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!id) return <span className="text-muted">—</span>;
  const shown = id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;

  async function copy() {
    try {
      await navigator.clipboard.writeText(id!);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context or permissions): the id stays selectable.
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <code className="font-mono text-xs text-body select-all" title={id}>
        {shown}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="rounded-sm px-1 text-xs text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
