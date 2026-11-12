import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom draws canvas through @napi-rs/canvas but doesn't expose Path2D, which AG Charts needs.
if (typeof window !== 'undefined' && !('Path2D' in globalThis)) {
  const { Path2D } = await import('@napi-rs/canvas');
  Object.assign(globalThis, { Path2D });
}

afterEach(() => cleanup());
