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
    canvas: '#f3f6f7',
    surface: '#ffffff',
    'surface-2': '#e9eef1',
    border: '#cdd7dd',
    line: '#dfe6ea',
    ink: '#0d1b24',
    body: '#364955',
    muted: '#677a86',
    accent: '#0b6e75',
    'accent-strong': '#08545a',
    'accent-tint': '#dbeff0',
    'on-accent': '#ffffff',
    money: '#8a5a00',
    'money-tint': '#fbf0d9',
    positive: '#1b7a4b',
    'positive-tint': '#dcf2e5',
    warning: '#a15c00',
    'warning-tint': '#fdeccf',
    danger: '#b8322a',
    'danger-tint': '#fbe4e1',
    info: '#2a5db0',
    'info-tint': '#e0eafa',
    sim: '#6c45c9',
    'sim-tint': '#ece5fb',
    focus: '#1f9aa3',
  },
  dark: {
    canvas: '#0a1217',
    surface: '#101b21',
    'surface-2': '#16242c',
    border: '#2b3c46',
    line: '#1d2b33',
    ink: '#e4edf1',
    body: '#b3c3cc',
    muted: '#7e919c',
    accent: '#3cc0c8',
    'accent-strong': '#74d8de',
    'accent-tint': '#0f3438',
    'on-accent': '#04191b',
    money: '#f2b33d',
    'money-tint': '#3a2a08',
    positive: '#4cc38a',
    'positive-tint': '#0f3121',
    warning: '#f0aa45',
    'warning-tint': '#3a2809',
    danger: '#f27b70',
    'danger-tint': '#3d1512',
    info: '#7fa8f2',
    'info-tint': '#15264a',
    sim: '#b49cff',
    'sim-tint': '#2a1f4d',
    focus: '#5fd3da',
  },
};

/** Series colours for AG Charts (bot categories, datasets), in order. Distinct in both modes. */
export const chartPalette: Record<ThemeMode, readonly string[]> = {
  light: ['#0b6e75', '#d08a12', '#2a5db0', '#b8322a', '#6c45c9', '#1b7a4b', '#677a86'],
  dark: ['#3cc0c8', '#f2b33d', '#7fa8f2', '#f27b70', '#b49cff', '#4cc38a', '#9fb1bb'],
};

export const font = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;
