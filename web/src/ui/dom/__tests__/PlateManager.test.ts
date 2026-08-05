import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId, type PlateId } from '../../../project/domain/ids';
import {
  PLATE_MANAGER_LIMIT,
  PLATE_MANAGER_NAME_LIMIT,
  PlateManager,
  type PlateManagerAdapter,
  type PlateManagerPlate,
  type PlateManagerPrintableRequest,
  type PlateManagerRenameRequest,
  type PlateManagerReorderRequest,
  type PlateManagerSnapshot,
  type PlateManagerTargetRequest,
} from '../PlateManager';

const plateA = entityId<'plate'>('import:plate-manager:a');
const plateB = entityId<'plate'>('import:plate-manager:b');
const plateC = entityId<'plate'>('import:plate-manager:c');
const plateD = entityId<'plate'>('import:plate-manager:d');

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('renders an accessible responsive list and enforces the final-plate and 36-plate guards', async () => {
  const singleDom = createDom();
  const deleteRequests: PlateManagerTargetRequest[] = [];
  const singleAdapter = inertAdapter(snapshot([plate('Only plate', plateA, true)], plateA), {
    onDelete: (request) => {
      deleteRequests.push(request);
    },
  });
  const single = new PlateManager(singleDom.container, singleAdapter);
  single.mount();

  const root = singleDom.document.querySelector<HTMLElement>('[data-plate-manager]')!;
  const list = singleDom.document.querySelector<HTMLOListElement>('[data-plate-manager-list]')!;
  const primary = plateControl<HTMLButtonElement>(singleDom.document, plateA, 'primary');
  const rename = plateControl<HTMLButtonElement>(singleDom.document, plateA, 'rename');
  const deleteButton = plateControl<HTMLButtonElement>(singleDom.document, plateA, 'delete');
  assert.equal(root.getAttribute('aria-labelledby'), singleDom.document.querySelector('h2')?.id);
  assert.equal(list.getAttribute('aria-label'), 'Project plates');
  assert.equal(primary.getAttribute('aria-pressed'), 'true');
  assert.equal(primary.getAttribute('aria-current'), 'true');
  assert.equal(primary.tabIndex, 0);
  assert.equal(deleteButton.disabled, true);
  assert.match(deleteButton.title, /final plate/i);
  assert.match(rename.style.cssText, /min-height:\s*44px/i);
  assert.match(rename.style.cssText, /min-width:\s*44px/i);
  assert.match(list.parentElement?.querySelector('li')?.style.cssText ?? '', /flex-wrap:\s*wrap/i);
  assert.match(singleDom.container.textContent ?? '', /1 of 36 plates.*final plate cannot be deleted/i);
  assert.doesNotMatch(singleDom.container.textContent ?? '', /locked|bed type|slice ready/i);

  primary.focus();
  key(singleDom.dom, primary, 'Delete');
  await flush();
  assert.equal(deleteRequests.length, 0);
  assert.match(singleDom.document.querySelector('[role="alert"]')?.textContent ?? '', /final plate/i);
  single.dispose();
  assert.equal(singleDom.container.childElementCount, 0);

  const limitDom = createDom();
  const limitPlates = Array.from({ length: PLATE_MANAGER_LIMIT }, (_, index) =>
    plate(`Plate ${index + 1}`, entityId<'plate'>(`import:plate-manager:limit-${index}`), true),
  );
  let duplicateCount = 0;
  const atLimit = new PlateManager(
    limitDom.container,
    inertAdapter(snapshot(limitPlates, limitPlates[17].id), {
      onDuplicate: () => {
        duplicateCount += 1;
      },
    }),
  );
  atLimit.mount();

  assert.equal(limitDom.document.querySelectorAll('[data-plate-manager-plate]').length, PLATE_MANAGER_LIMIT);
  assert.match(limitDom.container.textContent ?? '', /36 of 36 plates.*limit reached/i);
  const duplicateButtons = [
    ...limitDom.document.querySelectorAll<HTMLButtonElement>('[data-plate-control="duplicate"]'),
  ];
  assert.equal(duplicateButtons.length, PLATE_MANAGER_LIMIT);
  assert.ok(duplicateButtons.every((button) => button.disabled && /36-plate limit/i.test(button.title)));
  duplicateButtons[0].click();
  await flush();
  assert.equal(duplicateCount, 0);
  assert.equal(
    [...limitDom.document.querySelectorAll<HTMLButtonElement>('[data-plate-control="primary"]')].filter(
      (button) => button.tabIndex === 0,
    ).length,
    1,
  );
  atLimit.dispose();
});

