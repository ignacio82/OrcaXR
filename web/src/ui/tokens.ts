/**
 * OrcaXR design tokens — the single source of truth for the app's visual
 * language, consumed by BOTH shells:
 *
 *  - the desktop DOM shell reads them as CSS custom properties (`var(--oxr-*)`),
 *    injected once by `injectTokenCss()`;
 *  - the XR uikit shell reads the `tokens` object directly for `UIPanel`
 *    props (`fillColor`, `cornerRadius`, `strokeColor`, …).
 *
 * Before this file the same dark/orange palette was hand-duplicated as ~40 hex
 * literals across `index.html`, `main.ts`, and `OrcaWorkspace.ts`. A theme
 * change now happens in exactly one place and propagates to both shells.
 *
 * The two shells are deliberately *not* the same skin. The flat shell is a
 * desktop slicer and is dressed like the official Snapmaker Orca application —
 * opaque light chrome, teal accent, 3–5 px radii, thin hairline strokes — so a
 * maker who already uses Orca recognises every control. The XR shell floats
 * over passthrough where a light panel would glare and a hairline would
 * disappear, so it keeps the darker, higher-contrast palette in `tokens.color`.
 * `domThemes` therefore owns colour, radius, shadow and gradient for the DOM,
 * while everything geometric and typographic that both shells share (space,
 * type ramp, icon sizes, families, motion, glass) stays in `tokens`.
 */

/** The colour roles every theme has to fill. */
export interface ColorTable {
  bg: string;
  bgCard: string;
  bgElevated: string;
  bgSunken: string;
  surface: string;
  surfaceHover: string;
  surfaceActive: string;
  surfaceDisabled: string;
  stroke: string;
  strokeStrong: string;
  accent: string;
  accentSoft: string;
  accent2: string;
  danger: string;
  dangerSurface: string;
  ok: string;
  warn: string;
  warnSurface: string;
  text: string;
  textMuted: string;
  onAccent: string;
  roleOuterWall: string;
  roleInnerWall: string;
  roleInfill: string;
  roleSupport: string;
}

/**
 * Extrusion role colours — inherited from desktop-slicer convention so a maker
 * reads a toolpath at a glance. Carry meaning, never re-map, and never theme:
 * "outer wall is red" has to be true in both themes and both shells.
 */
const ROLE_COLORS = {
  roleOuterWall: '#f25959',
  roleInnerWall: '#40bf73',
  roleInfill: '#f2d959',
  roleSupport: '#666673',
} as const;

/**
 * The XR palette: dark, saturated, high-contrast. It is what `tokens.color`
 * resolves to, so an XR panel keeps reading correctly against passthrough.
 */
const XR_COLORS: ColorTable = {
  bg: '#05070a',
  bgCard: '#0d141cA6',
  // Dense overlays (mega menu, command palette, dialogs) sit over a busy 3D
  // scene, so they need a near-opaque fill; the 65% card fill is only legible
  // over the calmer chrome.
  bgElevated: '#0d141cF5',
  bgSunken: '#0000004d',
  surface: '#ffffff14',
  surfaceHover: '#ffffff26',
  surfaceActive: '#ffffff4d',
  surfaceDisabled: '#ffffff08',
  stroke: '#ffffff1a',
  strokeStrong: '#ffffff33',
  accent: '#FF6D00',
  accentSoft: '#FFB74D',
  accent2: '#FF8A3D', // mid-amber — slice progress bar
  danger: '#ff5252',
  dangerSurface: '#ff525233',
  ok: '#4caf50',
  warn: '#ffb74d',
  warnSurface: '#ffb74d26',
  text: '#ffffff',
  textMuted: '#a0aab5',
  onAccent: '#000000',
  ...ROLE_COLORS,
};

/**
 * The flat shell's default: Snapmaker Orca's light chrome. White panels on a
 * pale window, one teal accent, near-black text, hairline separators.
 */
const DOM_LIGHT: ColorTable = {
  bg: '#e9ebec',
  bgCard: '#ffffff',
  bgElevated: '#ffffff',
  bgSunken: '#f4f5f6',
  surface: '#f4f5f6',
  surfaceHover: '#e9ebed',
  surfaceActive: '#dfe2e4',
  surfaceDisabled: '#f7f8f9',
  stroke: '#dcdee1',
  strokeStrong: '#c2c6ca',
  // The teal is a shade deeper than the marketing swatch on purpose: white
  // sits on it in the tab strip and on both header buttons, and at 13px that
  // needs 4.5:1. `accentSoft` keeps the brighter tone for hovers and hairlines,
  // where nothing is read against it.
  accent: '#00796b',
  accentSoft: '#009688',
  accent2: '#00584e',
  danger: '#d0342c',
  dangerSurface: '#fdecea',
  ok: '#2e7d32',
  warn: '#c77700',
  warnSurface: '#fff4e5',
  text: '#262e30',
  // Muted, not faint: this is field notes and status lines at 11–12px, which
  // have to clear 4.5:1 against both the white card and the grey band.
  textMuted: '#5b6367',
  onAccent: '#ffffff',
  ...ROLE_COLORS,
};

