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
  'accent-key',
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
    canvas: '#f7f8f9',
    surface: '#ffffff',
    'surface-2': '#f1f3f5',
    border: '#d8dee3',
    line: '#e7ebee',
    ink: '#0c1820',
    body: '#3a4952',
    muted: '#5f6e78',
    accent: '#0b6e75',
    'accent-strong': '#085a60',
    'accent-tint': '#e2f1f1',
    'accent-key': '#c3e5e6',
    'on-accent': '#ffffff',
    money: '#8a5a00',
    'money-tint': '#fbf1dc',
    positive: '#1a7548',
    'positive-tint': '#e1f3e8',
    warning: '#9a5800',
    'warning-tint': '#fdf0d6',
    danger: '#b42f27',
    'danger-tint': '#fce8e6',
    info: '#2a5bab',
    'info-tint': '#e5edfb',
    sim: '#6c45c9',
    'sim-tint': '#efe9fc',
    focus: '#1f9aa3',
  },
  dark: {
    canvas: '#0a0f13',
    surface: '#10171c',
    'surface-2': '#162027',
    border: '#27333c',
    line: '#1c262d',
    ink: '#e7eef2',
    body: '#b6c3cb',
    muted: '#84949f',
    accent: '#3cc0c8',
    'accent-strong': '#7ad9de',
    'accent-tint': '#0e3135',
    'accent-key': '#145257',
    'on-accent': '#03191b',
    money: '#f0b445',
    'money-tint': '#36280b',
    positive: '#4fc48c',
    'positive-tint': '#0f2e20',
    warning: '#f0aa45',
    'warning-tint': '#362609',
    danger: '#f27d72',
    'danger-tint': '#3a1613',
    info: '#85acf2',
    'info-tint': '#152446',
    sim: '#b59dff',
    'sim-tint': '#271d48',
    focus: '#5fd3da',
  },
};

/** Series colours for AG Charts (bot categories, datasets), in order. Distinct in both modes. */
export const chartPalette: Record<ThemeMode, readonly string[]> = {
  light: ['#0b6e75', '#c98510', '#2a5bab', '#b42f27', '#6c45c9', '#1a7548', '#5f6e78'],
  dark: ['#3cc0c8', '#f0b445', '#85acf2', '#f27d72', '#b59dff', '#4fc48c', '#9fb1bb'],
};

export const font = {
  sans: "'Instrument Sans Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "'Instrument Serif', ui-serif, Georgia, serif",
  mono: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;
