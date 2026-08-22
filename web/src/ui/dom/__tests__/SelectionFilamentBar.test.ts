import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId } from '../../../project/domain/ids';
import type {
  CanonicalFilamentAssignmentSnapshot,
  CanonicalFilamentOption,
} from '../../../workspace/CanonicalWorkspaceController';
import type { FilamentAssignmentApplyRequest } from '../FilamentAssignmentSelector';
import { SelectionFilamentBar, type SelectionFilamentBarAdapter } from '../SelectionFilamentBar';

const matte = entityId<'physical-filament'>('import:bar-test:matte');
const snapSpeed = entityId<'physical-filament'>('import:bar-test:snapspeed');
const disabled = entityId<'physical-filament'>('import:bar-test:disabled');
const mixed = entityId<'mixed-filament'>('import:bar-test:mixed');
const objectId = entityId<'object'>('import:bar-test:object');
const otherObjectId = entityId<'object'>('import:bar-test:object-2');
const instanceId = entityId<'instance'>('import:bar-test:instance');

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function options(): readonly CanonicalFilamentOption[] {
  return [
    {
      id: matte,
      kind: 'physical',
      name: 'Snapmaker PLA Matte',
      color: '#1e88e5',
      enabled: true,
      material: 'PLA',
      toolId: 0,
      recipe: [],
      warnings: [],
    },
    {
      id: snapSpeed,
      kind: 'physical',
      name: 'Snapmaker PLA SnapSpeed',
      color: '#e2dedb',
      enabled: true,
      material: 'PLA',
      toolId: 2,
      recipe: [],
      warnings: [],
    },
    {
      id: disabled,
      kind: 'physical',
      name: 'Unloaded head',
      color: '#333333',
      enabled: false,
      material: 'PETG',
      toolId: 3,
      recipe: [],
      warnings: ['This physical filament is disabled.'],
    },
    {
      id: mixed,
      kind: 'mixed',
      name: 'Two-tone',
      color: '#7b4bd0',
      enabled: true,
      material: 'PLA',
      distributionMode: 'ratio',
      recipe: [
        { filamentId: matte, name: 'Snapmaker PLA Matte', color: '#1e88e5', weight: 1 },
        { filamentId: snapSpeed, name: 'Snapmaker PLA SnapSpeed', color: '#e2dedb', weight: 1 },
      ],
      warnings: [],
    },
  ];
}

function snapshot(
  scopes: readonly { label: string; local?: typeof matte | typeof snapSpeed | typeof mixed; id?: typeof objectId }[],
  unsupported = false,
  revision = 11,
): CanonicalFilamentAssignmentSnapshot {
  return {
    sourceRevision: revision,
    sourceHash: `hash-${revision}`,
    scopes: scopes.map((scope) => ({
      entity: { kind: 'object' as const, id: scope.id ?? objectId },
      objectId: scope.id ?? objectId,
      label: scope.label,
      ...(scope.local ? { localFilamentId: scope.local, effectiveFilamentId: scope.local } : {}),
    })),
    unsupportedSelection: unsupported ? [{ kind: 'instance', id: instanceId }] : [],
    options: options(),
  };
}

function createDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="host" hidden></div></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  return { dom, document, container: document.querySelector<HTMLElement>('#host')! };
}

await test('one press on a loaded head assigns it to the selection', async () => {
  const { document, container } = createDom();
  const applied: FilamentAssignmentApplyRequest[] = [];
  const adapter: SelectionFilamentBarAdapter = {
    getSnapshot: () => snapshot([{ label: 'Wedge' }]),
    onApply: (request) => {
      applied.push(request);
    },
  };
  const bar = new SelectionFilamentBar(container, adapter);
  bar.mount();

  assert.equal(container.hidden, false, 'an assignable selection shows the bar');
  assert.equal(document.querySelector('[data-selection-filament-label]')?.textContent, 'Wedge');
  const chips = [...document.querySelectorAll<HTMLButtonElement>('[data-selection-filament-chip]')];
  assert.deepEqual(
    chips.map((chip) => chip.dataset.selectionFilamentChip),
    ['physical', 'physical', 'physical', 'mixed', 'inherit'],
    'every head and mixed filament is one press away, with Default last',
  );
  assert.match(chips[0].textContent ?? '', /Snapmaker PLA Matte/);
  assert.equal(chips[0].querySelector<HTMLElement>('.selection-filament-index')?.textContent, '1');
  assert.equal(chips[1].querySelector<HTMLElement>('.selection-filament-index')?.textContent, '3', 'head, not row');
  assert.equal(chips[2].disabled, true, 'an unloaded head cannot be pressed');

  chips[1].click();
  await Promise.resolve();
  assert.equal(applied.length, 1, 'the press is the whole interaction — no confirming button');
  assert.deepEqual(applied[0].entities, [{ kind: 'object', id: objectId }]);
  assert.equal(applied[0].filamentId, snapSpeed);
  assert.equal(applied[0].sourceRevision, 11, 'the request carries the guard of the snapshot it displayed');
  assert.equal(applied[0].sourceHash, 'hash-11');
});