/** The same shell in Orca's dark mode: graphite panels, the same teal accent. */
const DOM_DARK: ColorTable = {
  bg: '#191c1e',
  bgCard: '#24282b',
  bgElevated: '#2b3033',
  bgSunken: '#1d2123',
  surface: '#31373a',
  surfaceHover: '#3a4145',
  surfaceActive: '#454d51',
  surfaceDisabled: '#282d30',
  stroke: '#3b4247',
  strokeStrong: '#525a5f',
  accent: '#007f71',
  accentSoft: '#4ddbc4',
  accent2: '#00615a',
  danger: '#ef5350',
  dangerSurface: '#4a1f1d',
  ok: '#66bb6a',
  warn: '#ffa726',
  warnSurface: '#3d3220',
  text: '#e6eaeb',
  textMuted: '#98a2a6',
  onAccent: '#ffffff',
  ...ROLE_COLORS,
};

export const tokens = {
  color: XR_COLORS,
  radius: { sm: 8, md: 10, lg: 16, pill: 9999 },
  space: { xs: 5, sm: 8, md: 12, lg: 20, xl: 24 },
  type: { h2: 32, body: 20, label: 16, mono: 13 },
  icon: { sm: 24, md: 26, lg: 48 },
  /**
   * Signature gradients. `accent` is the primary-button fill; `progress` is the
   * slice bar. Both are CSS-only (the XR shell paints flat accent fills).
   */
  gradient: {
    accent: 'linear-gradient(135deg, #FFB74D 0%, #FF6D00 100%)',
    progress: 'linear-gradient(90deg, #FFB74D, #FF8A3D)',
  },
  /**
   * Flat-shell elevation. The XR shell expresses depth with opacity and stroke
   * instead, so these are deliberately DOM-only.
   */
  shadow: {
    panel: '0 8px 32px rgba(0, 0, 0, 0.4)',
    menu: '0 12px 40px rgba(0, 0, 0, 0.5)',
    modal: '0 24px 80px rgba(0, 0, 0, 0.8)',
    accent: '0 4px 15px rgba(255, 109, 0, 0.3)',
    accentHover: '0 6px 20px rgba(255, 109, 0, 0.4)',
  },
  /**
   * Type families. No webfont is downloaded — the page must render identically
   * offline and under the app's `font-src 'self' data:` CSP — so each stack
   * names the design family first and falls back to platform faces. `sans` is
   * the desktop-application stack the official app renders in, so the flat
   * shell's chrome sits at the same optical weight as Orca's.
   */
  font: {
    sans: "'Inter', 'Segoe UI', 'Noto Sans', Roboto, Helvetica, Arial, sans-serif",
    display: "'Space Grotesk', 'Inter', system-ui, sans-serif",
    body: "'Instrument Sans', 'Inter', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /** Short, functional easing. No bounce; hover lifts 1px, press settles 1px. */
  motion: {
    ease: 'cubic-bezier(0.2, 0, 0, 1)',
    durFast: '0.12s',
    durBase: '0.15s',
    durSlow: '0.2s',
  },
  /** The frosted-glass panel recipe: translucent fill + heavy blur. */
  glass: { blur: 'blur(16px)' },
} as const;

export type Tokens = typeof tokens;

/** The flat shell's themes. `light` is what the app boots in. */
export type DomThemeName = 'light' | 'dark';

export interface DomTheme {
  color: ColorTable;
  radius: { sm: number; md: number; lg: number; pill: number };
  gradient: { accent: string; progress: string; viewport: string };
  shadow: { panel: string; menu: string; modal: string; accent: string; accentHover: string };
}

/**
 * Orca's radii, not the XR shell's. A desktop slicer's controls are square-ish
 * — 3 px on an input, 4 on a button, 6 on a floating card — and rounding them
 * to the XR shell's 10–16 px is the single change that most makes the flat
 * shell stop looking like the application it is modelled on.
 */
const DOM_RADIUS = { sm: 3, md: 4, lg: 6, pill: 9999 } as const;

export const domThemes: Readonly<Record<DomThemeName, DomTheme>> = {
  light: {
    color: DOM_LIGHT,
    radius: DOM_RADIUS,
    gradient: {
      accent: `linear-gradient(180deg, ${DOM_LIGHT.accent} 0%, ${DOM_LIGHT.accent2} 100%)`,
      progress: `linear-gradient(90deg, ${DOM_LIGHT.accentSoft}, ${DOM_LIGHT.accent})`,
      // The wash the build plate stands on. The renderer's canvas is
      // transparent, so this is what the 3D view is actually seen against.
      viewport: 'linear-gradient(180deg, #f4f6f7 0%, #c8ced2 100%)',
    },
    shadow: {
      panel: '0 1px 3px rgba(20, 26, 28, 0.10)',
      menu: '0 6px 20px rgba(20, 26, 28, 0.18)',
      modal: '0 20px 52px rgba(20, 26, 28, 0.28)',
      accent: '0 1px 2px rgba(0, 121, 107, 0.24)',
      accentHover: '0 2px 6px rgba(0, 121, 107, 0.30)',
    },
  },
  dark: {
    color: DOM_DARK,
    radius: DOM_RADIUS,
    gradient: {
      accent: `linear-gradient(180deg, ${DOM_DARK.accent} 0%, ${DOM_DARK.accent2} 100%)`,
      progress: `linear-gradient(90deg, ${DOM_DARK.accentSoft}, ${DOM_DARK.accent})`,
      viewport: 'linear-gradient(180deg, #2f3437 0%, #15181a 100%)',
    },
    shadow: {
      panel: '0 1px 3px rgba(0, 0, 0, 0.45)',
      menu: '0 8px 24px rgba(0, 0, 0, 0.55)',
      modal: '0 24px 60px rgba(0, 0, 0, 0.65)',
      accent: '0 1px 2px rgba(0, 0, 0, 0.45)',
      accentHover: '0 2px 6px rgba(0, 0, 0, 0.5)',
    },
  },
};

/** Groups whose numeric values are pixel lengths (emitted with a `px` suffix). */
const PX_GROUPS = new Set(['radius', 'space', 'type', 'icon']);

/**
 * Design-system variable names → the canonical token they resolve to.
 *
 * The published OrcaXR design system (`_ds/…/tokens/*.css`) names its variables
 * `--oxr-surface`, `--radius-lg`, `--font-sans`, … while this module has always
 * emitted the longer `--oxr-<group>-<key>` form. Emitting both from one table
 * keeps `tokens.ts` the single source of truth: a design-system stylesheet and
 * the app's own CSS can be authored against either spelling and never drift.
 */
const DS_ALIASES: Readonly<Record<string, string>> = {
  '--oxr-bg': '--oxr-color-bg',
  '--oxr-bg-card': '--oxr-color-bg-card',
  '--oxr-bg-elevated': '--oxr-color-bg-elevated',
  '--oxr-bg-sunken': '--oxr-color-bg-sunken',
  '--oxr-surface': '--oxr-color-surface',
  '--oxr-surface-hover': '--oxr-color-surface-hover',
  '--oxr-surface-active': '--oxr-color-surface-active',
  '--oxr-stroke': '--oxr-color-stroke',
  '--oxr-stroke-strong': '--oxr-color-stroke-strong',
  '--oxr-accent': '--oxr-color-accent',
  '--oxr-accent-soft': '--oxr-color-accent-soft',
  '--oxr-accent-2': '--oxr-color-accent2',
  '--oxr-danger': '--oxr-color-danger',
  '--oxr-danger-surface': '--oxr-color-danger-surface',
  '--oxr-ok': '--oxr-color-ok',
  '--oxr-warn': '--oxr-color-warn',
  '--oxr-warn-surface': '--oxr-color-warn-surface',
  '--oxr-text': '--oxr-color-text',
  '--oxr-text-muted': '--oxr-color-text-muted',
  '--oxr-on-accent': '--oxr-color-on-accent',
  '--oxr-role-outer-wall': '--oxr-color-role-outer-wall',
  '--oxr-role-inner-wall': '--oxr-color-role-inner-wall',
  '--oxr-role-infill': '--oxr-color-role-infill',
  '--oxr-role-support': '--oxr-color-role-support',
  '--oxr-grad-accent': '--oxr-gradient-accent',
  '--oxr-grad-progress': '--oxr-gradient-progress',
  '--oxr-grad-viewport': '--oxr-gradient-viewport',
  '--radius-sm': '--oxr-radius-sm',
  '--radius-md': '--oxr-radius-md',
  '--radius-lg': '--oxr-radius-lg',
  '--radius-pill': '--oxr-radius-pill',
  '--space-xs': '--oxr-space-xs',
  '--space-sm': '--oxr-space-sm',
  '--space-md': '--oxr-space-md',
  '--space-lg': '--oxr-space-lg',
  '--space-xl': '--oxr-space-xl',
  '--font-sans': '--oxr-font-sans',
  '--font-display': '--oxr-font-display',
  '--font-body': '--oxr-font-body',
  '--font-mono': '--oxr-font-mono',
  '--shadow-panel': '--oxr-shadow-panel',
  '--shadow-menu': '--oxr-shadow-menu',
  '--shadow-modal': '--oxr-shadow-modal',
  '--shadow-accent': '--oxr-shadow-accent',
  '--shadow-accent-hover': '--oxr-shadow-accent-hover',
  '--glass-fill': '--oxr-color-bg-card',
  '--glass-blur': '--oxr-glass-blur',
  '--ease-ui': '--oxr-motion-ease',
  '--dur-fast': '--oxr-motion-dur-fast',
  '--dur-base': '--oxr-motion-dur-base',
  '--dur-slow': '--oxr-motion-dur-slow',
};

/**
 * Flatten the tokens for one DOM theme into
 * `{ '--oxr-color-bg': '#e9ebec', '--oxr-radius-md': '4px', … }`.
 * Exposed so a shell or test can inspect the exact variable set.
 */
export function tokenCssVars(theme: DomThemeName = 'light'): Record<string, string> {
  const out: Record<string, string> = {};
  const active = domThemes[theme];
  const groups: Record<string, Record<string, string | number>> = {
    ...(tokens as unknown as Record<string, Record<string, string | number>>),
    ...(active as unknown as Record<string, Record<string, string | number>>),
  };
  for (const [group, entries] of Object.entries(groups)) {
    const isPx = PX_GROUPS.has(group);
    for (const [key, value] of Object.entries(entries)) {
      const name = `--oxr-${group}-${kebab(key)}`;
      out[name] = typeof value === 'number' && isPx ? `${value}px` : String(value);
    }
  }
  for (const [alias, canonical] of Object.entries(DS_ALIASES)) {
    const value = out[canonical];
    if (value === undefined) throw new Error(`tokens: design-system alias ${alias} → unknown token ${canonical}`);
    out[alias] = value;
  }
  return out;
}

/** Only the variables that differ between the two DOM themes. */
function themeDelta(theme: DomThemeName): Record<string, string> {
  const base = tokenCssVars('light');
  const other = tokenCssVars(theme);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(other)) {
    if (base[name] !== value) out[name] = value;
  }
  return out;
}

