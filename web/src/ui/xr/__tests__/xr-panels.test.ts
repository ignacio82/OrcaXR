/**
 * The two inspector panels that are more than a list of actions, and the state
 * that decides which one is showing.
 */
import assert from 'node:assert/strict';
import type { ObjectTreeProjection, ObjectTreeRow } from '../../../project/objects';
import type { ScopedStepperRow, ScopedStepperView } from '../../../settings/editor/scopedStepper';
import { renderXrObjectsPanel } from '../XrObjectsPanel';
import { renderXrSettingsPanel, xrFilterSettings } from '../XrSettingsPanel';
import { XrShellState } from '../XrShellState';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ui = createFakeXrUi();
const host = () => new FakePanel({});

// ---- A canonical Objects projection, shaped exactly as the real one --------

function row(partial: Partial<ObjectTreeRow> & { key: string; label: string }): ObjectTreeRow {
  return {
    id: partial.key,
    kind: 'object',
    childrenKeys: [],
    indicators: { editable: true },
    searchText: partial.label.toLowerCase(),
    ...partial,
  } as ObjectTreeRow;
}

const rows: ObjectTreeRow[] = [
  row({ key: 'o1', label: 'dragon.3mf', childrenKeys: ['v1', 'v2', 'e1'] }),
  row({
    key: 'v1',
    label: 'body',
    kind: 'volume',
    parentKey: 'o1',
    entity: { kind: 'volume', volumeId: 'v1' } as never,
    indicators: {
      editable: true,
      filament: { id: 'f1' as never, name: 'T1', color: '#050A0D', mixed: false, inherited: false },
    },
  }),
  row({
    key: 'v2',
    label: 'wing_left',
    kind: 'volume',
    parentKey: 'o1',
    entity: { kind: 'volume', volumeId: 'v2' } as never,
    indicators: { editable: true, printable: false },
  }),
  row({
    key: 'e1',
    label: 'support enforcer',
    kind: 'volume',
    parentKey: 'o1',
    indicators: { editable: true, volumeRole: 'support-enforcer' },
  }),
  row({ key: 'o2', label: 'base_plate' }),
];

const projection: ObjectTreeProjection = {
  rowsByKey: new Map(rows.map((entry) => [entry.key, entry])),
  rootKeys: ['o1', 'o2'],
  entityRowKeys: new Map([
    ['volume:v1', 'v1'],
    ['volume:v2', 'v2'],
  ]),
  defaultExpandedKeys: ['o1'],
};

test('the Objects panel draws the canonical tree, not a flat list of models', () => {
  const root = host();
  const render = renderXrObjectsPanel(ui, root, {
    projection,
    selection: { refs: [] },
    expandedKeys: new Set(['o1']),
    filterQuery: '',
    selectionActions: [],
    onToggleExpanded: () => {},
    onSelect: () => {},
    onEditFilter: () => {},
    onRunSelectionAction: () => {},
  });
  assert.deepEqual(render.rowKeys, ['o1', 'v1', 'v2', 'e1', 'o2']);
  const labels = render.root.labels();
  // Volumes, modifiers and enforcers — the structure the DOM panel renders.
  for (const label of ['dragon.3mf', 'body', 'wing_left', 'support enforcer', 'base_plate']) {
    assert.ok(labels.includes(label), `${label} is missing from the tree`);
  }
});

test('a collapsed object hides its children, and the twisty is its own target', () => {
  const toggled: string[] = [];
  const root = host();
  const render = renderXrObjectsPanel(ui, root, {
    projection,
    selection: { refs: [] },
    expandedKeys: new Set(),
    filterQuery: '',
    selectionActions: [],
    onToggleExpanded: (key) => toggled.push(key),
    onSelect: () => {},
    onEditFilter: () => {},
    onRunSelectionAction: () => {},
  });
  assert.deepEqual(render.rowKeys, ['o1', 'o2']);
  const twisty = root.buttons().find((button) => button.labels().join('') === '›');
  assert.ok(twisty, 'a collapsed object must offer a twisty of its own');
  twisty.click();
  assert.deepEqual(toggled, ['o1']);
});

test('a filament badge and a not-printed model are readable without colour alone', () => {
  const root = host();
  renderXrObjectsPanel(ui, root, {
    projection,
    selection: { refs: [] },
    expandedKeys: new Set(['o1']),
    filterQuery: '',
    selectionActions: [],
    onToggleExpanded: () => {},
    onSelect: () => {},
    onEditFilter: () => {},
    onRunSelectionAction: () => {},
  });
  const labels = root.labels();
  assert.ok(labels.includes('T1'), 'the filament is named, not only tinted');
  assert.ok(labels.includes('not printed'));
});

