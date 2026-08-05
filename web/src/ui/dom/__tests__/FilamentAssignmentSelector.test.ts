import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId } from '../../../project/domain/ids';
import type {
  CanonicalFilamentAssignmentSnapshot,
  CanonicalFilamentOption,
} from '../../../workspace/CanonicalWorkspaceController';
import {
  FilamentAssignmentSelector,
  type FilamentAssignmentApplyRequest,
  type FilamentAssignmentSelectorAdapter,
} from '../FilamentAssignmentSelector';

const physicalA = entityId<'physical-filament'>('import:selector-test:physical-a');
const physicalB = entityId<'physical-filament'>('import:selector-test:physical-b');
const mixed = entityId<'mixed-filament'>('import:selector-test:mixed-ab');
const objectId = entityId<'object'>('import:selector-test:object');
const volumeId = entityId<'volume'>('import:selector-test:volume');
const instanceId = entityId<'instance'>('import:selector-test:instance');

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function options(): readonly CanonicalFilamentOption[] {
  return [
    {
      id: physicalA,
      kind: 'physical',
      name: 'Head A PLA',
      color: '#ff0000',
      enabled: true,
      material: 'PLA',
      presetId: 'pla-a',
      toolId: 0,
      recipe: [],
      warnings: [],
    },
    {
      id: physicalB,
      kind: 'physical',
      name: 'Head B PETG',
      color: '#0000ff',
      enabled: false,
      material: 'PETG',
      toolId: 1,
      recipe: [],
      warnings: ['This physical filament is disabled.'],
    },
    {
      id: mixed,
      kind: 'mixed',
      name: 'Purple ratio',
      color: '#800080',
      enabled: true,
      material: 'PLA + PETG',
      distributionMode: 'ratio',
      recipe: [
        { filamentId: physicalA, name: 'Head A PLA', color: '#ff0000', weight: 3 },
        { filamentId: physicalB, name: 'Head B PETG', color: '#0000ff', weight: 1 },
      ],
      warnings: ['Recipe combines PLA and PETG; verify material compatibility before slicing.'],
    },
  ];
}

function snapshot(
  localIds: readonly (typeof physicalA | typeof physicalB | typeof mixed | undefined)[],
  unsupported = false,
  revision = 7,
): CanonicalFilamentAssignmentSnapshot {
  const scopes = [
    {
      entity: { kind: 'object' as const, id: objectId },
      objectId,
      label: 'Assembly',
      ...(localIds[0] ? { localFilamentId: localIds[0], effectiveFilamentId: localIds[0] } : {}),
    },
    {
      entity: { kind: 'volume' as const, id: volumeId },
      objectId,
      label: 'Assembly / Detail',
      ...(localIds[1] ? { localFilamentId: localIds[1], effectiveFilamentId: localIds[1] } : {}),
      ...(!localIds[1] && localIds[0] ? { inheritedFilamentId: localIds[0], effectiveFilamentId: localIds[0] } : {}),
    },
  ];
  return {
    sourceRevision: revision,
    sourceHash: `hash-${revision}`,
    scopes,
    unsupportedSelection: unsupported ? [{ kind: 'instance', id: instanceId }] : [],
    options: options(),
  };
}

function createDom() {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  return { dom, document, container: document.querySelector<HTMLElement>('#host')! };
}

