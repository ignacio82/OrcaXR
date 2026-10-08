import assert from 'node:assert/strict';
import { cloneProjectState } from '../domain/canonical';
import { seededRandom, UuidIdSource } from '../domain/ids';
import { identityTransform } from '../domain/model';
import {
  ObjectTreeExpansionState,
  ObjectTreeNavigator,
  ObjectTreeSelectionController,
  buildObjectTreeView,
  computeFixedVirtualWindow,
  entityRowKey,
  objectTreeRowId,
  objectTreeSelectionRequest,
  projectObjectsTree,
  resolveObjectTreeSelection,
  scrollOffsetToRevealRow,
} from '../objects';
import { SelectionStore, selectionKey } from '../selection';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function treeFixture() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const secondInstance = new UuidIdSource(seededRandom(0x2021)).next('instance');
  const object = state.plates[0].objects[0];
  object.instances.push({
    id: secondInstance,
    name: 'Rear copy',
    transform: { ...identityTransform(), translationMm: [20, 0, 0] },
    printable: true,
  });
  object.volumes[0].annotations.support = [{ triangles: [0], value: 'enforce' }];
  return { fixture, state, secondInstance };
}

await test('projects every canonical row kind with stable IDs and honest indicators', () => {
  const { fixture, state, secondInstance } = treeFixture();
  const volumeRef = { kind: 'volume' as const, id: fixture.ids.volume };
  const projection = projectObjectsTree(state, {
    diagnostics: [
      {
        id: 'mesh-error',
        severity: 'error',
        code: 'outside-bed',
        message: 'Part is outside the bed',
        entity: volumeRef,
      },
      { id: 'project-note', severity: 'info', code: 'hint', message: 'Arrange before slicing' },
    ],
    resolveStatus: (_state, entity) =>
      selectionKey(entity) === selectionKey(volumeRef) ? { sinking: true, editable: false } : undefined,
  });
  const kinds = new Set([...projection.rowsByKey.values()].map((row) => row.kind));
  assert.deepEqual(
    kinds,
    new Set([
      'plate',
      'object',
      'volume',
      'instance-group',
      'instance',
      'settings',
      'layer-group',
      'layer-range',
      'info',
      'error',
    ]),
  );
  const volume = projection.rowsByKey.get(entityRowKey(volumeRef))!;
  assert.equal(volume.indicators.filament?.id, fixture.ids.physical0);
  assert.equal(volume.indicators.filament?.inherited, true);
  assert.equal(volume.indicators.paint?.colorFacetCount, 1);
  assert.equal(volume.indicators.paint?.supportFacetCount, 1);
  assert.equal(volume.indicators.sinking, true);
  assert.equal(volume.indicators.editable, false);
  assert.ok(projection.rowsByKey.has(entityRowKey({ kind: 'instance', id: secondInstance })));

  const renamed = cloneProjectState(state);
  renamed.plates[0].name = 'Renamed plate';
  renamed.plates[0].objects[0].name = 'Renamed object';
  renamed.plates[0].objects[0].volumes[0].name = 'Renamed part';
  const renamedProjection = projectObjectsTree(renamed);
  const entityKeys = [...projection.entityRowKeys.values()].sort();
  assert.deepEqual([...renamedProjection.entityRowKeys.values()].sort(), entityKeys);
  for (const key of entityKeys)
    assert.equal(renamedProjection.rowsByKey.get(key)?.id, projection.rowsByKey.get(key)?.id);
});

await test('filtering reveals matched branches without mutating expansion and emits tree accessibility metadata', () => {
  const { fixture, state } = treeFixture();
  const projection = projectObjectsTree(state);
  const expansion = new ObjectTreeExpansionState();
  const selection = new SelectionStore();
  selection.set([{ kind: 'volume', id: fixture.ids.volume }]);
  const before = expansion.snapshot();
  const view = buildObjectTreeView(projection, {
    expandedKeys: expansion.snapshot(),
    filterQuery: 'Rear copy',
    selection: selection.getSnapshot(),
  });
  assert.deepEqual([...expansion.snapshot()], [...before]);
  assert.deepEqual(
    view.rows.map((row) => row.kind),
    ['plate', 'object', 'instance-group', 'instance'],
  );
  assert.deepEqual(
    view.rows.map((row) => row.accessibility.level),
    [1, 2, 3, 4],
  );
  assert.ok(view.rows.every((row) => row.accessibility.positionInSet === 1 && row.accessibility.setSize === 1));
  assert.equal(view.rows.at(-1)?.matchedFilter, true);
  assert.equal(view.rows.filter((row) => row.focused).length, 1);
  assert.equal(view.rows.filter((row) => row.accessibility.tabIndex === 0).length, 1);
  assert.deepEqual(selection.getSnapshot().refs, [{ kind: 'volume', id: fixture.ids.volume }]);
});

