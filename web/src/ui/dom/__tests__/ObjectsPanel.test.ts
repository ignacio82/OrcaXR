import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId } from '../../../project/domain/ids';
import { selectionKey } from '../../../project/selection';
import type {
  ObjectTreeProjection,
  ObjectTreeRow,
  ObjectTreeRowKey,
  ObjectTreeSelectionSnapshot,
} from '../../../project/objects';
import {
  ObjectsPanel,
  type ObjectsPanelAdapter,
  type ObjectsPanelRenameRequest,
  type ObjectsPanelRevealRequest,
  type ObjectsPanelSelectionRequest,
  type ObjectsPanelSnapshot,
} from '../ObjectsPanel';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

interface Harness {
  readonly dom: any;
  readonly document: Document;
  readonly container: HTMLElement;
  readonly selections: ObjectsPanelSelectionRequest[];
  readonly renames: ObjectsPanelRenameRequest[];
  readonly reveals: ObjectsPanelRevealRequest[];
  readonly panel: ObjectsPanel;
}

function createHarness(
  projection = fixtureProjection(),
  selection: ObjectTreeSelectionSnapshot = { refs: [] },
): Harness {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const container = document.querySelector<HTMLElement>('#host')!;
  const selections: ObjectsPanelSelectionRequest[] = [];
  const renames: ObjectsPanelRenameRequest[] = [];
  const reveals: ObjectsPanelRevealRequest[] = [];
  const snapshot: ObjectsPanelSnapshot = { projection, selection };
  const adapter: ObjectsPanelAdapter = {
    getSnapshot: () => snapshot,
    onSelectionRequest: (request) => {
      selections.push(request);
    },
    onRenameRequest: (request) => {
      renames.push(request);
    },
    onRevealRequest: (request) => {
      reveals.push(request);
    },
  };
  const panel = new ObjectsPanel(container, adapter, {
    rowHeightPx: 32,
    viewportHeightPx: 160,
    overscanRows: 2,
  });
  panel.mount();
  return { dom, document, container, selections, renames, reveals, panel };
}

await test('renders an accessible searchable tree and keeps filtering independent from expansion', () => {
  const harness = createHarness();
  const { document, dom } = harness;
  const tree = document.querySelector<HTMLElement>('[data-objects-tree]')!;
  assert.equal(tree.getAttribute('role'), 'tree');
  assert.equal(tree.getAttribute('aria-multiselectable'), 'true');
  assert.equal(tree.getAttribute('aria-label'), 'Project objects');

  assert.equal(tree.querySelectorAll('[role="treeitem"]').length, 3);
  const plate = row(document, 'plate:import:test:plate');
  assert.equal(plate.getAttribute('aria-level'), '1');
  assert.equal(plate.getAttribute('aria-expanded'), 'true');
  assert.equal(plate.tabIndex, 0);
  const object = row(document, 'object:import:test:object-a');
  assert.equal(object.getAttribute('aria-level'), '2');
  assert.equal(object.getAttribute('aria-expanded'), 'false');

  object.querySelector<HTMLButtonElement>('[data-objects-action="disclosure"]')!.click();
  assert.equal(tree.querySelectorAll('[role="treeitem"]').length, 4);
  assert.equal(row(document, 'object:import:test:object-a').getAttribute('aria-expanded'), 'true');

  const search = document.querySelector<HTMLInputElement>('[data-objects-search]')!;
  search.value = 'detail volume';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(
    [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((item) => item.dataset.objectsRowKey),
    ['plate:import:test:plate', 'object:import:test:object-a', 'volume:import:test:volume-a'],
  );
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /3 matching tree rows/);
  assert.equal(
    row(document, 'object:import:test:object-a').querySelector<HTMLButtonElement>('[data-objects-action="disclosure"]')
      ?.disabled,
    true,
  );

  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(search.value, '');
  assert.equal(row(document, 'object:import:test:object-a').getAttribute('aria-expanded'), 'true');
  harness.panel.dispose();
  assert.equal(harness.container.childElementCount, 0);
});

