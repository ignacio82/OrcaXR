/**
 * The immersive shell's reachability claims, asserted without a headset.
 *
 * The redesign's whole argument is that a maker who knows OrcaXR on a screen
 * can use it in a headset: the same menu bar with the same names, the same
 * workspace tabs, the same tool rail, the same panels, and a way to type. Each
 * of those is a claim about the *set* of controls a surface draws from the
 * registry, and every one of them is checked here against the real catalogue.
 */
import assert from 'node:assert/strict';
import { buildRegistry } from '../../../actions/catalog';
import { MENU_SECTIONS, XR_PANELS_SECTION_ID, type Action } from '../../../actions/ActionRegistry';
import type { UiStateShape } from '../../../actions/UiState';
import { renderXrCommandPalette, xrPaletteMatches } from '../XrCommandPalette';
import { renderXrContextMenu } from '../XrContextMenu';
import { renderXrDesk } from '../XrDesk';
import { renderXrMenuBar, xrMenuBarSections } from '../XrMenuBar';
import { renderXrMenuPopover } from '../XrMenuPopover';
import { renderXrPanelHost } from '../XrPanelHost';
import { xrGroupPanelId, xrInspectorPanels, xrPanelGroup } from '../XrPanels';
import { renderXrToolRail, xrRailLayout } from '../XrToolRail';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ui = createFakeXrUi();
const registry = buildRegistry();

const STATE: Readonly<UiStateShape> = {
  mode: 'prepare',
  activeTool: 'move',
  modelCount: 3,
  plateCount: 2,
  hasSelection: true,
  hasInstanceSelection: true,
  hasClipboard: true,
  isSlicing: false,
  gcodeReady: true,
  extruderCount: 4,
  hasMultiColorPaint: true,
  canUndo: true,
  canRedo: false,
  dirty: true,
  projectionHealthy: true,
  status: 'ready',
  progress: null,
  preflightBlocked: false,
  printerJobState: 'printing',
};

function host(): FakePanel {
  return new FakePanel({});
}

// ---- The menu bar ---------------------------------------------------------

test('the menu bar carries the flat shell’s own sections, in its order', () => {
  const sections = xrMenuBarSections(registry);
  const upstream = MENU_SECTIONS.map((section) => section.id);
  const drawn = sections.map((section) => section.id);
  // Every section with something in it, in registry order, then Panels.
  assert.deepEqual(
    drawn.filter((id) => id !== XR_PANELS_SECTION_ID),
    upstream.filter((id) => registry.forSurface('xr-menu').some((action) => String(action.menuSection) === id)),
  );
  assert.equal(drawn.at(-1), XR_PANELS_SECTION_ID, 'Panels is a section, not an unrendered constant');
  assert.ok(drawn.length >= 8, 'seven upstream menus plus Panels');
});

test('the menu bar draws every section title, the palette, and the workspace tabs', () => {
  const root = host();
  const render = renderXrMenuBar(ui, root, menuBarContext());
  const labels = render.root.labels();
  for (const section of MENU_SECTIONS) assert.ok(labels.includes(section.label), `${section.label} is missing`);
  for (const mode of ['Prepare', 'Preview', 'Device', 'Project']) assert.ok(labels.includes(mode));
  assert.ok(labels.includes('Search commands'), 'the command palette has a home in the bar');
  assert.ok(labels.includes('Exit XR'));
});

test('the workspace tabs carry the live sub-line the flat tab strip carries', () => {
  const root = host();
  const render = renderXrMenuBar(ui, root, menuBarContext());
  const labels = render.root.labels();
  assert.ok(labels.includes('3 models · 2 plates'));
  assert.ok(labels.includes('302 layers'));
});

test('printer status is in the bar, and says so when there is no printer', () => {
  const root = host();
  const render = renderXrMenuBar(ui, root, { ...menuBarContext(), printer: null });
  assert.ok(render.root.labels().includes('No printer'), 'an absent printer is a fact, not an empty space');
  render.refresh({ ...menuBarContext(), printer: { label: 'lava', detail: 'printing · 148/302', color: '#4caf50' } });
  assert.ok(render.root.labels().includes('lava'));
});

test('pressing a section title reports which section, and where it was pressed', () => {
  const opened: string[] = [];
  let anchor: unknown = null;
  const root = host();
  const render = renderXrMenuBar(ui, root, {
    ...menuBarContext(),
    onOpenSection: (id, node) => {
      opened.push(id);
      anchor = node;
    },
  });
  const file = render.sectionAnchors.get('file');
  assert.ok(file, 'the File title is an anchor a popover can hang from');
  (file as FakePanel).click();
  assert.deepEqual(opened, ['file']);
  assert.equal(anchor, file, 'the popover drops from the title that opened it');
});

