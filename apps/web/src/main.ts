// Placeholder entry (SP-001a): proves the browser app can import @spigot/shared with no Node
// types or polyfills. SP-024a replaces apps/web with the Vite + React scaffold.
import * as shared from '@spigot/shared';

export const sharedModule: typeof shared = shared;