test('selecting a row reports the canonical entity it names', () => {
  const picked: string[] = [];
  const root = host();
  renderXrObjectsPanel(ui, root, {
    projection,
    selection: { refs: [] },
    expandedKeys: new Set(['o1']),
    filterQuery: '',
    selectionActions: [],
    onToggleExpanded: () => {},
    onSelect: (entity, key) => picked.push(`${entity.kind}:${key}`),
    onEditFilter: () => {},
    onRunSelectionAction: () => {},
  });
  root
    .buttons()
    .find((button) => button.labels().includes('body'))
    ?.click();
  assert.deepEqual(picked, ['volume:v1']);
});

test('the filter is the same projection filter the DOM panel applies', () => {
  const root = host();
  const render = renderXrObjectsPanel(ui, root, {
    projection,
    selection: { refs: [] },
    expandedKeys: new Set(['o1']),
    filterQuery: 'wing',
    selectionActions: [],
    onToggleExpanded: () => {},
    onSelect: () => {},
    onEditFilter: () => {},
    onRunSelectionAction: () => {},
  });
  assert.ok(render.rowKeys.includes('v2'));
  assert.ok(!render.rowKeys.includes('e1'));
});

// ---- Settings --------------------------------------------------------------

function setting(partial: Partial<ScopedStepperRow> & { fieldId: string; label: string }): ScopedStepperRow {
  return {
    key: partial.fieldId,
    group: 'Quality',
    value: '',
    unit: '',
    overridden: false,
    steppable: true,
    kind: 'numeric',
    choices: [],
    integer: false,
    typeable: true,
    ...partial,
  };
}

const view: ScopedStepperView = {
  status: 'ready',
  targetIndex: 1,
  targetCount: 3,
  targetLabel: 'Plate 1 › Cube',
  scope: 'object',
  unavailable: 7,
  rows: [
    setting({
      fieldId: 'q:layer_height',
      label: 'Layer height',
      value: '0.20',
      unit: 'mm',
      overridden: true,
      minimum: 0.05,
      maximum: 0.3,
    }),
    setting({ fieldId: 'q:first_layer', label: 'First layer height', value: '0.25', unit: 'mm' }),
    setting({ fieldId: 's:wall_loops', label: 'Wall loops', group: 'Strength', value: '2', integer: true }),
    setting({
      fieldId: 's:pattern',
      label: 'Sparse infill pattern',
      group: 'Strength',
      value: 'grid',
      kind: 'enum',
      choices: [
        { serialized: 'grid', label: 'Grid' },
        { serialized: 'gyroid', label: 'Gyroid' },
      ],
    }),
    setting({
      fieldId: 'sup:enable',
      label: 'Enable support',
      group: 'Support',
      value: '1',
      kind: 'bool',
      overridden: true,
    }),
    setting({
      fieldId: 'sup:style',
      label: 'Support style',
      group: 'Support',
      value: 'tree',
      kind: 'text',
      steppable: false,
      reason: 'This setting has no declared limits.',
    }),
  ],
};

test('the settings panel draws the whole tree, grouped, with the modified count', () => {
  const root = host();
  const render = renderXrSettingsPanel(ui, root, {
    view,
    search: '',
    onCycleTarget: () => {},
    onEditSearch: () => {},
    onStep: () => {},
    onSetValue: () => {},
    onEditValue: () => {},
  });
  assert.deepEqual(
    render.fieldIds,
    view.rows.map((entry) => entry.fieldId),
  );
  const labels = render.root.labels();
  for (const group of ['QUALITY', 'STRENGTH', 'SUPPORT']) assert.ok(labels.includes(group));
  assert.ok(labels.includes('Modified 2'));
  assert.ok(labels.includes('Plate 1 › Cube'), 'the scope being edited is named');
  assert.ok(labels.some((label) => label.includes('7 settings are unavailable')));
});

test('every editor type the generator emits has a spatial form', () => {
  const stepped: string[] = [];
  const set: [string, string][] = [];
  const typed: string[] = [];
  const root = host();
  renderXrSettingsPanel(ui, root, {
    view,
    search: '',
    onCycleTarget: () => {},
    onEditSearch: () => {},
    onStep: (fieldId) => stepped.push(fieldId),
    onSetValue: (fieldId, raw) => set.push([fieldId, raw]),
    onEditValue: (entry) => typed.push(entry.fieldId),
  });
  const labels = root.labels();
  // A stepper with a typeable value between its arrows.
  assert.ok(labels.includes('0.20 mm'));
  // An enumeration showing the choice it is on, by label.
  assert.ok(labels.includes('Grid ⌄'));
  root
    .buttons()
    .find((button) => button.labels().includes('Grid ⌄'))
    ?.click();
  assert.deepEqual(stepped, ['s:pattern']);
  // A boolean as a switch, which writes the value rather than stepping it.
  const toggle = root.panels().find((panel) => panel.props.cornerRadius === 15);
  toggle?.click();
  assert.deepEqual(set, [['sup:enable', '0']]);
  // A number opens the keypad.
  root
    .buttons()
    .find((button) => button.labels().includes('0.20 mm'))
    ?.click();
  assert.deepEqual(typed, ['q:layer_height']);
});