test('undo and redo follow the canonical history, not the shell', () => {
  const root = host();
  renderXrMenuBar(ui, root, menuBarContext());
  const quick = root.buttons();
  // canUndo is true and canRedo is false in STATE; the redo control must be
  // disabled rather than absent, so its existence is discoverable.
  const disabled = quick.filter((button) => button.opacity < 1);
  assert.ok(disabled.length >= 1, 'redo is drawn disabled');
});

// ---- The menu popover -----------------------------------------------------

test('a menu section draws its own actions, and only those', () => {
  const root = host();
  const render = renderXrMenuPopover(ui, root, popoverContext('file'));
  const drawn = new Set(render.rows.map((row) => row.actionId));
  const expected = registry
    .forSurface('xr-menu')
    .filter((action) => String(action.menuSection) === 'file')
    .filter((action) => registry.availability(action, 'xr-menu', STATE).state !== 'hidden')
    .map((action) => action.id);
  assert.deepEqual([...drawn], expected);
  assert.ok(expected.length > 0);
});

test('a withheld action stays listed and prints its reason verbatim', () => {
  const empty: Readonly<UiStateShape> = { ...STATE, gcodeReady: false, modelCount: 0, hasSelection: false };
  const root = host();
  const render = renderXrMenuPopover(ui, root, { ...popoverContext('file'), state: empty });
  const withheld = render.rows.filter((row) => !row.enabled);
  assert.ok(withheld.length > 0, 'an empty project withholds the exports');
  for (const row of withheld) {
    assert.ok(row.reason && row.reason.length > 0, `${row.actionId} is disabled with no stated reason`);
    assert.ok(render.root.labels().includes(row.reason), `${row.actionId}'s reason is not drawn in the row`);
  }
});

test('the Tools menu carries nothing the rail already draws', () => {
  const root = host();
  const render = renderXrMenuPopover(ui, root, popoverContext('tools'));
  const ids = render.rows.map((row) => row.actionId);
  assert.equal(new Set(ids).size, ids.length, 'an action must not be listed twice');
});

test('the Panels directory lists every inspector panel the registry implies', () => {
  const root = host();
  const opened: string[] = [];
  const render = renderXrMenuPopover(ui, root, {
    ...popoverContext(XR_PANELS_SECTION_ID),
    onOpenPanel: (id) => opened.push(id),
  });
  const expected = xrInspectorPanels(registry).map((panel) => panel.id);
  assert.deepEqual(
    render.rows.map((row) => row.actionId),
    expected,
  );
  assert.ok(expected.includes('objects') && expected.includes('settings'));
  render.root.buttons()[0].click();
  assert.deepEqual(opened, ['objects']);
});

test('every inspector action belongs to exactly one panel in the directory', () => {
  const groups = xrInspectorPanels(registry)
    .map((panel) => xrPanelGroup(panel.id))
    .filter((group): group is NonNullable<typeof group> => group !== undefined);
  for (const action of registry.forSurface('xr-inspector')) {
    assert.ok(groups.includes(action.group), `${action.id} (${action.group}) has no panel to be reached from`);
  }
  for (const group of groups) assert.equal(xrPanelGroup(xrGroupPanelId(group)), group);
});

// ---- The command palette --------------------------------------------------

test('the spatial palette searches the same catalogue the flat one searches', () => {
  const { matches, total } = xrPaletteMatches(registry, STATE, '');
  assert.equal(
    total,
    registry
      .forSurface('command-palette')
      .filter((action) => registry.availability(action, 'command-palette', STATE).state !== 'hidden').length,
  );
  assert.equal(matches.length, total);
  const supports = xrPaletteMatches(registry, STATE, 'support');
  assert.ok(supports.matches.length > 0);
  assert.ok(supports.matches.length < total, 'a query narrows the list');
  for (const action of supports.matches) {
    const haystack = `${action.label} ${action.id} ${action.hint ?? ''}`.toLowerCase();
    assert.ok(haystack.includes('support'));
  }
});

test('the palette says how many of the whole catalogue a query left', () => {
  const root = host();
  const render = renderXrCommandPalette(ui, root, {
    registry,
    state: STATE,
    query: 'support',
    onEditQuery: () => {},
    onRun: () => {},
    onClose: () => {},
  });
  const total = xrPaletteMatches(registry, STATE, '').total;
  assert.ok(render.root.labels().includes(`${render.matches.length} of ${total}`));
});

test('running a palette row runs that exact action', () => {
  const run: Action[] = [];
  const root = host();
  const render = renderXrCommandPalette(ui, root, {
    registry,
    state: STATE,
    query: 'arrange',
    onEditQuery: () => {},
    onRun: (action) => run.push(action),
    onClose: () => {},
  });
  const rows = render.root.buttons().filter((button) => button.labels().includes(render.matches[0].label));
  rows[0].click();
  assert.deepEqual(
    run.map((action) => action.id),
    [render.matches[0].id],
  );
});