const block = (selector: string, vars: Record<string, string>) =>
  `${selector} {\n${Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')}\n}`;

/**
 * Write the tokens as `:root { --oxr-* }` custom properties into a single
 * `<style id="oxr-tokens">` element. Idempotent — safe to call more than once.
 *
 * Both themes are emitted at once: the light set on bare `:root`, and only what
 * differs under `:root[data-theme='dark']`. Switching theme is then one
 * attribute on `<html>` — no re-injection, no flash, and no chance of a colour
 * that only exists in one of the two blocks.
 */
export function injectTokenCss(doc: Document = document): void {
  const id = 'oxr-tokens';
  let el = doc.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement('style');
    el.id = id;
    doc.head.appendChild(el);
  }
  el.textContent = `${block(':root', tokenCssVars('light'))}\n${block(":root[data-theme='dark']", themeDelta('dark'))}`;
}

const THEME_STORAGE_KEY = 'orcaxr.theme';

/** The theme stored on this device, if the operator has ever chosen one. */
export function storedDomTheme(): DomThemeName | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // Private mode: nothing was stored, so the default decides.
    return null;
  }
}

/**
 * Apply a theme to the document and remember it. An explicit choice outranks
 * the system preference, which is only consulted when there is no choice yet.
 */
export function setDomTheme(theme: DomThemeName, doc: Document = document): void {
  doc.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode: the choice applies to this session only.
  }
}

/**
 * The theme the app should boot in.
 *
 * Light unless the operator has chosen otherwise, which is the official
 * application's own default — its dark mode is a preference someone turns on,
 * not something the desktop's colour scheme decides for them. Following the
 * system here would mean a maker on a dark desktop opens a slicer that does not
 * look like the slicer they know.
 */
export function initialDomTheme(): DomThemeName {
  return storedDomTheme() ?? 'light';
}

/** The theme currently applied to the document. */
export function activeDomTheme(doc: Document = document): DomThemeName {
  return doc.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
