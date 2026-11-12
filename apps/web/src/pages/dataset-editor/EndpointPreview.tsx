import { useState } from 'react';
import { exampleFilter, sampleResponse, type DatasetField, type SampleRow } from './model';

export interface EndpointPreviewProps {
  /** `/v1/bluebonnet/datasets/listings/records`. */
  path: string;
  fields: readonly DatasetField[];
  rows: readonly SampleRow[];
  perRecordMicros: number;
}

/** Copy-to-clipboard button; quietly does nothing where the clipboard isn't available. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className="rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-body hover:bg-surface-2"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * Endpoint preview (screens.md §W06): the buyer's records call with an example filter, and sample
 * JSON with the visible fields only, exactly what a buyer would receive.
 */
export function EndpointPreview({ path, fields, rows, perRecordMicros }: EndpointPreviewProps) {
  const filter = exampleFilter(fields);
  const request = `GET ${path}${filter ? `?${filter}` : ''}`;
  const json = sampleResponse(fields, rows, perRecordMicros);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2">
        <code className="min-w-0 truncate font-mono text-xs text-ink" data-endpoint-request="">
          {request}
        </code>
        <CopyButton text={request} label="Copy request" />
      </div>
      <pre
        className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-body"
        data-sample-json=""
        aria-label="Sample response"
      >
        {json}
      </pre>
    </div>
  );
}