await test('activates from stable IDs and preserves roving focus through external reorder and rename', async () => {
  const { dom, document, container } = createDom();
  let current = snapshot(
    [plate('Alpha', plateA, true), plate('Bravo', plateB, false), plate('Charlie', plateC, true)],
    plateA,
    10,
  );
  let listener: (() => void) | undefined;
  const activationRequests: PlateManagerTargetRequest[] = [];
  const adapter = inertAdapter(current, {
    getSnapshot: () => current,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    onActivate: (request) => {
      activationRequests.push(request);
      current = snapshot(current.plates, request.plateId, current.sourceRevision + 1);
      listener?.();
    },
  });
  const manager = new PlateManager(container, adapter);
  manager.mount();

  const alpha = plateControl<HTMLButtonElement>(document, plateA, 'primary');
  alpha.focus();
  key(dom, alpha, 'ArrowDown');
  assert.equal(focusedPlateId(document), plateB);
  assert.equal(activationRequests.length, 0, 'roving focus must not change the active plate');

  plateControl<HTMLButtonElement>(document, plateB, 'primary').click();
  await flush();
  assert.deepEqual(activationRequests, [{ plateId: plateB, sourceRevision: 10 }]);
  assert.ok(Object.isFrozen(activationRequests[0]));
  assert.equal(plateControl<HTMLButtonElement>(document, plateB, 'primary').getAttribute('aria-pressed'), 'true');
  assert.equal(focusedPlateId(document), plateB);

  current = snapshot(
    [plate('Charlie', plateC, true), plate('Bravo renamed elsewhere', plateB, false), plate('Alpha', plateA, true)],
    plateB,
    12,
  );
  listener?.();
  assert.deepEqual(
    [...document.querySelectorAll<HTMLElement>('[data-plate-manager-plate]')].map(
      (row) => row.dataset.plateManagerPlate,
    ),
    [plateC, plateB, plateA],
  );
  assert.equal(focusedPlateId(document), plateB);
  assert.match(plateControl(document, plateB, 'primary').textContent ?? '', /Bravo renamed elsewhere/);

  key(dom, plateControl(document, plateB, 'primary'), 'Home');
  assert.equal(focusedPlateId(document), plateC);
  key(dom, plateControl(document, plateC, 'primary'), 'End');
  assert.equal(focusedPlateId(document), plateA);
  manager.dispose();
  assert.equal(listener, undefined);
});

