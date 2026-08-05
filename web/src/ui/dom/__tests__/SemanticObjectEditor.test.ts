import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId } from '../../../project/domain/ids';
import type { VolumeRole } from '../../../project/domain/model';
import {
  SemanticObjectEditor,
  type AddSemanticLayerRangeRequest,
  type ConvertSemanticVolumeRoleRequest,
  type DeleteSemanticLayerRangeRequest,
  type EditSemanticLayerRangeRequest,
  type MergeSemanticLayerRangesRequest,
  type SemanticObjectEditorAdapter,
  type SemanticObjectEditorSnapshot,
  type SemanticSelectedVolumeSnapshot,
  type SemanticVolumeRoleDecisionSnapshot,
  type SplitSemanticLayerRangeRequest,
} from '../SemanticObjectEditor';

const objectId = entityId<'object'>('import:semantic-ui:object');
const volumeId = entityId<'volume'>('import:semantic-ui:volume');
const rangeA = entityId<'layer-range'>('import:semantic-ui:range-a');
const rangeB = entityId<'layer-range'>('import:semantic-ui:range-b');
const rangeC = entityId<'layer-range'>('import:semantic-ui:range-c');
const newRangeA = entityId<'layer-range'>('import:semantic-ui:new-range-a');
const newRangeB = entityId<'layer-range'>('import:semantic-ui:new-range-b');

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('renders accessible role decisions and changes only after the guarded adapter resolves', async () => {
  const harness = createDocument();
  const conversion = deferred<void>();
  const requests: ConvertSemanticVolumeRoleRequest[] = [];
  let listener: (() => void) | undefined;
  let unsubscribed = false;
  let current = snapshot();
  const adapter = createAdapter(() => current, {
    subscribe: (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
    onConvertVolumeRole: (request) => {
      requests.push(request);
      return conversion.promise.then(() => {
        current = snapshot({
          revision: 12,
          selectedVolume: selectedVolume('support-enforcer'),
        });
      });
    },
  });
  const editor = new SemanticObjectEditor(harness.container, adapter, { heading: 'Part semantics' });
  editor.mount();

  const root = harness.document.querySelector<HTMLElement>('[data-semantic-object-editor]')!;
  assert.ok(root.getAttribute('aria-labelledby'));
  assert.equal(harness.document.querySelector('h2')?.textContent, 'Part semantics');
  assert.equal(
    harness.document.querySelector('[data-semantic-object-context]')?.getAttribute('data-object-id'),
    objectId,
  );
  assert.deepEqual(
    [...harness.document.querySelectorAll<HTMLButtonElement>('[data-volume-role]')].map(
      (button) => button.dataset.volumeRole,
    ),
    ['model', 'negative-volume', 'parameter-modifier', 'support-blocker', 'support-enforcer'],
  );
  assert.match(
    harness.document.querySelector('[data-role-block-reason="negative-volume"]')?.textContent ?? '',
    /facet paint/i,
  );
  assert.match(
    harness.document.querySelector('[data-role-block-reason="support-blocker"]')?.textContent ?? '',
    /filament assignment/i,
  );
  assert.equal(roleButton(harness, 'negative-volume').disabled, true);
  assert.equal(roleButton(harness, 'parameter-modifier').getAttribute('aria-pressed'), 'true');
  assert.equal(roleButton(harness, 'parameter-modifier').disabled, true);
  assert.equal(roleButton(harness, 'support-enforcer').style.minBlockSize, '44px');
  assert.equal(roleButton(harness, 'support-enforcer').style.touchAction, 'manipulation');
  assert.equal(root.querySelector('[data-volume-id]')?.getAttribute('data-volume-id'), volumeId);

  roleButton(harness, 'support-enforcer').click();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    expectedRevision: 11,
    sourceHash: 'hash-11',
    objectId,
    volumeId,
    nextRole: 'support-enforcer',
  });
  assert.equal(Object.isFrozen(requests[0]), true);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(roleButton(harness, 'parameter-modifier').getAttribute('aria-pressed'), 'true');
  assert.equal(roleButton(harness, 'support-enforcer').getAttribute('aria-pressed'), 'false');

  conversion.resolve();
  await settle();
  assert.equal(roleButton(harness, 'support-enforcer').getAttribute('aria-pressed'), 'true');
  assert.equal(
    harness.document.querySelector('[data-semantic-editor-status]')?.getAttribute('data-semantic-editor-status'),
    'success',
  );

  listener?.();
  assert.equal(roleButton(harness, 'support-enforcer').getAttribute('aria-pressed'), 'true');
  editor.dispose();
  assert.equal(unsubscribed, true);
  assert.equal(harness.container.childElementCount, 0);
});

