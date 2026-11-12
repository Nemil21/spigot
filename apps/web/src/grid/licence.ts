/**
 * AG Grid Enterprise + AG Charts Enterprise: module registration and licence (SP-024a).
 * Import only from lazily loaded screens (via src/grid), so the AG bundles stay off first paint.
 *
 * The key comes from `VITE_AG_GRID_LICENSE_KEY` (vite.config.ts falls back to the server's
 * `AG_GRID_LICENSE_KEY`). Enterprise modules are always registered because screens rely on row
 * grouping, master/detail, pivot and the server-side row model; without a valid Grid + Charts key
 * AG shows its trial watermark. Note from Holdfast: an AG *Studio* key is not valid here, and
 * `getLicenseDetails(key).valid` tells the two apart without ever logging the key.
 */
import {
  AllEnterpriseModule as AllChartsEnterpriseModule,
  LicenseManager as ChartsLicenseManager,
  ModuleRegistry as ChartsModuleRegistry,
  AgChartsEnterpriseModule,
} from 'ag-charts-enterprise';
import { ModuleRegistry as GridModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule, IntegratedChartsModule, LicenseManager } from 'ag-grid-enterprise';

export interface AgLicenceState {
  /** A non-empty key was supplied. */
  keyPresent: boolean;
  /** The key is a valid AG Grid + AG Charts Enterprise key: grids and charts have no watermark. */
  valid: boolean;
}

let state: AgLicenceState | null = null;

/** Whether `key` is a valid AG Grid Enterprise key. Never logs the key. */
export function isValidAgKey(key: string): boolean {
  if (!key) return false;
  try {
    return LicenseManager.getLicenseDetails(key).valid === true;
  } catch {
    return false;
  }
}

/** Idempotent. Called by SpigotGrid / SpigotChart before their first render. */
export function registerAg(
  key: string = import.meta.env.VITE_AG_GRID_LICENSE_KEY ?? '',
): AgLicenceState {
  if (state) return state;
  GridModuleRegistry.registerModules([
    AllEnterpriseModule,
    IntegratedChartsModule.with(AgChartsEnterpriseModule),
  ]);
  ChartsModuleRegistry.registerModules([AllChartsEnterpriseModule]);
  if (key) {
    LicenseManager.setLicenseKey(key);
    ChartsLicenseManager.setLicenseKey(key);
  }
  state = { keyPresent: !!key, valid: isValidAgKey(key) };
  return state;
}

export function agLicenceState(): AgLicenceState | null {
  return state;
}