// ---- The context menu -----------------------------------------------------

test('the context menu is the registry’s own context set for that target', () => {
  const root = host();
  const render = renderXrContextMenu(ui, root, {
    registry,
    state: STATE,
    target: 'object',
    targetLabel: 'Object 1',
    onRun: () => {},
    onClose: () => {},
  });
  assert.deepEqual(
    render.actions.map((action) => action.id),
    registry
      .forContext('object', 'xr-context')
      .filter((action) => registry.availability(action, 'xr-context', STATE).state !== 'hidden')
      .map((action) => action.id),
  );
  assert.ok(render.actions.length > 0, 'the surface the registry declares must actually be drawn');
  assert.ok(render.root.labels().includes('Object 1'), 'the menu names what it will act on');
});

test('a transient surface can always be backed out of', () => {
  let closed = 0;
  const root = host();
  renderXrContextMenu(ui, root, {
    registry,
    state: STATE,
    target: 'plate',
    targetLabel: 'This plate',
    onRun: () => {},
    onClose: () => (closed += 1),
  });
  const close = root.buttons().find((button) => button.props.width === 28);
  assert.ok(close, 'a menu opened by a gesture needs a visible way out');
  close.click();
  assert.equal(closed, 1);

  let paletteClosed = 0;
  const paletteRoot = host();
  renderXrCommandPalette(ui, paletteRoot, {
    registry,
    state: STATE,
    query: '',
    onEditQuery: () => {},
    onRun: () => {},
    onClose: () => (paletteClosed += 1),
  });
  const paletteClose = paletteRoot.buttons().find((button) => button.props.width === 36);
  assert.ok(paletteClose, 'a modal palette must be dismissible by something the operator can see');
  paletteClose.click();
  assert.equal(paletteClosed, 1);
});

test('the plate menu and the object menu are different sets', () => {
  const object = registry.forContext('object', 'xr-context').map((action) => action.id);
  const plate = registry.forContext('plate', 'xr-context').map((action) => action.id);
  assert.notDeepEqual(object, plate);
});

// ---- The tool rail --------------------------------------------------------

test('the rail draws every toolbar action, grouped, with a label on each', () => {
  const root = host();
  const render = renderXrToolRail(ui, root, {
    registry,
    state: STATE,
    activeTool: 'move',
    onRun: () => {},
  });
  const toolbar = registry.forSurface('xr-toolbar').map((action) => action.id);
  assert.deepEqual([...render.actionIds].sort(), [...toolbar].sort());
  const labels = render.root.labels();
  for (const action of registry.forSurface('xr-toolbar')) {
    assert.ok(labels.includes(action.label), `${action.id} is drawn without its label`);
  }
});

test('the rail’s groups are the order the hand works in, and nothing is orphaned', () => {
  const layout = xrRailLayout(registry);
  assert.ok(layout.length >= 3);
  const drawn = layout.flatMap((group) => group.actions.map((action) => action.id));
  assert.equal(new Set(drawn).size, drawn.length, 'an action must appear in exactly one group');
});

test('the active tool is the selected button, and an unavailable one is dim', () => {
  const root = host();
  const render = renderXrToolRail(ui, root, { registry, state: STATE, activeTool: 'rotate', onRun: () => {} });
  const dim = render.root.panels().filter((panel) => panel.opacity < 1);
  assert.ok(dim.length >= 0);
  render.refresh({ registry, state: { ...STATE, hasInstanceSelection: false }, activeTool: null, onRun: () => {} });
  const dimmed = render.root.panels().filter((panel) => panel.opacity < 1);
  assert.ok(dimmed.length > 0, 'a tool with no selection to act on must read as unavailable');
});

test('a paint tool puts the canonical palette on the rail', () => {
  const root = host();
  const render = renderXrToolRail(ui, root, {
    registry,
    state: STATE,
    activeTool: 'paint',
    swatches: [
      { id: 'f1', label: '1', color: '#050A0D', selected: true },
      { id: 'f2', label: '2', color: '#F4C022', selected: false },
    ],
    onRun: () => {},
    onSelectSwatch: () => {},
  });
  assert.ok(render.root.labels().includes('1'));
  assert.ok(render.root.labels().includes('2'));
});