await test('emits a frozen exact permutation for keyboard and touch-sized reorder controls without mutating input', async () => {
  const { dom, document, container } = createDom();
  const original = snapshot(
    [plate('Alpha', plateA, true), plate('Bravo', plateB, true), plate('Charlie', plateC, true)],
    plateA,
    21,
  );
  let current = original;
  let listener: (() => void) | undefined;
  const requests: PlateManagerReorderRequest[] = [];
  const adapter = inertAdapter(original, {
    getSnapshot: () => current,
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
    onReorder: (request) => {
      requests.push(request);
      const byId = new Map(current.plates.map((entry) => [entry.id, entry]));
      current = snapshot(
        request.orderedPlateIds.map((id) => byId.get(id)!),
        current.activePlateId,
        current.sourceRevision + 1,
      );
      listener?.();
    },
  });
  const manager = new PlateManager(container, adapter);
  manager.mount();

  const bravo = plateControl<HTMLButtonElement>(document, plateB, 'primary');
  bravo.focus();
  key(dom, bravo, 'ArrowDown', { ctrlKey: true });
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { orderedPlateIds: [plateA, plateC, plateB], sourceRevision: 21 });
  assert.ok(Object.isFrozen(requests[0]));
  assert.ok(Object.isFrozen(requests[0].orderedPlateIds));
  assert.deepEqual(
    original.plates.map((entry) => entry.id),
    [plateA, plateB, plateC],
  );
  assert.equal(focusedPlateId(document), plateB);
  assert.equal(plateControl<HTMLButtonElement>(document, plateB, 'move-later').disabled, true);

  const moveEarlier = plateControl<HTMLButtonElement>(document, plateB, 'move-earlier');
  assert.match(moveEarlier.style.cssText, /min-height:\s*44px/i);
  moveEarlier.click();
  await flush();
  assert.deepEqual(requests[1], { orderedPlateIds: [plateA, plateB, plateC], sourceRevision: 22 });
  assert.equal(focusedPlateId(document), plateB);
  manager.dispose();
});

await test('renames inline with validation, immutable revision guards, keyboard cancel, and no prompt flow', async () => {
  const { dom, document, container } = createDom();
  dom.window.prompt = () => {
    throw new Error('PlateManager must not use prompt');
  };
  let current = snapshot([plate('Alpha', plateA, true), plate('Bravo', plateB, true)], plateA, 30);
  let listener: (() => void) | undefined;
  const requests: PlateManagerRenameRequest[] = [];
  const adapter = inertAdapter(current, {
    getSnapshot: () => current,
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
    onRename: (request) => {
      requests.push(request);
      current = snapshot(
        current.plates.map((entry) =>
          entry.id === request.plateId ? plate(request.nextName, entry.id, entry.printable) : entry,
        ),
        current.activePlateId,
        current.sourceRevision + 1,
      );
      listener?.();
    },
  });
  const manager = new PlateManager(container, adapter);
  manager.mount();

  plateControl<HTMLButtonElement>(document, plateB, 'rename').click();
  let input = plateControl<HTMLInputElement>(document, plateB, 'rename-input');
  assert.equal(document.activeElement, input);
  input.value = '   ';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.closest('form')?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(requests.length, 0);
  assert.match(document.querySelector('[data-plate-rename-error]')?.textContent ?? '', /cannot be empty/i);
  assert.equal(document.activeElement, plateControl(document, plateB, 'rename-input'));

  input = plateControl<HTMLInputElement>(document, plateB, 'rename-input');
  input.value = 'x'.repeat(PLATE_MANAGER_NAME_LIMIT + 1);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.closest('form')?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.match(document.querySelector('[data-plate-rename-error]')?.textContent ?? '', /cannot exceed 120/i);
  assert.equal(requests.length, 0);

  input = plateControl<HTMLInputElement>(document, plateB, 'rename-input');
  input.value = '  Second plate  ';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.closest('form')?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(requests, [
    {
      plateId: plateB,
      previousName: 'Bravo',
      nextName: 'Second plate',
      sourceRevision: 30,
    },
  ]);
  assert.ok(Object.isFrozen(requests[0]));
  assert.match(plateControl(document, plateB, 'primary').textContent ?? '', /Second plate/);
  assert.equal(focusedPlateId(document), plateB);

  const primary = plateControl<HTMLButtonElement>(document, plateB, 'primary');
  key(dom, primary, 'F2');
  assert.equal(document.activeElement, plateControl(document, plateB, 'rename-input'));
  key(dom, plateControl(document, plateB, 'rename-input'), 'Escape');
  assert.equal(document.querySelector(`[data-plate-rename-form="${plateB}"]`), null);
  assert.equal(focusedPlateId(document), plateB);
  assert.equal(requests.length, 1);
  manager.dispose();
});

