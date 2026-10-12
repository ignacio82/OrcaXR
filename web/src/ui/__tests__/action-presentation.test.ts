/**
 * How the shells arrange catalogue actions (`ActionPresentation.ts`) and the
 * exchange the shared core's port is held to: the palette's search, a context
 * menu's sections and the toolbar's runs, each as the DOM and XR shells use it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { catalogGroups, groupLabel, menuSectionLabel, paletteMatches, toolbarRuns } from '../ActionPresentation';
import { actionGroupsExchange, commandPaletteExchange } from '../ActionPresentationExchange';
import { GROUPS, MENU_SECTIONS } from '../../actions/ActionRegistry';
import { buildRegistry } from '../../actions/catalog';
import { INITIAL_UI_STATE } from '../../actions/UiState';
import { Localizer } from '../../l10n/Localizer';
import { installLocalizer } from '../../l10n/t';
import { contextMenuGroups } from '../dom/ContextMenu';
import { xrMenuBarSections } from '../xr/XrMenuBar';
import { xrInspectorPanels } from '../xr/XrPanels';
import { xrPaletteMatches } from '../xr/XrCommandPalette';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const registry = buildRegistry();
const palette = registry.forSurface('command-palette');

test('the palette searches label, id and hint, trimmed and without case, in catalogue order', () => {
  const ids = (query: string) => paletteMatches(palette, query).map((action) => action.id);
  assert.deepEqual(
    ids(''),
    palette.map((action) => action.id),
    'an empty query keeps every action',
  );
  assert.deepEqual(ids('   '), ids(''), 'a blank query is empty once trimmed');
  assert.ok(ids('  CUBE ').includes('add_primitive_cube'), 'by label, whatever its case');
  assert.ok(ids('primitive_c').includes('add_primitive_cylinder'), 'by id');
  assert.deepEqual(ids('zzzz-not-an-action'), []);
  const hinted = palette.find((action) => action.hint && !action.label.toLowerCase().includes('decimate'));
  assert.ok(hinted?.hint);
  assert.ok(ids(hinted.hint.slice(2, 12)).includes(hinted.id), 'by hint');
  const matches = ids('a');
  assert.deepEqual(
    matches,
    palette.map((action) => action.id).filter((id) => matches.includes(id)),
    'matches keep the order given',
  );
});

test('the XR palette searches exactly as the DOM palette does', () => {
  for (const query of ['', 'plate', ' Mirror ', 'tool_', 'select a', 'ß']) {
    assert.deepEqual(
      xrPaletteMatches(registry, INITIAL_UI_STATE, query).matches.map((action) => action.id),
      paletteMatches(palette, query).map((action) => action.id),
      query,
    );
  }
});

test('lowercasing is the engine’s, Unicode and final sigma included', () => {
  const actions = [
    { id: 'a', label: 'ΟΔΟΣ' },
    { id: 'b', label: 'İstanbul' },
    { id: 'c', label: 'Straße' },
  ];
  assert.deepEqual(
    paletteMatches(actions, 'οδος').map((a) => a.id),
    ['a'],
    'a word-final capital sigma lowercases to final ς',
  );
  assert.deepEqual(
    paletteMatches(actions, 'οδοσ').map((a) => a.id),
    [],
  );
  assert.deepEqual(
    paletteMatches(actions, 'i̇stanbul').map((a) => a.id),
    ['b'],
    'İ lowercases to i with a combining dot',
  );
  assert.deepEqual(
    paletteMatches(actions, 'STRASSE').map((a) => a.id),
    [],
    'no case folding beyond lowercase',
  );
});

test('a context menu is sectioned by catalogue group, in the groups’ declared order', () => {
  const object = registry.forContext('object');
  const sections = catalogGroups(object);
  const order = GROUPS.map((group) => group.id);
  assert.deepEqual(
    sections.map((section) => section.group.id),
    [...new Set(object.map((action) => action.group))].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  );
  assert.deepEqual(
    sections.flatMap((section) => section.actions.map((action) => action.id)).sort(),
    object.map((action) => action.id).sort(),
  );
  for (const section of sections) {
    assert.deepEqual(
      section.actions.map((action) => action.id),
      object.filter((action) => action.group === section.group.id).map((action) => action.id),
      'each section keeps the catalogue order',
    );
  }
});

test('the toolbar breaks into runs wherever the group changes', () => {
  const toolbar = registry.forSurface('dom-toolbar');
  const runs = toolbarRuns(toolbar);
  assert.deepEqual(
    runs.flatMap((run) => run.actions.map((action) => action.id)),
    toolbar.map((action) => action.id),
  );
  for (const [index, run] of runs.entries()) {
    assert.ok(run.actions.every((action) => action.group === run.group.id));
    if (index > 0) assert.notEqual(runs[index - 1]?.group.id, run.group.id);
  }
  assert.deepEqual(toolbarRuns([]), []);
});

test('the exchange answers by position, and refuses what it cannot read', () => {
  const request = {
    actions: [
      { id: 'add_primitive_cube', label: 'Cube', hint: 'Add a cube' },
      { id: 'x', label: 'Würfel' },
      { id: 'add_primitive_cube', label: 'Cube' },
    ],
    query: ' cube ',
  };
  assert.equal(commandPaletteExchange(JSON.stringify(request)), '{"matches":[0,2]}');
  assert.equal(
    actionGroupsExchange(JSON.stringify({ actions: ['mirror_x', 'edit_duplicate', 'mirror_y'], layout: 'context' })),
    '{"groups":[{"actions":[1],"group":"edit","label":"Edit"},{"actions":[0,2],"group":"scene","label":"Scene"}]}',
  );
  assert.equal(
    actionGroupsExchange(JSON.stringify({ actions: ['mirror_x', 'edit_duplicate', 'mirror_y'], layout: 'toolbar' })),
    '{"groups":[{"actions":[0],"group":"scene","label":"Scene"},{"actions":[1],"group":"edit","label":"Edit"},' +
      '{"actions":[2],"group":"scene","label":"Scene"}]}',
  );
  for (const bad of [
    '{',
    '[]',
    JSON.stringify({ actions: [], query: 1 }),
    JSON.stringify({ actions: [{ id: 'a' }], query: '' }),
    JSON.stringify({ actions: [{ id: 'a', label: 'A', extra: 1 }], query: '' }),
    JSON.stringify({ actions: [], query: '', extra: 1 }),
  ])
    assert.throws(() => commandPaletteExchange(bad), /invalid_request/, bad);
  for (const bad of [
    JSON.stringify({ actions: ['not_an_action'], layout: 'context' }),
    JSON.stringify({ actions: ['mirror_x'], layout: 'menu' }),
    JSON.stringify({ actions: [1], layout: 'toolbar' }),
    JSON.stringify({ actions: ['mirror_x'] }),
  ])
    assert.throws(() => actionGroupsExchange(bad), /invalid_request/, bad);
});

test('every group and menu-bar section has its message, by construction', () => {
  const reference = catalogue('en');
  for (const group of GROUPS) assert.equal(reference[`actionGroup.${group.id}.label`], group.label, group.id);
  for (const section of MENU_SECTIONS) {
    assert.equal(reference[`menuSection.${section.id}.label`], section.label, section.id);
  }
});

test('a context menu, the XR panels and the menu bar are headed in the operator’s language', () => {
  // Regression: the headings were each group's English label in every language, under translated entries.
  const german = catalogue('de');
  const l10n = new Localizer({ reference: catalogue('en') });
  l10n.setCatalog('de', german);
  const localized = buildRegistry().useTextSource(l10n);
  installLocalizer(l10n);
  try {
    const headings = contextMenuGroups(localized, 'object', INITIAL_UI_STATE, () => {}).map((group) => group.label);
    assert.deepEqual(headings, [german['actionGroup.edit.label'], german['actionGroup.scene.label'] ?? 'Scene']);
    assert.equal(german['actionGroup.edit.label'], 'Bearbeiten', 'the edit group is translated from upstream');
    assert.notEqual(headings[0], 'Edit');
    const plate = contextMenuGroups(localized, 'plate', INITIAL_UI_STATE, () => {}).map((group) => group.label);
    assert.equal(plate[0], german['actionGroup.file.label']);
    assert.equal(groupLabel('file'), 'Datei');
    assert.equal(menuSectionLabel('view'), german['menuSection.view.label']);
    const panels = xrInspectorPanels(localized).map((panel) => panel.label);
    assert.ok(panels.includes(german['actionGroup.file.label']), 'the XR panel for the File group');
    const bar = xrMenuBarSections(localized).map((section) => section.label);
    assert.equal(bar[0], german['menuSection.file.label']);
  } finally {
    installLocalizer(undefined);
  }
  // Without a localizer the headings stay the catalogue's English.
  assert.equal(groupLabel('edit'), 'Edit');
  assert.equal(menuSectionLabel('calibration'), 'Calibration');
});

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../../public/l10n/${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

console.log(`\nAction presentation: ${passed} tests passed.`);