await test('Default clears the local assignment', async () => {
  const { document, container } = createDom();
  const applied: FilamentAssignmentApplyRequest[] = [];
  const bar = new SelectionFilamentBar(container, {
    getSnapshot: () => snapshot([{ label: 'Wedge', local: matte }]),
    onApply: (request) => {
      applied.push(request);
    },
  });
  bar.mount();
  document.querySelector<HTMLButtonElement>('[data-selection-filament-chip="inherit"]')!.click();
  await Promise.resolve();
  assert.equal(applied[0].filamentId, null);
});

await test('the current choice reads back, and a mixed selection claims none', () => {
  const { document, container } = createDom();
  const bar = new SelectionFilamentBar(container, {
    getSnapshot: () => snapshot([{ label: 'Wedge', local: matte }]),
    onApply: () => undefined,
  });
  bar.mount();
  const pressed = [...document.querySelectorAll<HTMLButtonElement>('[data-selection-filament-chip]')].filter(
    (chip) => chip.getAttribute('aria-pressed') === 'true',
  );
  assert.deepEqual(
    pressed.map((chip) => chip.dataset.filamentId),
    [matte],
  );

  const divided = createDom();
  const dividedBar = new SelectionFilamentBar(divided.container, {
    getSnapshot: () =>
      snapshot([
        { label: 'Wedge', local: matte },
        { label: 'Riser', local: snapSpeed, id: otherObjectId },
      ]),
    onApply: () => undefined,
  });
  dividedBar.mount();
  assert.equal(
    divided.document.querySelectorAll('[data-selection-filament-chip][aria-pressed="true"]').length,
    0,
    'scopes that disagree must not show one of their filaments as the answer for all',
  );
  assert.equal(
    divided.document.querySelector('[data-selection-filament-label]')?.textContent,
    '2 selected',
    'the bar names what it is about to change',
  );
});

await test('nothing assignable means no bar at all', () => {
  const { container } = createDom();
  const bar = new SelectionFilamentBar(container, {
    getSnapshot: () => snapshot([]),
    onApply: () => undefined,
  });
  bar.mount();
  assert.equal(container.hidden, true, 'an empty selection is not a message');

  const blocked = createDom();
  const blockedBar = new SelectionFilamentBar(blocked.container, {
    getSnapshot: () => snapshot([{ label: 'Wedge' }], true),
    onApply: () => undefined,
  });
  blockedBar.mount();
  assert.equal(blocked.container.hidden, true, 'a selection with an unassignable row is not silently narrowed');
});

await test('a refused assignment is reported in place and changes nothing', async () => {
  const { document, container } = createDom();
  const errors: unknown[] = [];
  const bar = new SelectionFilamentBar(container, {
    getSnapshot: () => snapshot([{ label: 'Wedge' }]),
    onApply: () => Promise.reject(new Error('The project changed since this bar was drawn.')),
    onError: (error) => errors.push(error),
  });
  bar.mount();
  document.querySelector<HTMLButtonElement>('[data-selection-filament-chip="physical"]')!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = document.querySelector<HTMLElement>('[data-selection-filament-status]')!;
  assert.match(status.textContent ?? '', /changed since/);
  assert.equal(status.dataset.selectionFilamentError, 'true');
  assert.equal(status.getAttribute('role'), 'alert');
  assert.equal(errors.length, 1, 'the host is told too, so the shell can surface it');
});

await test('a selection change redraws the bar and disposing removes it', () => {
  const { document, container } = createDom();
  let label = 'Wedge';
  let listener: (() => void) | undefined;
  const bar = new SelectionFilamentBar(container, {
    getSnapshot: () => snapshot([{ label }]),
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    onApply: () => undefined,
  });
  bar.mount();
  label = 'Riser';
  listener?.();
  assert.equal(document.querySelector('[data-selection-filament-label]')?.textContent, 'Riser');
  bar.dispose();
  assert.equal(document.querySelector('[data-selection-filament-bar]'), null);
  assert.equal(listener, undefined, 'the subscription is released with the bar');
});

console.log(`\nSelection filament bar: ${passed} tests passed.`);