await test('routes duplicate and delete by stable ID while retaining focus by surviving IDs', async () => {
  const { document, container } = createDom();
  let current = snapshot([plate('Alpha', plateA, true), plate('Bravo', plateB, true)], plateA, 40);
  let listener: (() => void) | undefined;
  const duplicateRequests: PlateManagerTargetRequest[] = [];
  const deleteRequests: PlateManagerTargetRequest[] = [];
  const adapter = inertAdapter(current, {
    getSnapshot: () => current,
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
    onDuplicate: (request) => {
      duplicateRequests.push(request);
      current = snapshot(
        [...current.plates, plate('Bravo copy', plateD, true)],
        current.activePlateId,
        current.sourceRevision + 1,
      );
      listener?.();
    },
    onDelete: (request) => {
      deleteRequests.push(request);
      const remaining = current.plates.filter((entry) => entry.id !== request.plateId);
      const active = request.plateId === current.activePlateId ? remaining[0].id : current.activePlateId;
      current = snapshot(remaining, active, current.sourceRevision + 1);
      listener?.();
    },
  });
  const manager = new PlateManager(container, adapter);
  manager.mount();

  plateControl<HTMLButtonElement>(document, plateB, 'duplicate').focus();
  plateControl<HTMLButtonElement>(document, plateB, 'duplicate').click();
  await flush();
  assert.deepEqual(duplicateRequests, [{ plateId: plateB, sourceRevision: 40 }]);
  assert.ok(Object.isFrozen(duplicateRequests[0]));
  assert.deepEqual(
    [...document.querySelectorAll<HTMLElement>('[data-plate-manager-plate]')].map(
      (row) => row.dataset.plateManagerPlate,
    ),
    [plateA, plateB, plateD],
  );
  assert.equal(focusedPlateId(document), plateB);

  plateControl<HTMLButtonElement>(document, plateB, 'delete').click();
  await flush();
  assert.deepEqual(deleteRequests, [{ plateId: plateB, sourceRevision: 41 }]);
  assert.deepEqual(
    [...document.querySelectorAll<HTMLElement>('[data-plate-manager-plate]')].map(
      (row) => row.dataset.plateManagerPlate,
    ),
    [plateA, plateD],
  );
  assert.equal(focusedPlateId(document), plateD);
  manager.dispose();
});