await test('submits stable-ID guarded add, edit, split, merge, and delete requests through native controls', async () => {
  const harness = createDocument();
  const added: AddSemanticLayerRangeRequest[] = [];
  const edited: EditSemanticLayerRangeRequest[] = [];
  const split: SplitSemanticLayerRangeRequest[] = [];
  const merged: MergeSemanticLayerRangesRequest[] = [];
  const deleted: DeleteSemanticLayerRangeRequest[] = [];
  const allocated = [newRangeA, newRangeB];
  const adapter = createAdapter(() => snapshot(), {
    createLayerRangeId: () => {
      const next = allocated.shift();
      if (!next) throw new Error('unexpected allocation');
      return next;
    },
    onAddLayerRange: (request) => {
      added.push(request);
    },
    onEditLayerRange: (request) => {
      edited.push(request);
    },
    onSplitLayerRange: (request) => {
      split.push(request);
    },
    onMergeLayerRanges: (request) => {
      merged.push(request);
    },
    onDeleteLayerRange: (request) => {
      deleted.push(request);
    },
  });
  const editor = new SemanticObjectEditor(harness.container, adapter);
  editor.mount();

  assert.deepEqual(
    [...harness.document.querySelectorAll<HTMLElement>('[data-layer-range-id]')].map(
      (item) => item.dataset.layerRangeId,
    ),
    [rangeA, rangeB, rangeC],
  );
  assert.equal(
    harness.document.querySelector(`[data-layer-range-id="${rangeB}"]`)?.getAttribute('aria-current'),
    'true',
  );

  setInput(harness, '[data-layer-range-input="add-min"]', '18');
  setInput(harness, '[data-layer-range-input="add-max"]', '22');
  form(harness, 'add').requestSubmit();
  await settle();
  assert.deepEqual(added[0], {
    expectedRevision: 11,
    sourceHash: 'hash-11',
    objectId,
    layerRangeId: newRangeA,
    minZMm: 18,
    maxZMm: 22,
  });

  setInput(harness, '[data-layer-range-input="edit-min"]', '5');
  setInput(harness, '[data-layer-range-input="edit-max"]', '12');
  form(harness, 'edit').requestSubmit();
  await settle();
  assert.deepEqual(edited[0], {
    expectedRevision: 11,
    sourceHash: 'hash-11',
    objectId,
    layerRangeId: rangeB,
    minZMm: 5,
    maxZMm: 12,
  });

  setInput(harness, '[data-layer-range-input="split-z"]', '7.5');
  form(harness, 'split').requestSubmit();
  await settle();
  assert.deepEqual(split[0], {
    expectedRevision: 11,
    sourceHash: 'hash-11',
    objectId,
    layerRangeId: rangeB,
    splitZMm: 7.5,
    upperRangeId: newRangeB,
  });

  const previousMerge = harness.document.querySelector<HTMLButtonElement>('[data-layer-range-merge="previous"]')!;
  assert.equal(previousMerge.disabled, false);
  assert.equal(previousMerge.dataset.otherRangeId, rangeA);
  previousMerge.click();
  await settle();
  assert.deepEqual(merged[0], {
    expectedRevision: 11,
    sourceHash: 'hash-11',
    objectId,
    firstRangeId: rangeB,
    secondRangeId: rangeA,
  });
  const nextMerge = harness.document.querySelector<HTMLButtonElement>('[data-layer-range-merge="next"]')!;
  assert.equal(nextMerge.disabled, true);
  assert.match(
    harness.document.querySelector('[data-merge-block-reason="next"]')?.textContent ?? '',
    /different settings/i,
  );

  harness.document.querySelector<HTMLButtonElement>('[data-layer-range-delete]')!.click();
  await settle();
  assert.deepEqual(deleted[0], {
    expectedRevision: 11,
    sourceHash: 'hash-11',
    objectId,
    layerRangeId: rangeB,
  });
  for (const request of [...added, ...edited, ...split, ...merged, ...deleted]) {
    assert.equal(Object.isFrozen(request), true);
    assert.ok(!('index' in request));
  }
  editor.dispose();
});

