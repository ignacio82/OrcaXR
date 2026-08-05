import assert from 'node:assert/strict';

import type { Action } from '../ActionRegistry';
import { buildRegistry } from '../catalog';
import {
  ariaShortcutValue,
  buildShortcutCatalog,
  matchShortcut,
  parseShortcut,
  shortcutHelpRows,
} from '../ShortcutCatalog';
import { shortcutsHtml } from '../helpContent';

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('builds the exact keyboard catalog from registry action metadata', () => {
  const catalog = buildShortcutCatalog(buildRegistry().all());
  assert.deepEqual(
    catalog.map(({ actionId, source, canonical }) => ({ actionId, source, canonical })),
    [
      { actionId: 'edit_undo', source: 'Ctrl+Z', canonical: '1000:z' },
      { actionId: 'edit_undo', source: 'Meta+Z', canonical: '0100:z' },
      { actionId: 'edit_redo', source: 'Ctrl+Shift+Z', canonical: '1001:z' },
      { actionId: 'edit_redo', source: 'Meta+Shift+Z', canonical: '0101:z' },
      { actionId: 'edit_redo', source: 'Ctrl+Y', canonical: '1000:y' },
      { actionId: 'edit_delete_selected', source: 'Delete', canonical: '0000:Delete' },
      { actionId: 'edit_deselect_all', source: 'Escape', canonical: '0000:Escape' },
      { actionId: 'tool_move', source: 'G', canonical: '0000:g' },
      { actionId: 'tool_rotate', source: 'R', canonical: '0000:r' },
      { actionId: 'tool_scale', source: 'S', canonical: '0000:s' },
    ],
  );
  assert.ok(catalog.every((entry) => entry.unavailable === false));
});

test('matches exact modifiers and ignores repeats, composition, and partial chords', () => {
  const catalog = buildShortcutCatalog(buildRegistry().all());
  assert.equal(
    matchShortcut(catalog, {
      key: 'Z',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    })?.actionId,
    'edit_redo',
  );
  assert.equal(
    matchShortcut(catalog, {
      key: 'z',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    })?.actionId,
    'edit_undo',
  );
  assert.equal(
    matchShortcut(catalog, {
      key: 'z',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    }),
    undefined,
  );
  assert.equal(
    matchShortcut(catalog, {
      key: 'Delete',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: true,
    }),
    undefined,
  );
  assert.equal(
    matchShortcut(catalog, {
      key: 'r',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: true,
    }),
    undefined,
  );
  assert.equal(
    matchShortcut(catalog, {
      key: 'Control',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }),
    undefined,
  );
  assert.equal(
    matchShortcut(catalog, {
      key: 'Shift',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }),
    undefined,
  );
});

test('rejects malformed declarations and conflicts instead of choosing an arbitrary action', () => {
  assert.throws(() => parseShortcut('Ctrl++Z'), /empty token/);
  assert.throws(() => parseShortcut('Ctrl+Control+Z'), /repeats ctrl/);
  assert.throws(() => parseShortcut('Ctrl+Z+Y'), /more than one key/);
  assert.throws(() => parseShortcut('Ctrl'), /no key/);

  const actions = buildRegistry().all();
  const first = actions.find((action) => action.id === 'tool_move')!;
  const second = actions.find((action) => action.id === 'tool_rotate')!;
  const conflicting = [
    { ...first, shortcuts: ['G'] },
    { ...second, shortcuts: ['g'] },
  ] as Action[];
  assert.throws(() => buildShortcutCatalog(conflicting), /assigned to both tool_move and tool_rotate/);
});

test('help rows are generated from the same declarations and group platform alternatives', () => {
  const actions = buildRegistry().all();
  const rows = shortcutHelpRows(actions);
  assert.deepEqual(rows.find((row) => row.actionId === 'edit_undo')?.displays, ['Ctrl+Z', '⌘+Z']);
  assert.deepEqual(rows.find((row) => row.actionId === 'edit_redo')?.displays, ['Ctrl+Shift+Z', '⌘+Shift+Z', 'Ctrl+Y']);
  assert.deepEqual(rows.find((row) => row.actionId === 'tool_move')?.displays, ['G']);
  assert.ok(rows.every((row) => row.actionLabel.length > 0 && row.displays.length > 0));
  const html = shortcutsHtml(actions);
  assert.ok(html.includes('<kbd>Ctrl+Z</kbd> / <kbd>⌘+Z</kbd>'));
  assert.match(html, /Delete Selected/);
  assert.match(html, /generated from the shared action catalogue/);
  assert.equal(ariaShortcutValue(['Ctrl+Shift+Z', 'Meta+Shift+Z']), 'Control+Shift+Z Meta+Shift+Z');
});

console.log(`\n${passed} shortcut catalog tests passed.`);
