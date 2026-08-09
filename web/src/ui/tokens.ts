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
 */

export const tokens = {
  color: {
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
    text: '#ffffff',
    textMuted: '#a0aab5',
    onAccent: '#000000',
    // Extrusion role colors — inherited from desktop-slicer convention so a
    // maker reads a toolpath at a glance. Carry meaning, never re-map.
    roleOuterWall: '#f25959',
    roleInnerWall: '#40bf73',
    roleInfill: '#f2d959',
    roleSupport: '#666673',
  },
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
   * names the design family first and falls back to platform faces.
   */
  font: {
    sans: "'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
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
  '--oxr-text': '--oxr-color-text',
  '--oxr-text-muted': '--oxr-color-text-muted',
  '--oxr-on-accent': '--oxr-color-on-accent',
  '--oxr-role-outer-wall': '--oxr-color-role-outer-wall',
  '--oxr-role-inner-wall': '--oxr-color-role-inner-wall',
  '--oxr-role-infill': '--oxr-color-role-infill',
  '--oxr-role-support': '--oxr-color-role-support',
  '--oxr-grad-accent': '--oxr-gradient-accent',
  '--oxr-grad-progress': '--oxr-gradient-progress',
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
 * Flatten `tokens` into `{ '--oxr-color-bg': '#14171a', '--oxr-radius-md': '10px', … }`.
 * Exposed so a shell or test can inspect the exact variable set.
 */
export function tokenCssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, entries] of Object.entries(tokens)) {
    const isPx = PX_GROUPS.has(group);
    for (const [key, value] of Object.entries(entries as Record<string, string | number>)) {
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

/**
 * Write the tokens as `:root { --oxr-* }` custom properties into a single
 * `<style id="oxr-tokens">` element. Idempotent — safe to call more than once.
 */
export function injectTokenCss(doc: Document = document): void {
  const id = 'oxr-tokens';
  let el = doc.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement('style');
    el.id = id;
    doc.head.appendChild(el);
  }
  const body = Object.entries(tokenCssVars())
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  el.textContent = `:root {\n${body}\n}`;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
