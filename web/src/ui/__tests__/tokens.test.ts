/**
 * The design tokens' own guarantees: every role pair the flat shell draws
 * meets WCAG 2.2 AA in both themes, and every custom property a stylesheet or
 * panel reads is one the tokens (or that same source) define.
 *
 * Both were broken before this test: the dark theme's teal read at 3:1 as
 * link text, light warnings at 3.5:1, every field's and switch's boundary at
 * about 1.4:1; and three panels read properties no token defines
 * (`--oxr-color-selection`, `--oxr-surface-disabled`, `--oxr-color-bg-raised`),
 * so a selected filament option fell back to dark text on the warning orange
 * in both themes and a selected object row to a blue the theme never chose.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CONTRAST_MINIMUM,
  contrastRatio,
  domContrastPairs,
  domThemes,
  relativeLuminance,
  tokenCssVars,
  type DomThemeName,
} from '../tokens';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

test('contrast follows WCAG 2.x relative luminance', () => {
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  // The WCAG reference value: #767676 is the lightest grey that passes 4.5:1 on white.
  assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5);
  assert.ok(contrastRatio('#777777', '#ffffff') < 4.5);
  assert.throws(() => relativeLuminance('#ffffff80'), /opaque/);
});

for (const theme of Object.keys(domThemes) as DomThemeName[]) {
  test(`${theme}: every role pair the shell draws meets WCAG AA`, () => {
    const colours = domThemes[theme].color;
    const failures = domContrastPairs
      .map((pair) => ({ ...pair, ratio: contrastRatio(colours[pair.fg], colours[pair.bg]) }))
      .filter((pair) => pair.ratio < CONTRAST_MINIMUM[pair.use])
      .map((pair) => `${pair.fg} on ${pair.bg} (${pair.use}): ${pair.ratio.toFixed(2)}:1`);
    assert.deepEqual(failures, []);
  });
}

test('the pairs name each role once per background and use', () => {
  const keys = domContrastPairs.map((pair) => `${pair.fg}/${pair.bg}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const pair of domContrastPairs) {
    assert.ok(pair.fg in domThemes.light.color && pair.bg in domThemes.light.color, `${pair.fg}/${pair.bg}`);
  }
});

test('the flat plate skins are the themes’ tokens', () => {
  for (const theme of Object.values(domThemes)) {
    for (const value of Object.values(theme.plate)) assert.match(value, /^#[0-9a-f]{6}$/);
  }
  assert.notEqual(domThemes.light.plate.fill, domThemes.dark.plate.fill);
});

// Every `var(--name)` a stylesheet or panel reads must resolve: to a token, or to
// a property the same sources declare (`--name:` in CSS, `setProperty('--name')`).
// A miss silently renders the fallback — or nothing — in both themes.
test('every custom property the shell reads is defined', () => {
  const web = fileURLToPath(new URL('../../../', import.meta.url));
  const sources: string[] = [join(web, 'index.html')];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        sources.push(path);
      }
    }
  };
  walk(join(web, 'src'));
  const defined = new Set([...Object.keys(tokenCssVars('light')), ...Object.keys(tokenCssVars('dark'))]);
  const texts = sources.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  for (const { text } of texts) {
    for (const match of text.matchAll(/(--[a-z0-9-]*[a-z0-9])\s*:/g)) defined.add(match[1]);
    for (const match of text.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]*[a-z0-9])['"`]/g)) defined.add(match[1]);
  }
  const missing: string[] = [];
  for (const { path, text } of texts) {
    // A name built at run time (`var(--oxr-${group})`, `var(--oxr-*)` in prose) is not a read.
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]*[a-z0-9])(?![\w$*{-])/g)) {
      if (!defined.has(match[1])) missing.push(`${match[1]} in ${path.slice(web.length)}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

console.log(`\n${passed} token tests passed.`);