await test('surfaces asynchronous printable failures, reports the original error, and restores controls and focus', async () => {
  const { document, container } = createDom();
  const current = snapshot([plate('Alpha', plateA, false), plate('Bravo', plateB, true)], plateB, 50);
  const deferred = promiseWithResolvers<void>();
  const requests: PlateManagerPrintableRequest[] = [];
  const reported: unknown[] = [];
  const adapter = inertAdapter(current, {
    onPrintableChange: (request) => {
      requests.push(request);
      return deferred.promise;
    },
    onError: (error) => reported.push(error),
  });
  const manager = new PlateManager(container, adapter);
  manager.mount();

  const checkbox = plateControl<HTMLInputElement>(document, plateA, 'printable');
  checkbox.focus();
  checkbox.click();
  assert.deepEqual(requests, [{ plateId: plateA, printable: true, sourceRevision: 50 }]);
  assert.ok(Object.isFrozen(requests[0]));
  assert.equal(document.querySelector('[data-plate-manager]')?.getAttribute('aria-busy'), 'true');
  assert.match(document.querySelector('[data-plate-manager-status]')?.textContent ?? '', /updating plate inclusion/i);
  assert.ok(
    [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(
      (control) => control.disabled,
    ),
  );

  const failure = new Error('<unsafe> network failure');
  deferred.reject(failure);
  await flush();
  assert.deepEqual(reported, [failure]);
  const alert = document.querySelector<HTMLElement>('[data-plate-manager-error]')!;
  assert.match(alert.textContent, /Could not update plate inclusion: <unsafe> network failure/);
  assert.equal(alert.querySelector('unsafe'), null, 'errors must be rendered as text, not markup');
  assert.equal(document.querySelector('[data-plate-manager]')?.getAttribute('aria-busy'), 'false');
  const restored = plateControl<HTMLInputElement>(document, plateA, 'printable');
  assert.equal(restored.disabled, false);
  assert.equal(restored.checked, false, 'failed mutation must continue to reflect the immutable adapter snapshot');
  assert.equal(document.activeElement, restored);
  manager.dispose();
});

await test('fails closed and reports malformed, unstable, duplicate, empty, and over-limit snapshots', () => {
  const malformed: readonly { label: string; value: PlateManagerSnapshot }[] = [
    {
      label: 'unstable ID',
      value: {
        sourceRevision: 1,
        activePlateId: 'plain-id' as PlateId,
        plates: [{ id: 'plain-id' as PlateId, name: 'Plain', printable: true }],
      },
    },
    {
      label: 'duplicate ID',
      value: {
        sourceRevision: 1,
        activePlateId: plateA,
        plates: [plate('One', plateA, true), plate('Two', plateA, false)],
      },
    },
    {
      label: 'missing active ID',
      value: snapshot([plate('One', plateA, true)], plateB),
    },
    {
      label: 'empty list',
      value: { sourceRevision: 1, activePlateId: plateA, plates: [] },
    },
    {
      label: 'over limit',
      value: {
        sourceRevision: 1,
        activePlateId: plateA,
        plates: [
          plate('First', plateA, true),
          ...Array.from({ length: PLATE_MANAGER_LIMIT }, (_, index) =>
            plate(`Extra ${index}`, entityId<'plate'>(`import:plate-manager:overflow-${index}`), true),
          ),
        ],
      },
    },
  ];

  for (const candidate of malformed) {
    const { document, container } = createDom();
    const reported: unknown[] = [];
    const manager = new PlateManager(
      container,
      inertAdapter(candidate.value, { onError: (error) => reported.push(error) }),
    );
    manager.mount();
    assert.equal(document.querySelector('[data-plate-manager-list]'), null, candidate.label);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Plate data is unavailable:/);
    assert.equal(reported.length, 1, candidate.label);
    manager.dispose();
  }
});

function plate(name: string, id: PlateId, printable: boolean): PlateManagerPlate {
  return Object.freeze({ id, name, printable });
}

function snapshot(
  plates: readonly PlateManagerPlate[],
  activePlateId: PlateId,
  sourceRevision = 1,
): PlateManagerSnapshot {
  return Object.freeze({
    sourceRevision,
    activePlateId,
    plates: Object.freeze([...plates]),
  });
}

function inertAdapter(
  initial: PlateManagerSnapshot,
  overrides: Partial<PlateManagerAdapter> = {},
): PlateManagerAdapter {
  return {
    getSnapshot: () => initial,
    onActivate: () => undefined,
    onRename: () => undefined,
    onDuplicate: () => undefined,
    onDelete: () => undefined,
    onReorder: () => undefined,
    onPrintableChange: () => undefined,
    ...overrides,
  };
}

function createDom() {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  return { dom, document, container: document.querySelector<HTMLElement>('#host')! };
}

function plateControl<T extends HTMLElement>(document: Document, plateId: PlateId, control: string): T {
  const result = [...document.querySelectorAll<HTMLElement>('[data-plate-control][data-plate-id]')].find(
    (element) => element.dataset.plateId === plateId && element.dataset.plateControl === control,
  );
  assert.ok(result, `Expected ${control} control for ${plateId}`);
  return result as T;
}

function focusedPlateId(document: Document): string | undefined {
  return (document.activeElement as HTMLElement | null)?.dataset.plateId;
}

function key(
  dom: JSDOM,
  target: HTMLElement,
  keyValue: string,
  modifiers: Readonly<{ ctrlKey?: boolean; metaKey?: boolean }> = {},
): void {
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: keyValue,
      ctrlKey: modifiers.ctrlKey ?? false,
      metaKey: modifiers.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function promiseWithResolvers<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

console.log(`\nDOM plate manager: ${passed} tests passed.`);