await test('blocks overlap, boundary, and inconsistent merges and surfaces async rejection without optimistic mutation', async () => {
  const harness = createDocument();
  const errors: unknown[] = [];
  const conversions: ConvertSemanticVolumeRoleRequest[] = [];
  const rejection = deferred<void>();
  const inconsistent = snapshot({
    selectedRangeNext: { allowed: true, otherRangeId: rangeC },
  });
  const adapter = createAdapter(() => inconsistent, {
    onConvertVolumeRole: (request) => {
      conversions.push(request);
      return rejection.promise;
    },
    onError: (error) => errors.push(error),
  });
  const editor = new SemanticObjectEditor(harness.container, adapter);
  editor.mount();

  setInput(harness, '[data-layer-range-input="add-min"]', '4');
  setInput(harness, '[data-layer-range-input="add-max"]', '6');
  assert.equal(harness.document.querySelector<HTMLButtonElement>('[data-layer-range-submit="add"]')?.disabled, true);
  assert.match(
    harness.document.querySelector('[data-layer-range-validation="add"]')?.textContent ?? '',
    /overlaps existing/i,
  );
  form(harness, 'add').requestSubmit();

  setInput(harness, '[data-layer-range-input="edit-min"]', '4');
  setInput(harness, '[data-layer-range-input="edit-max"]', '9');
  assert.equal(harness.document.querySelector<HTMLButtonElement>('[data-layer-range-submit="edit"]')?.disabled, true);
  assert.equal(input(harness, '[data-layer-range-input="edit-min"]').getAttribute('aria-invalid'), 'true');

  setInput(harness, '[data-layer-range-input="split-z"]', '5');
  assert.equal(harness.document.querySelector<HTMLButtonElement>('[data-layer-range-submit="split"]')?.disabled, true);
  assert.match(
    harness.document.querySelector('[data-layer-range-validation="split"]')?.textContent ?? '',
    /strictly inside/i,
  );

  const inconsistentMerge = harness.document.querySelector<HTMLButtonElement>('[data-layer-range-merge="next"]')!;
  assert.equal(inconsistentMerge.disabled, true);
  assert.match(
    harness.document.querySelector('[data-merge-block-reason="next"]')?.textContent ?? '',
    /does not touch/i,
  );

  roleButton(harness, 'support-enforcer').click();
  assert.equal(conversions.length, 1);
  assert.equal(roleButton(harness, 'parameter-modifier').getAttribute('aria-pressed'), 'true');
  rejection.reject(new Error('stale semantic revision'));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(roleButton(harness, 'parameter-modifier').getAttribute('aria-pressed'), 'true');
  assert.equal(roleButton(harness, 'support-enforcer').getAttribute('aria-pressed'), 'false');
  const status = harness.document.querySelector<HTMLElement>('[data-semantic-editor-status]')!;
  assert.equal(status.getAttribute('role'), 'alert');
  assert.match(status.textContent ?? '', /not changed optimistically.*stale semantic revision/i);
  assert.equal(harness.document.querySelector('[data-semantic-object-editor]')?.getAttribute('aria-busy'), 'false');
  assert.equal(roleButton(harness, 'support-enforcer').disabled, false);
  editor.dispose();
});

interface SnapshotOverrides {
  readonly revision?: number;
  readonly selectedVolume?: SemanticSelectedVolumeSnapshot;
  readonly selectedRangeNext?: SemanticObjectEditorSnapshot['selectedLayerRange'] extends infer T
    ? T extends { mergeNext: infer M }
      ? M
      : never
    : never;
}