await test('entity selection, visible ranges, and keyboard navigation remain independent of rendering', () => {
  const { fixture, state, secondInstance } = treeFixture();
  const projection = projectObjectsTree(state);
  const expansion = new ObjectTreeExpansionState();
  expansion.expandAll(projection);
  const selection = new SelectionStore();
  const controller = new ObjectTreeSelectionController(selection);
  const navigator = new ObjectTreeNavigator(expansion, controller);
  let view = buildObjectTreeView(projection, { expandedKeys: expansion.snapshot() });
  const firstInstanceKey = entityRowKey({ kind: 'instance', id: fixture.ids.instance });
  const secondInstanceKey = entityRowKey({ kind: 'instance', id: secondInstance });
  const volumeKey = entityRowKey({ kind: 'volume', id: fixture.ids.volume });

  controller.apply(view, firstInstanceKey, 'replace');
  controller.apply(view, volumeKey, 'toggle');
  assert.deepEqual(new Set(selection.getSnapshot().refs.map(selectionKey)), new Set([firstInstanceKey, volumeKey]));
  controller.apply(view, firstInstanceKey, 'replace');
  controller.apply(view, secondInstanceKey, 'range');
  assert.deepEqual(selection.getSnapshot().refs.map(selectionKey), [firstInstanceKey, secondInstanceKey]);

  const groupKey = `instance-group:${fixture.ids.object}`;
  navigator.setFocus(view, groupKey);
  navigator.navigate(view, 'parent');
  assert.equal(navigator.getFocus(), groupKey);
  assert.equal(expansion.isExpanded(groupKey), false);
  view = buildObjectTreeView(projection, { expandedKeys: expansion.snapshot(), focusedKey: navigator.getFocus() });
  navigator.navigate(view, 'child');
  assert.equal(expansion.isExpanded(groupKey), true);
  view = buildObjectTreeView(projection, { expandedKeys: expansion.snapshot(), focusedKey: navigator.getFocus() });
  navigator.navigate(view, 'child');
  assert.equal(navigator.getFocus(), firstInstanceKey);
  navigator.navigate(view, 'last');
  assert.equal(navigator.getFocus(), view.rows.at(-1)?.key);
  navigator.navigate(view, 'first');
  assert.equal(navigator.getFocus(), view.rows[0].key);
});

await test('virtual window math stays bounded for 10,000 rows and reveals keyboard focus', () => {
  const window = computeFixedVirtualWindow({
    rowCount: 10_000,
    scrollOffsetPx: 160_000,
    viewportHeightPx: 320,
    rowHeightPx: 32,
    overscanRows: 6,
  });
  assert.deepEqual(window, {
    startIndex: 4_994,
    endIndex: 5_016,
    offsetTopPx: 159_808,
    offsetBottomPx: 159_488,
    totalHeightPx: 320_000,
  });
  assert.equal(window.endIndex - window.startIndex, 22);
  const bottom = computeFixedVirtualWindow({
    rowCount: 10_000,
    scrollOffsetPx: Number.MAX_SAFE_INTEGER,
    viewportHeightPx: 320,
    rowHeightPx: 32,
    overscanRows: 6,
  });
  assert.equal(bottom.endIndex, 10_000);
  assert.equal(scrollOffsetToRevealRow(500, 0, 320, 32, 10_000), 15_712);
  assert.equal(scrollOffsetToRevealRow(4, 0, 320, 32, 10_000), 0);
});