await test('renders stable IDs, inherited/effective state, recipes, warnings, and disabled definitions', () => {
  const { document, container } = createDom();
  const adapter: FilamentAssignmentSelectorAdapter = {
    getSnapshot: () => snapshot([physicalA, undefined]),
    onApply: () => undefined,
  };
  const selector = new FilamentAssignmentSelector(container, adapter);
  selector.mount();

  const fieldset = document.querySelector<HTMLFieldSetElement>('fieldset')!;
  assert.equal(fieldset.disabled, false);
  assert.match(container.textContent ?? '', /Assembly \/ Detail — local: Default \/ inherit; effective: Head A PLA/);
  assert.match(container.textContent ?? '', /Material PLA · Preset pla-a · Color #ff0000/);
  assert.match(container.textContent ?? '', /Recipe: Head A PLA 75% \+ Head B PETG 25%/);
  assert.match(container.textContent ?? '', /verify material compatibility/);

  const stableValues = [...document.querySelectorAll<HTMLInputElement>('input[data-filament-id]')].map(
    (input) => input.value,
  );
  assert.deepEqual(stableValues, [physicalA, physicalB, mixed]);
  assert.ok(stableValues.every((value) => !/^\d+$/.test(value)));
  assert.deepEqual(
    [...document.querySelectorAll<HTMLElement>('[data-recipe-component-id]')].map(
      (component) => component.dataset.recipeComponentId,
    ),
    [physicalA, physicalB],
  );
  assert.equal(document.querySelector<HTMLInputElement>(`input[data-filament-id="${physicalB}"]`)?.disabled, true);
  assert.equal(document.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked').length, 0);
  assert.match(document.querySelector('[data-filament-assignment-status]')?.textContent ?? '', /multiple local/);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-filament-assignment-apply]')?.disabled, true);

  selector.dispose();
  assert.equal(container.childElementCount, 0);
});

await test('submits one guarded stable-ID request for all scopes and supports explicit inherit', async () => {
  const { document, container } = createDom();
  let current = snapshot([undefined, undefined]);
  const requests: FilamentAssignmentApplyRequest[] = [];
  const adapter: FilamentAssignmentSelectorAdapter = {
    getSnapshot: () => current,
    onApply: (request) => {
      requests.push(request);
      current = snapshot(
        [request.filamentId ?? undefined, request.filamentId ?? undefined],
        false,
        current.sourceRevision + 1,
      );
    },
  };
  const selector = new FilamentAssignmentSelector(container, adapter);
  selector.mount();

  assert.equal(document.querySelector<HTMLInputElement>('[data-filament-assignment-kind="inherit"]')?.checked, true);
  const mixedRadio = document.querySelector<HTMLInputElement>(`input[data-filament-id="${mixed}"]`)!;
  mixedRadio.click();
  const apply = document.querySelector<HTMLButtonElement>('[data-filament-assignment-apply]')!;
  assert.equal(apply.disabled, false);
  apply.click();
  await Promise.resolve();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    entities: [
      { kind: 'object', id: objectId },
      { kind: 'volume', id: volumeId },
    ],
    filamentId: mixed,
    sourceRevision: 7,
    sourceHash: 'hash-7',
  });
  assert.equal(Object.isFrozen(requests[0]), true);
  assert.equal(Object.isFrozen(requests[0].entities), true);
  assert.ok(requests[0].entities.every(Object.isFrozen));
  assert.equal(document.querySelector<HTMLInputElement>(`input[data-filament-id="${mixed}"]`)?.checked, true);

  document.querySelector<HTMLInputElement>('[data-filament-assignment-kind="inherit"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-filament-assignment-apply]')!.click();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].filamentId, null);
  assert.equal(requests[1].sourceRevision, 8);

  selector.dispose();
});

await test('blocks partial unsupported selection and surfaces rejected guarded commits', async () => {
  const { document, container } = createDom();
  let current = snapshot([undefined, undefined], true);
  let listener: (() => void) | undefined;
  let unsubscribed = false;
  const errors: unknown[] = [];
  const adapter: FilamentAssignmentSelectorAdapter = {
    getSnapshot: () => current,
    subscribe: (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
    onApply: async () => {
      throw new Error('stale canonical assignment guard');
    },
    onError: (error) => {
      errors.push(error);
    },
  };
  const selector = new FilamentAssignmentSelector(container, adapter);
  selector.mount();
  assert.equal(document.querySelector<HTMLFieldSetElement>('fieldset')?.disabled, true);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /cannot receive/);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-filament-assignment-apply]')?.disabled, true);

  current = snapshot([undefined, undefined], false, 9);
  listener?.();
  document.querySelector<HTMLInputElement>(`input[data-filament-id="${physicalA}"]`)!.click();
  document.querySelector<HTMLButtonElement>('[data-filament-assignment-apply]')!.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.match(document.querySelector('[data-filament-assignment-status]')?.textContent ?? '', /stale canonical/);
  assert.equal(document.querySelector('[data-filament-assignment-status]')?.getAttribute('role'), 'alert');

  selector.dispose();
  assert.equal(unsubscribed, true);
});

console.log(`\nDOM filament assignment selector: ${passed} tests passed.`);