await test('emits replace, toggle, and exact visible range requests for pointer modifiers', () => {
  const harness = createHarness();
  const { document, dom, selections } = harness;
  row(document, 'object:import:test:object-a')
    .querySelector<HTMLButtonElement>('[data-objects-action="disclosure"]')!
    .click();

  row(document, 'object:import:test:object-a').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  row(document, 'volume:import:test:volume-a').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }),
  );
  row(document, 'object:import:test:object-b').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true }),
  );

  assert.deepEqual(
    selections.map((request) => request.mode),
    ['replace', 'toggle', 'range'],
  );
  assert.equal(selections[2].anchor?.kind, 'volume');
  assert.deepEqual(selections[2].range?.map(selectionKey), [
    'volume:import:test:volume-a',
    'object:import:test:object-b',
  ]);
  harness.panel.dispose();
});

await test('supports roving keyboard navigation, inline rename, and keyboard reveal', () => {
  const harness = createHarness();
  const { document, dom, renames, reveals } = harness;
  let active = row(document, 'plate:import:test:plate');
  active.focus();
  active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal((document.activeElement as HTMLElement).dataset.objectsRowKey, 'object:import:test:object-a');

  active = document.activeElement as HTMLElement;
  active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(row(document, 'object:import:test:object-a').getAttribute('aria-expanded'), 'true');
  active = document.activeElement as HTMLElement;
  active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal((document.activeElement as HTMLElement).dataset.objectsRowKey, 'volume:import:test:volume-a');

  active = document.activeElement as HTMLElement;
  active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal((document.activeElement as HTMLElement).dataset.objectsRowKey, 'object:import:test:object-a');
  active = document.activeElement as HTMLElement;
  active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));

  const renameInput = document.querySelector<HTMLInputElement>('[data-objects-rename-input]')!;
  assert.equal(document.activeElement, renameInput);
  renameInput.value = 'Renamed assembly';
  renameInput
    .closest<HTMLFormElement>('form')!
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(renames, [
    {
      rowKey: 'object:import:test:object-a',
      entity: { kind: 'object', id: entityId<'object'>('import:test:object-a') },
      previousName: 'Assembly A',
      nextName: 'Renamed assembly',
    },
  ]);

  active = row(document, 'object:import:test:object-a');
  active.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
  assert.deepEqual(reveals, [
    {
      rowKey: 'object:import:test:object-a',
      entity: { kind: 'object', id: entityId<'object'>('import:test:object-a') },
    },
  ]);

  active.dispatchEvent(
    new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
  );
  const contextMenu = document.querySelector<HTMLElement>('[data-objects-context-menu]')!;
  assert.equal(contextMenu.getAttribute('role'), 'menu');
  assert.deepEqual(
    [...contextMenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ['Reveal in scene', 'Rename'],
  );
  contextMenu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.activeElement?.textContent, 'Rename');
  (document.activeElement as HTMLButtonElement).click();
  assert.equal(document.activeElement?.getAttribute('data-objects-rename-input'), 'true');
  (document.activeElement as HTMLInputElement).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(document.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1);
  harness.panel.dispose();
});

await test('opens the row context menu by touch long-press without changing selection', async () => {
  const harness = createHarness();
  const { document, dom, selections } = harness;
  const target = row(document, 'object:import:test:object-a');
  target.dispatchEvent(touchPointerEvent(dom, 'pointerdown', 44, 72));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 550));

  const menu = document.querySelector<HTMLElement>('[data-objects-context-menu]');
  assert.ok(menu);
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(document.activeElement?.textContent, 'Reveal in scene');
  assert.deepEqual(selections, []);

  target.dispatchEvent(touchPointerEvent(dom, 'pointerup', 44, 72));
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(selections, [], 'the synthesized click after a long-press must be suppressed');
  harness.panel.dispose();
});

