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
    bg: '#14171a',
    bgCard: '#14171aA6',
    bgSunken: '#0000004d',
    surface: '#ffffff14',
    surfaceHover: '#ffffff26',
    surfaceActive: '#ffffff4d',
    stroke: '#ffffff1a',
    strokeStrong: '#ffffff33',
    accent: '#ff6d00',
    accentSoft: '#ffb74d',
    danger: '#ff5252',
    dangerSurface: '#ff525233',
    ok: '#4caf50',
    text: '#ffffff',
    textMuted: '#a0aab5',
    onAccent: '#000000',
  },
  radius: { sm: 8, md: 10, lg: 16, pill: 9999 },
  space: { xs: 5, sm: 8, md: 12, lg: 20, xl: 24 },
  type: { h2: 32, body: 20, label: 16, mono: 13 },
  icon: { sm: 24, md: 26, lg: 48 },
} as const;

export type Tokens = typeof tokens;

/** Groups whose numeric values are pixel lengths (emitted with a `px` suffix). */
const PX_GROUPS = new Set(['radius', 'space', 'type', 'icon']);

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