// Stable imported IDs may carry lone surrogates; encodeURIComponent threw on
// them, so such a project could not show its Objects tree at all.
await test('lone surrogates in entity IDs keep distinct row IDs instead of throwing', () => {
  const { state } = treeFixture();
  const object = state.plates[0].objects[0];
  object.id = 'import:test:\ud800' as typeof object.id;
  const copy = cloneProjectState(state);
  copy.plates[0].objects[0].id = 'import:test:\ud801' as typeof object.id;
  const first = projectObjectsTree(state).rowsByKey.get('object:import:test:\ud800');
  const second = projectObjectsTree(copy).rowsByKey.get('object:import:test:\ud801');
  assert.equal(first?.id, 'orcaxr-object-row-object%3Aimport%3Atest%3A%uD800');
  assert.equal(second?.id, 'orcaxr-object-row-object%3Aimport%3Atest%3A%uD801');
  assert.equal(objectTreeRowId('plate:%uD800'), 'orcaxr-object-row-plate%3A%25uD800');
  assert.equal(objectTreeRowId('a\ud83d\ude00b'), `orcaxr-object-row-${encodeURIComponent('a\ud83d\ude00b')}`);
});

// Folding followed the host's default locale, so in a Turkish browser
// 'Instance' folded to 'ınstance' and the query 'instance' found nothing.
await test('search folding does not follow the default locale', () => {
  const { state, secondInstance } = treeFixture();
  const instance = state.plates[0].objects[0].instances.find((candidate) => candidate.id === secondInstance)!;
  instance.name = 'IDLE COPY';
  const lower = String.prototype.toLocaleLowerCase;
  // A Turkish default locale: only an explicit locale escapes it.
  String.prototype.toLocaleLowerCase = function (this: string, ...locales: unknown[]) {
    return lower.call(this, ...(locales.length > 0 && locales[0] !== undefined ? (locales as string[]) : ['tr']));
  };
  try {
    const view = buildObjectTreeView(projectObjectsTree(state), { filterQuery: 'idle copy' });
    assert.deepEqual(
      view.rows.filter((row) => row.matchedFilter).map((row) => row.label),
      ['IDLE COPY'],
    );
  } finally {
    String.prototype.toLocaleLowerCase = lower;
  }
});

await test('row activation follows the panel: anchors, visible ranges and toggled primaries', () => {
  const { state, secondInstance } = treeFixture();
  const view = buildObjectTreeView(projectObjectsTree(state));
  const objectRow = view.rows.find((row) => row.kind === 'object')!;
  const settingsRow = view.rows.find((row) => row.kind === 'settings')!;
  assert.deepEqual(objectTreeSelectionRequest(view, settingsRow, 'replace', 'plate:x'), { anchorKey: 'plate:x' });

  const replaced = objectTreeSelectionRequest(view, objectRow, 'replace', undefined);
  assert.equal(replaced.anchorKey, objectRow.key);
  assert.deepEqual(resolveObjectTreeSelection({ refs: [] }, replaced.request!), {
    refs: [objectRow.entity],
    primary: objectRow.entity,
  });

  // A range spans the visible rows between the anchor and the row, each entity once.
  const plateRow = view.rows[0];
  const ranged = objectTreeSelectionRequest(view, objectRow, 'range', plateRow.key);
  assert.equal(ranged.anchorKey, plateRow.key);
  assert.deepEqual(ranged.request!.range, [plateRow.entity, objectRow.entity]);
  assert.deepEqual(objectTreeSelectionRequest(view, objectRow, 'range', 'plate:hidden').request!.range, [
    objectRow.entity,
  ]);

  // Toggling off keeps the previous primary while it stays selected.
  const instance = { kind: 'instance' as const, id: secondInstance };
  const toggled = objectTreeSelectionRequest(view, objectRow, 'toggle', undefined).request!;
  assert.deepEqual(resolveObjectTreeSelection({ refs: [instance, objectRow.entity!], primary: instance }, toggled), {
    refs: [instance],
    primary: instance,
  });
  assert.deepEqual(resolveObjectTreeSelection({ refs: [objectRow.entity!], primary: objectRow.entity }, toggled), {
    refs: [],
  });
  assert.deepEqual(resolveObjectTreeSelection({ refs: [instance] }, toggled), {
    refs: [instance, objectRow.entity],
    primary: objectRow.entity,
  });
});

console.log(`\nCanonical Objects tree: ${passed} tests passed.`);
