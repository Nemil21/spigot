import { useSyncExternalStore } from 'react';
import type { ThemeMode } from './tokens';

/**
 * Light / dark mode. The user's explicit choice is kept in localStorage; otherwise dark, the
 * designed default. Applied as `data-theme` on <html>, which tokens.css and the AG Grid theme read.
 */
const STORAGE_KEY = 'spigot.theme';
const listeners = new Set<() => void>();

function storedMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function getThemeMode(): ThemeMode {
  const attr = document.documentElement.dataset.theme;
  return attr === 'dark' || attr === 'light' ? attr : (storedMode() ?? 'dark');
}

export function applyThemeMode(mode: ThemeMode = storedMode() ?? 'dark'): void {
  document.documentElement.dataset.theme = mode;
  listeners.forEach((l) => l());
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  applyThemeMode(mode);
}

/** Re-renders when the mode changes (AG Charts needs hex values per mode). */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getThemeMode,
    () => 'light',
  );
}
