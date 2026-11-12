/**
 * Hex mirror of src/theme/tokens.css for canvas consumers (AG Charts draws on canvas and can't read
 * CSS variables). tokens.test.ts fails if this drifts from the CSS. DOM code uses Tailwind classes
 * or `var(--sp-*)`, never these values.
 */
export type ThemeMode = 'light' | 'dark';

export const TOKEN_NAMES = [
  'canvas',
  'surface',
  'surface-2',
  'border',
  'line',
  'ink',
  'body',
  'muted',
  'accent',
  'accent-strong',
  'accent-tint',
  'on-accent',
  'money',
  'money-tint',
  'positive',
  'positive-tint',
  'warning',
  'warning-tint',
  'danger',
  'danger-tint',
  'info',
  'info-tint',
  'sim',
  'sim-tint',
  'focus',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export const tokens: Record<ThemeMode, Record<TokenName, string>> = {
  light: {
    canvas: '#f4f6fb',
    surface: '#ffffff',
    'surface-2': '#eceffa',
    border: '#cfd6ea',
    line: '#e2e6f3',
    ink: '#0b1230',
    body: '#3a4466',
    muted: '#6b7596',
    accent: '#3d5bd9',
    'accent-strong': '#2c45b3',
    'accent-tint': '#e3e9ff',
    'on-accent': '#ffffff',
    money: '#0f8a5f',
    'money-tint': '#dcf5ea',
    positive: '#0f8a5f',
    'positive-tint': '#dcf5ea',
    warning: '#a15c00',
    'warning-tint': '#fdeccf',
    danger: '#c0323f',
    'danger-tint': '#fbe2e5',
    info: '#2a6fb0',
    'info-tint': '#e0edfa',
    sim: '#6c45c9',
    'sim-tint': '#ece5fb',
    focus: '#3d5bd9',
  },
  dark: {
    canvas: '#070b23',
    surface: '#0e1433',
    'surface-2': '#161d40',
    border: '#2a3360',
    line: '#1c2449',
    ink: '#f2f4ff',
    body: '#c4cae6',
    muted: '#8590b8',
    accent: '#8fabff',
    'accent-strong': '#b5c7ff',
    'accent-tint': '#1c2652',
    'on-accent': '#0a1230',
    money: '#6ee8b0',
    'money-tint': '#0f2f2a',
    positive: '#6ee8b0',
    'positive-tint': '#0f2f2a',
    warning: '#fac46b',
    'warning-tint': '#3a2d12',
    danger: '#ff858f',
    'danger-tint': '#3d1520',
    info: '#73ccfa',
    'info-tint': '#10284a',
    sim: '#bd99fa',
    'sim-tint': '#251c4d',
    focus: '#8fabff',
  },
};

/** Series colours for AG Charts (bot categories, datasets), in order. Distinct in both modes. */
export const chartPalette: Record<ThemeMode, readonly string[]> = {
  light: ['#3d5bd9', '#d08a12', '#7c4dd6', '#0f8a5f', '#c0323f', '#2a6fb0', '#6b7596'],
  dark: ['#8fabff', '#fac46b', '#bd99fa', '#6ee8b0', '#ff858f', '#73ccfa', '#9ea6c8'],
};

export const font = {
  sans: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;
