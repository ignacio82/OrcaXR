/**
 * Traces for the context menu (P11.2).
 *
 * The menu's job is to be the *same* menu everywhere: one action model, one set
 * of availability sentences, one behaviour when a key is pressed. So these
 * traces check the two halves that decide that — what the catalog yields for a
 * target, and what the rendered menu does with it — rather than the styling.
 */

import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { buildRegistry } from '../../../actions/catalog';
import { UiState } from '../../../actions/UiState';
import { ContextMenu, contextMenuGroups, type ContextMenuGroup, type ContextMenuItem } from '../ContextMenu';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const globalAny = globalThis as unknown as Record<string, unknown>;
  globalAny.window = dom.window;
  globalAny.document = dom.window.document;
  globalAny.HTMLElement = dom.window.HTMLElement;
  const menu = new ContextMenu(dom.window.document.body);
  return { dom, document: dom.window.document as Document, menu };
}

function groupsOf(items: ContextMenuItem[]): ContextMenuGroup[] {
  return [{ label: 'Scene', items }];
}

test('the catalog decides what a right-click offers, and states why not', () => {
  const registry = buildRegistry();
  const state = new UiState().get();
  const invoked: string[] = [];
  const groups = contextMenuGroups(registry, 'object', state, (action) => invoked.push(action.id));
  const ids = groups.flatMap((group) => group.items.map((item) => item.id));
  assert.ok(ids.includes('edit_delete_selected'), 'an object menu can delete the model it was opened on');
  assert.ok(ids.includes('mirror_x'));
  assert.equal(ids.includes('add_plate'), false, 'a plate action is not offered on a model');

  // Nothing is selected in a fresh state, so the selection-gated entries are
  // disabled *with the registry's own sentence* rather than hidden or silent.
  const disabled = groups.flatMap((group) => group.items.filter((item) => item.disabled));
  assert.ok(disabled.length > 0);
  for (const item of disabled) assert.ok(item.reason && item.reason.length > 0, `${item.id} is silent about why`);

  const plate = contextMenuGroups(registry, 'plate', state, () => {});
  const plateIds = plate.flatMap((group) => group.items.map((item) => item.id));
  assert.ok(plateIds.includes('arrange_all') && plateIds.includes('add_plate'));
  assert.equal(plateIds.includes('mirror_x'), false, 'a model action is not offered on the bed');

  // Groups are the catalog's own, in the catalog's own order — the same order
  // the menu bar uses, so the two surfaces cannot disagree about where a thing
  // lives. Plate management is a System action upstream and here, which is why
  // "Add build plate" sits apart from the scene operations rather than beside
  // them.
  assert.deepEqual(
    plate.map((group) => group.label),
    ['File', 'Edit', 'Scene', 'Slice', 'System'],
  );
});

test('choosing an item runs it once and closes the menu', () => {
  const { document, menu } = harness();
  const runs: string[] = [];
  menu.open({
    x: 10,
    y: 10,
    ariaLabel: 'Actions',
    groups: groupsOf([{ id: 'a', label: 'Alpha', onSelect: () => runs.push('a') }]),
  });
  assert.equal(menu.isOpen(), true);
  document.querySelector<HTMLElement>('[data-context-item="a"]')?.click();
  assert.deepEqual(runs, ['a']);
  assert.equal(menu.isOpen(), false);
  assert.equal(document.querySelector('[data-context-menu]'), null);
});

test('a disabled item cannot be chosen and says why', () => {
  const { document, menu } = harness();
  const runs: string[] = [];
  menu.open({
    x: 10,
    y: 10,
    ariaLabel: 'Actions',
    groups: groupsOf([
      { id: 'a', label: 'Alpha', disabled: true, reason: 'Select a model first.', onSelect: () => runs.push('a') },
    ]),
  });
  const item = document.querySelector<HTMLButtonElement>('[data-context-item="a"]');
  assert.ok(item);
  assert.equal(item.disabled, true);
  assert.equal(item.getAttribute('aria-disabled'), 'true');
  assert.equal(item.title, 'Select a model first.');
  item.click();
  assert.deepEqual(runs, [], 'a disabled row is not a slow row');
});

test('a label is inserted as text, never as markup', () => {
  const { document, menu } = harness();
  menu.open({
    x: 0,
    y: 0,
    ariaLabel: 'Actions',
    groups: groupsOf([{ id: 'a', label: '<img src=x onerror=alert(1)>', onSelect: () => {} }]),
  });
  const item = document.querySelector<HTMLElement>('[data-context-item="a"]');
  assert.equal(item?.querySelector('img'), null);
  assert.equal(item?.textContent, '<img src=x onerror=alert(1)>');
});

test('Escape closes and gives focus back to where the click came from', () => {
  const { dom, document, menu } = harness();
  const returnFocus = document.createElement('button');
  document.body.appendChild(returnFocus);
  menu.open({
    x: 0,
    y: 0,
    ariaLabel: 'Actions',
    groups: groupsOf([{ id: 'a', label: 'Alpha', onSelect: () => {} }]),
    returnFocus,
  });
  assert.equal(document.activeElement?.getAttribute('data-context-item'), 'a');
  document
    .querySelector('[data-context-menu]')
    ?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.isOpen(), false);
  assert.equal(document.activeElement, returnFocus);
});

test('arrows walk only the items that can be chosen, and wrap', () => {
  const { dom, document, menu } = harness();
  menu.open({
    x: 0,
    y: 0,
    ariaLabel: 'Actions',
    groups: groupsOf([
      { id: 'a', label: 'Alpha', onSelect: () => {} },
      { id: 'b', label: 'Beta', disabled: true, reason: 'no', onSelect: () => {} },
      { id: 'c', label: 'Gamma', onSelect: () => {} },
    ]),
  });
  const press = (key: string) =>
    document
      .querySelector('[data-context-menu]')
      ?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  press('ArrowDown');
  assert.equal(document.activeElement?.getAttribute('data-context-item'), 'c', 'the disabled row is skipped');
  press('ArrowDown');
  assert.equal(document.activeElement?.getAttribute('data-context-item'), 'a', 'and it wraps');
  press('End');
  assert.equal(document.activeElement?.getAttribute('data-context-item'), 'c');
});

test('an outside press dismisses it', () => {
  const { dom, document, menu } = harness();
  menu.open({ x: 0, y: 0, ariaLabel: 'Actions', groups: groupsOf([{ id: 'a', label: 'Alpha', onSelect: () => {} }]) });
  document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(menu.isOpen(), false);
});

test('an empty menu does not open at all', () => {
  const { document, menu } = harness();
  menu.open({ x: 0, y: 0, ariaLabel: 'Actions', groups: [{ label: 'Scene', items: [] }] });
  assert.equal(menu.isOpen(), false);
  assert.equal(document.querySelector('[data-context-menu]'), null);
});

test('it stays inside the window it was opened near the edge of', () => {
  const { document, menu } = harness();
  menu.open({
    x: 5000,
    y: 5000,
    ariaLabel: 'Actions',
    groups: groupsOf([{ id: 'a', label: 'Alpha', onSelect: () => {} }]),
  });
  const element = document.querySelector<HTMLElement>('[data-context-menu]');
  assert.ok(element);
  assert.ok(Number.parseInt(element.style.left, 10) < 5000);
  assert.ok(Number.parseInt(element.style.top, 10) < 5000);
});

console.log(`\nContext menu: ${passed} tests passed.`);