test('a row that cannot be stepped can still be typed, and says so', () => {
  const row = view.rows.find((entry) => entry.fieldId === 'sup:style');
  assert.ok(row && !row.steppable && row.typeable);
  const root = host();
  renderXrSettingsPanel(ui, root, {
    view,
    search: '',
    onCycleTarget: () => {},
    onEditSearch: () => {},
    onStep: () => {},
    onSetValue: () => {},
    onEditValue: () => {},
  });
  const value = root.buttons().find((button) => button.labels().includes('tree'));
  assert.ok(value, 'an unsteppable setting is still reachable — that is what the keypad unlocked');
  assert.equal(value?.opacity, 1);
});

test('searching narrows the tree without asking the engine', () => {
  assert.deepEqual(
    xrFilterSettings(view.rows, 'infill').map((entry) => entry.fieldId),
    ['s:pattern'],
  );
  assert.equal(xrFilterSettings(view.rows, '').length, view.rows.length);
  assert.deepEqual(xrFilterSettings(view.rows, 'zzz'), []);
});

test('a panel that is still loading says so rather than looking empty', () => {
  const root = host();
  const render = renderXrSettingsPanel(ui, root, {
    view: { ...view, status: 'loading', rows: [] },
    search: '',
    onCycleTarget: () => {},
    onEditSearch: () => {},
    onStep: () => {},
    onSetValue: () => {},
    onEditValue: () => {},
  });
  assert.deepEqual(render.fieldIds, []);
  assert.ok(render.root.labels().some((label) => label.includes('Loading')));
});

// ---- Shell state -----------------------------------------------------------

test('a menu and the palette are never up together', () => {
  const state = new XrShellState();
  const overlay = () => state.overlay as { kind: string; sectionId?: string };
  state.toggleMenu('file');
  assert.deepEqual(overlay(), { kind: 'menu', sectionId: 'file' });
  state.openPalette();
  assert.equal(overlay().kind, 'palette');
  state.toggleMenu('edit');
  assert.deepEqual(overlay(), { kind: 'menu', sectionId: 'edit' });
  state.toggleMenu('edit');
  assert.equal(overlay().kind, 'none', 'the same title closes what it opened');
});

test('opening a panel closes the directory that opened it', () => {
  const state = new XrShellState();
  state.toggleMenu('xr-panels');
  state.openPanel('settings');
  assert.equal(state.overlay.kind, 'none');
  assert.deepEqual(state.openPanels, ['objects', 'settings']);
  assert.equal(state.activePanel, 'settings');
});

test('closing a panel falls back to a neighbour rather than to nothing', () => {
  const state = new XrShellState();
  state.openPanel('settings');
  state.openPanel('group:paint');
  state.closePanel('group:paint');
  assert.equal(state.activePanel, 'settings');
  state.closePanel('settings');
  state.closePanel('objects');
  assert.equal(state.activePanel, null);
  assert.deepEqual(state.openPanels, []);
});

test('a pinned surface survives a recentre and an unpinned one does not', () => {
  const state = new XrShellState();
  const all = ['tools', 'inspector', 'scrubber', 'sheet'] as const;
  assert.deepEqual(state.movableSurfaces(all), [...all]);
  state.togglePinned('inspector');
  assert.ok(state.isPinned('inspector'));
  assert.deepEqual(state.movableSurfaces(all), ['tools', 'scrubber', 'sheet']);
  state.togglePinned('inspector');
  assert.deepEqual(state.movableSurfaces(all), [...all]);
});

test('the tree adopts a projection’s default expansion exactly once', () => {
  const state = new XrShellState();
  state.seedExpanded(['o1']);
  assert.deepEqual([...state.expandedKeys], ['o1']);
  state.toggleExpanded('o1');
  state.seedExpanded(['o1', 'o2']);
  assert.deepEqual([...state.expandedKeys], [], 'a seed must not undo what the operator collapsed');
});

console.log(`\nXR inspector panels: ${passed} tests passed.`);