await test('keeps a bounded fixed virtual window and a rendered roving tab stop', () => {
  const projection = largeProjection(10_000);
  const startedAt = performance.now();
  const harness = createHarness(projection);
  const firstRenderMs = performance.now() - startedAt;
  const { document, dom } = harness;
  const tree = document.querySelector<HTMLElement>('[data-objects-tree]')!;
  assert.equal(tree.querySelectorAll('[role="treeitem"]').length, 7);
  assert.ok(firstRenderMs < 2_000, `10,000-row first render took ${firstRenderMs.toFixed(1)} ms`);

  tree.scrollTop = 16_000;
  tree.dispatchEvent(new dom.window.Event('scroll'));
  const rendered = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  assert.equal(rendered.length, 9);
  assert.equal(rendered[0].dataset.objectsRowKey, 'object:import:test:large-0498');
  assert.equal(rendered.filter((item) => item.tabIndex === 0).length, 1);
  harness.panel.dispose();
});

function touchPointerEvent(dom: any, type: string, clientX: number, clientY: number): Event {
  const event = new dom.window.MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: 'touch' },
  });
  return event;
}

function fixtureProjection(): ObjectTreeProjection {
  const plate = entityId<'plate'>('import:test:plate');
  const objectA = entityId<'object'>('import:test:object-a');
  const objectB = entityId<'object'>('import:test:object-b');
  const volumeA = entityId<'volume'>('import:test:volume-a');
  const rows: ObjectTreeRow[] = [
    treeRow({
      key: `plate:${plate}`,
      kind: 'plate',
      label: 'Build plate',
      childrenKeys: [`object:${objectA}`, `object:${objectB}`],
      entity: { kind: 'plate', id: plate },
    }),
    treeRow({
      key: `object:${objectA}`,
      kind: 'object',
      parentKey: `plate:${plate}`,
      label: 'Assembly A',
      childrenKeys: [`volume:${volumeA}`],
      entity: { kind: 'object', id: objectA },
    }),
    treeRow({
      key: `volume:${volumeA}`,
      kind: 'volume',
      parentKey: `object:${objectA}`,
      label: 'Detail volume',
      entity: { kind: 'volume', id: volumeA },
    }),
    treeRow({
      key: `object:${objectB}`,
      kind: 'object',
      parentKey: `plate:${plate}`,
      label: 'Assembly B',
      entity: { kind: 'object', id: objectB },
    }),
  ];
  return projection(rows, [`plate:${plate}`], [`plate:${plate}`]);
}

function largeProjection(count: number): ObjectTreeProjection {
  const rows = Array.from({ length: count }, (_, index) => {
    const id = entityId<'object'>(`import:test:large-${String(index).padStart(4, '0')}`);
    return treeRow({
      key: `object:${id}`,
      kind: 'object',
      label: `Object ${index}`,
      entity: { kind: 'object', id },
    });
  });
  return projection(
    rows,
    rows.map((row) => row.key),
    [],
  );
}

function projection(
  rows: readonly ObjectTreeRow[],
  rootKeys: readonly ObjectTreeRowKey[],
  defaultExpandedKeys: readonly ObjectTreeRowKey[],
): ObjectTreeProjection {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const entityRowKeys = new Map<string, ObjectTreeRowKey>();
  for (const row of rows) if (row.entity) entityRowKeys.set(selectionKey(row.entity), row.key);
  return { rowsByKey, rootKeys, entityRowKeys, defaultExpandedKeys };
}

function treeRow(
  value: Pick<ObjectTreeRow, 'key' | 'kind' | 'label'> &
    Partial<Pick<ObjectTreeRow, 'parentKey' | 'childrenKeys' | 'entity' | 'description'>>,
): ObjectTreeRow {
  return {
    key: value.key,
    id: `test-row-${value.key}`,
    kind: value.kind,
    ...(value.parentKey ? { parentKey: value.parentKey } : {}),
    childrenKeys: value.childrenKeys ?? [],
    label: value.label,
    ...(value.description ? { description: value.description } : {}),
    ...(value.entity ? { entity: value.entity } : {}),
    indicators: { editable: true },
    searchText: `${value.label} ${value.kind}`.toLowerCase(),
  };
}

function row(document: Document, key: ObjectTreeRowKey): HTMLElement {
  const result = [...document.querySelectorAll<HTMLElement>('[data-objects-row-key]')].find(
    (candidate) => candidate.dataset.objectsRowKey === key,
  );
  assert.ok(result, `Expected rendered Objects row ${key}`);
  return result;
}

console.log(`\nDOM Objects panel: ${passed} tests passed.`);