function snapshot(overrides: SnapshotOverrides = {}): SemanticObjectEditorSnapshot {
  const layerRanges = Object.freeze([
    Object.freeze({ id: rangeA, minZMm: 0, maxZMm: 5 }),
    Object.freeze({ id: rangeB, minZMm: 5, maxZMm: 10 }),
    Object.freeze({ id: rangeC, minZMm: 12, maxZMm: 18 }),
  ]);
  const selectedLayerRange = Object.freeze({
    id: rangeB,
    mergePrevious: Object.freeze({ allowed: true as const, otherRangeId: rangeA }),
    mergeNext:
      overrides.selectedRangeNext ??
      Object.freeze({
        allowed: false as const,
        otherRangeId: rangeC,
        reason: 'Layer ranges with different settings cannot be merged without an explicit conflict choice.',
      }),
  });
  return Object.freeze({
    sourceRevision: overrides.revision ?? 11,
    sourceHash: `hash-${overrides.revision ?? 11}`,
    objectId,
    objectName: 'Housing',
    selectedVolume: overrides.selectedVolume ?? selectedVolume('parameter-modifier'),
    layerRanges,
    selectedLayerRange,
  });
}

function selectedVolume(role: VolumeRole): SemanticSelectedVolumeSnapshot {
  const roleDecisions: SemanticVolumeRoleDecisionSnapshot[] = [
    { role: 'model', decision: { allowed: true, noop: role === 'model' } },
    {
      role: 'negative-volume',
      decision: {
        allowed: false,
        code: 'facet-annotations',
        reason: 'Clear facet paint annotations before converting this model part to a non-model role.',
      },
    },
    {
      role: 'parameter-modifier',
      decision: { allowed: true, noop: role === 'parameter-modifier' },
    },
    {
      role: 'support-blocker',
      decision: {
        allowed: false,
        code: 'filament-assignment',
        reason: 'Clear the local filament assignment before converting this volume to support-blocker.',
      },
    },
    {
      role: 'support-enforcer',
      decision: { allowed: true, noop: role === 'support-enforcer' },
    },
  ];
  return Object.freeze({
    id: volumeId,
    name: 'Cutout helper',
    role,
    roleDecisions: Object.freeze(roleDecisions.map((entry) => Object.freeze(entry))),
  });
}

function createAdapter(
  getSnapshot: () => SemanticObjectEditorSnapshot,
  overrides: Partial<SemanticObjectEditorAdapter> = {},
): SemanticObjectEditorAdapter {
  return {
    getSnapshot,
    createLayerRangeId: () => newRangeA,
    onConvertVolumeRole: () => undefined,
    onAddLayerRange: () => undefined,
    onEditLayerRange: () => undefined,
    onSplitLayerRange: () => undefined,
    onMergeLayerRanges: () => undefined,
    onDeleteLayerRange: () => undefined,
    ...overrides,
  };
}

interface DocumentHarness {
  readonly dom: any;
  readonly document: Document;
  readonly container: HTMLElement;
}

function createDocument(): DocumentHarness {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  return { dom, document, container: document.querySelector<HTMLElement>('#host')! };
}

function roleButton(harness: DocumentHarness, role: VolumeRole): HTMLButtonElement {
  return harness.document.querySelector<HTMLButtonElement>(`[data-volume-role="${role}"]`)!;
}

function form(harness: DocumentHarness, operation: 'add' | 'edit' | 'split'): HTMLFormElement {
  return harness.document.querySelector<HTMLFormElement>(`form[data-layer-range-operation="${operation}"]`)!;
}

function input(harness: DocumentHarness, selector: string): HTMLInputElement {
  return harness.document.querySelector<HTMLInputElement>(selector)!;
}

function setInput(harness: DocumentHarness, selector: string, value: string): void {
  const field = input(harness, selector);
  field.value = value;
  field.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value?: T) => resolve(value as T),
    reject,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

console.log(`\nDOM semantic object editor: ${passed} tests passed.`);