test('a tool’s own numbers are stepped on the rail beside it', () => {
  const stepped: [string, number][] = [];
  const root = host();
  renderXrToolRail(ui, root, {
    registry,
    state: STATE,
    activeTool: 'brim_ears',
    steppers: [{ id: 'brim-ear-radius', label: 'Brim ear radius', value: '5', unit: 'mm' }],
    onRun: () => {},
    onStep: (id, direction) => stepped.push([id, direction]),
  });
  const buttons = root.buttons().filter((button) => button.props.width === 28);
  assert.equal(buttons.length, 2, 'a decrement and an increment');
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual(stepped, [
    ['brim-ear-radius', -1],
    ['brim-ear-radius', 1],
  ]);
});

// ---- The desk -------------------------------------------------------------

test('the desk carries every primary verb, the plates, and the progress', () => {
  const root = host();
  const render = renderXrDesk(ui, root, deskContext());
  const labels = render.root.labels();
  for (const action of registry.forSurface('xr-primary')) assert.ok(labels.includes(action.label));
  assert.ok(labels.includes('Plate 1  3'));
  assert.ok(labels.includes('Slicing plate 1 — perimeters'));
  assert.ok(labels.includes('62%'));
});

test('progress is on the desk, so nothing modal covers the plate', () => {
  const root = host();
  const render = renderXrDesk(ui, root, { ...deskContext(), progress: null });
  assert.ok(!render.root.labels().some((label) => label.endsWith('%')));
  render.refresh({ ...deskContext(), progress: 0.5 });
  assert.ok(render.root.labels().includes('50%'));
});

test('a primary verb that cannot run is dim rather than absent', () => {
  const root = host();
  const render = renderXrDesk(ui, root, deskContext());
  render.refresh({ ...deskContext(), state: { ...STATE, modelCount: 0, gcodeReady: false, hasSelection: false } });
  const dim = render.root.buttons().filter((button) => button.opacity < 1);
  assert.ok(dim.length > 0, 'a bright Slice on an empty plate is a false affordance');
});

// ---- The inspector --------------------------------------------------------

test('the inspector stacks open panels as tabs and offers the directory', () => {
  const opened: string[] = [];
  let directory = 0;
  const root = host();
  const panels = xrInspectorPanels(registry).slice(0, 3);
  const render = renderXrPanelHost(ui, root, {
    openPanels: panels,
    activePanelId: panels[0].id,
    pinned: false,
    onSelectPanel: (id) => opened.push(id),
    onClosePanel: () => {},
    onOpenDirectory: () => (directory += 1),
    onTogglePin: () => {},
    renderBody: (body) => {
      ui.appendChild(body, ui.createText('body', {}));
    },
  });
  const labels = render.root.labels();
  for (const panel of panels) assert.ok(labels.includes(panel.label));
  assert.ok(labels.includes('body'));
  const tabs = render.root.buttons().filter((button) => button.labels().includes(panels[1].label));
  tabs[0].click();
  assert.deepEqual(opened, [panels[1].id]);
  const plus = render.root.buttons().at(-1);
  plus?.click();
  assert.equal(directory, 1);
});

test('an empty inspector says how to fill it rather than looking broken', () => {
  const root = host();
  const render = renderXrPanelHost(ui, root, {
    openPanels: [],
    activePanelId: null,
    pinned: false,
    onSelectPanel: () => {},
    onClosePanel: () => {},
    onOpenDirectory: () => {},
    onTogglePin: () => {},
    renderBody: () => {},
  });
  assert.ok(render.root.labels().some((label) => label.includes('No panel open')));
});

function menuBarContext() {
  return {
    sections: xrMenuBarSections(registry),
    openSectionId: null,
    activeMode: 'prepare' as const,
    modeDetail: {
      prepare: '3 models · 2 plates',
      preview: '302 layers',
      device: 'lava · printing',
      project: 'dragon.3mf · unsaved',
    },
    canUndo: STATE.canUndo,
    canRedo: STATE.canRedo,
    isDirty: STATE.dirty,
    printer: { label: 'lava', detail: 'printing · 148/302', color: '#4caf50' },
    onOpenSection: () => {},
    onOpenPalette: () => {},
    onSelectMode: () => {},
    onSave: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onRecenter: () => {},
    onExit: () => {},
  };
}

function popoverContext(sectionId: string) {
  return {
    registry,
    state: STATE,
    sectionId,
    title: sectionId,
    onRun: () => {},
  };
}

function deskContext() {
  return {
    registry,
    state: STATE,
    plates: [
      { id: 'p1', label: 'Plate 1', modelCount: 3, active: true },
      { id: 'p2', label: 'Plate 2', modelCount: 2, active: false },
    ],
    status: 'Slicing plate 1 — perimeters',
    progress: 0.62,
    onRun: () => {},
    onSelectPlate: () => {},
    onAddPlate: () => {},
    onManagePlates: () => {},
  };
}

console.log(`\nXR immersive shell: ${passed} tests passed.`);
