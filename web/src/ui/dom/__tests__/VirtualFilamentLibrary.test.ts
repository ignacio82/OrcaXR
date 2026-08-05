import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import {
  normalizeRatioTriangleBarycentricWeights,
  requireMixedFilamentAuthoring,
} from '../../../project/filaments/mixedFilamentAuthoring';
import { SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE } from '../../../project/filaments/colorMatchSearch';
import {
  VIRTUAL_FILAMENT_MATCH_COVERAGE,
  VirtualFilamentLibrary,
  type AddVirtualFilamentRequest,
  type DeleteVirtualFilamentRequest,
  type DuplicateVirtualFilamentRequest,
  type EditVirtualFilamentRequest,
  type SetVirtualFilamentEnabledRequest,
  type VirtualFilamentLibraryAdapter,
  type VirtualFilamentLibrarySnapshot,
  type VirtualFilamentMatchCandidate,
  type VirtualFilamentMatchSearchRequest,
  type VirtualFilamentRatioDraft,
} from '../VirtualFilamentLibrary';

const physicalA = 'physical:stable-a';
const physicalB = 'physical:stable-b';
const physicalC = 'physical:stable-c';
const physicalD = 'physical:stable-d';
const mixedOcean = 'mixed:stable-ocean';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('renders physical and virtual libraries with non-color labels, touch targets, and modal cancel/focus', async () => {
  const { dom, document, container } = createDom();
  const source = snapshot();
  const calls = mutationCalls();
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => source, calls),
  );
  library.mount();

  const root = document.querySelector<HTMLElement>('[data-virtual-filament-library]')!;
  assert.equal(root.getAttribute('aria-labelledby'), document.querySelector('h2')?.id);
  assert.equal(document.querySelectorAll('[data-virtual-physical-id]').length, 4);
  assert.match(
    document.querySelector(`[data-virtual-physical-id="${physicalA}"]`)?.textContent ?? '',
    /H1.*Crimson PLA.*PLA.*#FF0000.*Available/i,
  );
  assert.match(
    document.querySelector(`[data-virtual-physical-id="${physicalD}"]`)?.textContent ?? '',
    /Disabled.*abrasive profile is unavailable/i,
  );
  assert.match(
    document.querySelector(`[data-virtual-filament-row="${mixedOcean}"]`)?.textContent ?? '',
    /Ocean mix.*Ratio.*Enabled.*B 50%/i,
  );
  const edit = rowAction<HTMLButtonElement>(document, mixedOcean, 'edit');
  assert.match(edit.style.cssText, /min-width:\s*44px/i);
  assert.match(edit.style.cssText, /min-height:\s*44px/i);

  const add = document.querySelector<HTMLButtonElement>('[data-virtual-filament-add]')!;
  add.focus();
  add.click();
  await flush();
  const dialog = document.querySelector<HTMLElement>('[data-virtual-filament-dialog="author"]')!;
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(document.activeElement, field(document, 'name'));
  const cancel = dialog.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-cancel"]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')!;
  assert.match(cancel.style.cssText, /min-height:\s*44px/i);
  submit.focus();
  key(dom, submit, 'Tab');
  assert.equal(document.activeElement, field(document, 'name'), 'Tab must wrap inside the modal');

  key(dom, dialog, 'Escape');
  await flush();
  assert.equal(document.querySelector('[data-virtual-filament-dialog]'), null);
  assert.equal(document.activeElement, add);
  assert.equal(totalMutationCalls(calls), 0, 'Cancel must not notify any mutation adapter');
  library.dispose();
  assert.equal(container.childElementCount, 0);
});

await test('authors exact two- and three-component Ratio drafts without mutating or hiding normalization', async () => {
  const { dom, document, container } = createDom();
  const source = snapshot();
  const before = JSON.stringify(source);
  const calls = mutationCalls();
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => source, calls),
  );
  library.mount();

  openAdd(document);
  setText(document, 'name', 'Triad');
  assert.match(
    document.querySelector('[data-virtual-ratio-pigment-preview]')?.textContent ?? '',
    /predicted mix #6F006E.*two-filament pigment model.*saved badge remains #808080/i,
  );
  changeRadio(document, '[data-virtual-ratio-count="3"]');
  assert.match(
    document.querySelector('[data-virtual-ratio-pigment-preview]')?.textContent ?? '',
    /predicted mix #AB54A8.*triangle weighted-sRGB preview/i,
  );
  const trianglePicker = document.querySelector<SVGSVGElement>('[data-virtual-ratio-triangle]')!;
  assert.ok(trianglePicker);
  assert.equal(trianglePicker.getAttribute('role'), 'slider');
  assert.ok(trianglePicker.querySelector('[data-virtual-ratio-triangle-marker]'));
  trianglePicker.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 240,
      bottom: 216,
      width: 240,
      height: 216,
      toJSON: () => undefined,
    }) as DOMRect;
  pointer(dom, trianglePicker, 'pointerdown', {
    pointerId: 7,
    clientX: -2.4,
    clientY: -18,
  });
  const pinnedPointerWeights = normalizeRatioTriangleBarycentricWeights([1.2, 0.5, -0.7]).map((weight) =>
    Number((weight * 100).toFixed(2)),
  );
  assert.deepEqual(
    [0, 1, 2].map((index) => Number(field<HTMLInputElement>(document, `ratio-weight-${index}`).value)),
    pinnedPointerWeights,
    'off-triangle pointers must retain raw barycentrics through exactly four [0.1, 0.9] clamp/renormalize passes',
  );
  pointer(dom, trianglePicker, 'pointerup', {
    pointerId: 7,
    clientX: -2.4,
    clientY: -18,
  });
  setNumber(document, 'ratio-weight-0', '100');
  setNumber(document, 'ratio-weight-1', '0');
  setNumber(document, 'ratio-weight-2', '0');
  const initialWeights = [0, 1, 2].map((index) => field<HTMLInputElement>(document, `ratio-weight-${index}`).value);
  key(dom, trianglePicker, 'ArrowUp');
  const movedWeights = [0, 1, 2].map((index) =>
    Number(field<HTMLInputElement>(document, `ratio-weight-${index}`).value),
  );
  assert.notDeepEqual(
    movedWeights.map(String),
    initialWeights,
    'keyboard input moves the triangle marker and synchronizes the exact fields',
  );
  assert.ok(Math.abs(movedWeights.reduce((total, value) => total + value, 0) - 100) < 0.02);
  assert.ok(
    movedWeights.every((weight) => weight >= 9.9),
    'vertex/edge keyboard movement must apply the pinned 10% clamp and four-pass renormalization',
  );
  setNumber(document, 'ratio-mix-b', '35');
  setNumber(document, 'ratio-weight-0', '95');
  setNumber(document, 'ratio-weight-1', '5');
  setNumber(document, 'ratio-weight-2', '0');
  setNumber(document, 'component-a-surface-offset', '-2');
  setNumber(document, 'component-b-surface-offset', '2');
  assert.match(
    document.querySelector('[data-virtual-draft-preview]')?.textContent ?? '',
    /exact saved triangle weights/i,
  );
  await submitDialog(document);

  assert.equal(calls.add.length, 1);
  const triangle = calls.add[0];
  assert.deepEqual(
    { expectedRevision: triangle.expectedRevision, sourceHash: triangle.sourceHash },
    { expectedRevision: 41, sourceHash: 'hash-41' },
  );
  assert.equal(triangle.draft.mode, 'ratio');
  if (triangle.draft.mode !== 'ratio') throw new Error('Expected Ratio draft');
  assert.equal(triangle.draft.components.length, 3);
  assert.equal(triangle.draft.componentASurfaceOffsetMm, -2);
  assert.equal(triangle.draft.componentBSurfaceOffsetMm, 2);
  assert.deepEqual(triangle.draft.triangleWeightsPercent, [95, 5, 0], 'the exact valid draft is retained');
  const expectedTriangle = requireMixedFilamentAuthoring(
    {
      mode: 'ratio',
      componentIds: [1, 2, 3],
      mixBPercent: 35,
      triangleWeightsPercent: [95, 5, 0],
    },
    { physicalToolCount: 4 },
  );
  assert.equal(triangle.draft.projection.gradient_component_weights, expectedTriangle.gradient_component_weights);
  assert.ok(Object.isFrozen(triangle));
  assert.ok(Object.isFrozen(triangle.draft));
  assert.ok(Object.isFrozen(triangle.draft.components));
  assert.ok(Object.isFrozen(triangle.draft.triangleWeightsPercent));
  assert.ok(Object.isFrozen(triangle.draft.projection));

  openAdd(document);
  setText(document, 'name', 'Quarter blue');
  setNumber(document, 'component-a-surface-offset', '2.01');
  assert.match(
    document.querySelector('[data-virtual-dialog-errors]')?.textContent ?? '',
    /component A surface offset must be a finite number from -2 to \+2 mm/i,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')?.disabled,
    true,
  );
  setNumber(document, 'component-a-surface-offset', '0');
  setNumber(document, 'ratio-mix-b', '25');
  await submitDialog(document);
  assert.equal(calls.add.length, 2);
  const pair = calls.add[1].draft;
  assert.equal(pair.mode, 'ratio');
  if (pair.mode !== 'ratio') throw new Error('Expected Ratio draft');
  assert.deepEqual([pair.projection.ratio_a, pair.projection.ratio_b], [3, 1]);
  assert.equal(pair.triangleWeightsPercent, undefined);
  assert.equal(JSON.stringify(source), before, 'the supplied snapshot must remain byte-for-byte unchanged');
  library.dispose();
});

await test('locates malformed Cycle text and submits exact quick-token groups and engine normalization', async () => {
  const { document, container } = createDom();
  const source = snapshot();
  const calls = mutationCalls();
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => source, calls),
  );
  library.mount();

  openAdd(document);
  setText(document, 'name', 'Perimeter cadence');
  changeRadio(document, '[data-virtual-mode="cycle"]');
  setText(document, 'cycle-pattern', '1[12');
  const issue = document.querySelector<HTMLButtonElement>('[data-virtual-cycle-issue="1:4"]')!;
  assert.ok(issue);
  assert.match(issue.textContent ?? '', /close.*characters 2–4/i);
  issue.click();
  const pattern = field<HTMLTextAreaElement>(document, 'cycle-pattern');
  assert.deepEqual([pattern.selectionStart, pattern.selectionEnd], [1, 4]);
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')?.disabled,
    true,
  );

  setText(document, 'cycle-pattern', '1');
  assert.match(
    document.querySelector('[data-virtual-draft-preview]')?.textContent ?? '',
    /exact engine pattern: 1.*warning: one distinct head/i,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')?.disabled,
    false,
    'the pinned dialog treats a one-head cycle as a warning, not a hard error',
  );

  setText(document, 'cycle-pattern', '');
  quickTool(document, 1);
  quickTool(document, 2);
  document.querySelector<HTMLButtonElement>('[data-virtual-quick-group]')!.click();
  quickTool(document, 3);
  quickTool(document, 1);
  assert.equal(field<HTMLTextAreaElement>(document, 'cycle-pattern').value, '12,31');
  assert.match(
    document.querySelector('[data-virtual-draft-preview]')?.textContent ?? '',
    /exact engine pattern: 12,31.*group 1.*H1 Crimson PLA.*H2 Ocean PLA.*group 2.*H3 Snow PLA/i,
  );
  await submitDialog(document);

  assert.equal(calls.add.length, 1);
  const request = calls.add[0];
  assert.equal(request.draft.mode, 'cycle');
  if (request.draft.mode !== 'cycle') throw new Error('Expected Cycle draft');
  assert.equal(request.draft.manualPattern, '12,31');
  assert.equal(request.draft.normalizedPattern, '12,31');
  assert.deepEqual(request.draft.groups, [
    [1, 2],
    [3, 1],
  ]);
  assert.deepEqual(request.draft.sequence, [1, 2, 3, 1]);
  assert.deepEqual(
    request.draft.components.map((component) => component.filamentId),
    [physicalA, physicalB, physicalC],
  );
  assert.ok(Object.isFrozen(request.draft.groups[0]));
  library.dispose();
});

await test('truthfully ranks only supplied Match candidates and requires explicit candidate selection', async () => {
  const { document, container } = createDom();
  const source = snapshot();
  const calls = mutationCalls();
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => source, calls),
  );
  library.mount();

  openAdd(document);
  setText(document, 'name', 'Matched purple');
  changeRadio(document, '[data-virtual-mode="match"]');
  const coverage = document.querySelector<HTMLElement>('[data-virtual-match-coverage]')!;
  assert.equal(coverage.dataset.virtualMatchCoverage, VIRTUAL_FILAMENT_MATCH_COVERAGE);
  assert.match(coverage.textContent ?? '', /supplied pigment-rendered candidates only.*not a complete/i);
  setText(document, 'match-target', '#800080');
  setNumber(document, 'match-minimum', '10');
  const ranked = [...document.querySelectorAll<HTMLElement>('[data-virtual-match-candidate]')];
  assert.deepEqual(
    ranked.map((entry) => entry.dataset.virtualMatchCandidate),
    ['candidate-purple', 'candidate-pale-red'],
  );
  assert.match(ranked[0].textContent ?? '', /#1.*predicted #800080.*ΔE2000 0.00/i);
  const submit = document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')!;
  assert.equal(submit.disabled, true, 'a ranking winner is not an implicit selection');

  const selected = document.querySelector<HTMLInputElement>(
    '[data-virtual-match-candidate-choice="candidate-purple"]',
  )!;
  selected.checked = true;
  selected.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')?.disabled,
    false,
  );
  await submitDialog(document);

  assert.equal(calls.add.length, 1);
  const request = calls.add[0];
  assert.equal(request.draft.mode, 'match');
  if (request.draft.mode !== 'match') throw new Error('Expected Match draft');
  assert.equal(request.draft.selectedCandidateId, 'candidate-purple');
  assert.equal(request.draft.normalizedTargetColor, '#800080');
  assert.equal(request.draft.previewColor, '#800080');
  assert.ok(request.draft.deltaE2000 < 1e-9);
  assert.deepEqual(
    request.draft.components.map((component) => [component.filamentId, component.toolId, component.weight]),
    [
      [physicalA, 1, 50],
      [physicalB, 2, 50],
    ],
  );
  assert.ok(Object.isFrozen(request.draft.components));
  library.dispose();
});

await test('uses an exact revision-bound palette search when the adapter supplies one', async () => {
  const { document, container } = createDom();
  const source = snapshot();
  const calls = mutationCalls();
  const searches: VirtualFilamentMatchSearchRequest[] = [];
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => source, calls, {
      searchMatchCandidates: async (request) => {
        searches.push(request);
        return [
          {
            id: 'pinned-match:perfect-green',
            label: 'Pinned pair search',
            components: [
              { filamentId: physicalA, weight: 50 },
              { filamentId: physicalC, weight: 50 },
            ],
            previewColor: '#008000',
          },
        ];
      },
    }),
    { matchSearchDebounceMs: 0 },
  );
  library.mount();

  openAdd(document);
  setText(document, 'name', 'Exact searched green');
  changeRadio(document, '[data-virtual-mode="match"]');
  setText(document, 'match-target', '#008000');
  setNumber(document, 'match-minimum', '10');
  await flush();
  const coverage = document.querySelector<HTMLElement>('[data-virtual-match-coverage]')!;
  assert.equal(coverage.dataset.virtualMatchCoverage, SUPPLIED_PALETTE_MATCH_SEARCH_COVERAGE);
  assert.match(coverage.textContent ?? '', /pinned bounded pair\/triple search.*physical palette/i);
  assert.deepEqual(searches.at(-1), {
    expectedRevision: 41,
    sourceHash: 'hash-41',
    targetColor: '#008000',
    minComponentPercent: 10,
  });
  const ranked = [...document.querySelectorAll<HTMLElement>('[data-virtual-match-candidate]')];
  assert.equal(ranked[0].dataset.virtualMatchCandidate, 'pinned-match:perfect-green');
  assert.match(ranked[0].textContent ?? '', /predicted #008000.*ΔE2000 0.00/i);

  const selected = document.querySelector<HTMLInputElement>(
    '[data-virtual-match-candidate-choice="pinned-match:perfect-green"]',
  )!;
  selected.checked = true;
  selected.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
  await submitDialog(document);
  assert.equal(calls.add.length, 1);
  assert.equal(calls.add[0].draft.mode, 'match');
  if (calls.add[0].draft.mode !== 'match') throw new Error('Expected Match draft');
  assert.equal(calls.add[0].draft.selectedCandidateId, 'pinned-match:perfect-green');
  library.dispose();
});

await test('keeps async Match pending, latest-wins, cancellable, and closed against stale late results', async () => {
  const { document, container } = createDom();
  let current = snapshot();
  let listener: (() => void) | undefined;
  const calls = mutationCalls();
  const searches: VirtualFilamentMatchSearchRequest[] = [];
  const pending: Deferred<readonly VirtualFilamentMatchCandidate[]>[] = [];
  const cancellations: unknown[] = [];
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => current, calls, {
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      searchMatchCandidates: (request) => {
        searches.push(request);
        const search = deferred<readonly VirtualFilamentMatchCandidate[]>();
        pending.push(search);
        return search.promise;
      },
      cancelMatchCandidateSearch: (reason) => {
        cancellations.push(reason);
      },
    }),
    { matchSearchDebounceMs: 0 },
  );
  library.mount();

  openAdd(document);
  changeRadio(document, '[data-virtual-mode="match"]');
  setText(document, 'match-target', '#008000');
  setNumber(document, 'match-minimum', '10');
  await flush();
  assert.equal(searches.length, 1);
  assert.equal(document.querySelector('[data-virtual-match-candidates]')?.getAttribute('aria-busy'), 'true');
  assert.ok(document.querySelector('[data-virtual-match-pending]'));
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')?.disabled,
    true,
  );

  const cancellationsBeforeReplacement = cancellations.length;
  setText(document, 'match-target', '#0000FF');
  await flush();
  assert.equal(searches.length, 2);
  assert.ok(cancellations.length > cancellationsBeforeReplacement, 'changing the target must cancel active work');
  assert.equal(searches[1].targetColor, '#0000FF');

  pending[0].resolve([
    {
      id: 'stale-green',
      components: [
        { filamentId: physicalA, weight: 50 },
        { filamentId: physicalC, weight: 50 },
      ],
      previewColor: '#008000',
    },
  ]);
  await flush();
  assert.equal(document.querySelector('[data-virtual-match-candidate="stale-green"]'), null);
  assert.ok(
    document.querySelector('[data-virtual-match-pending]'),
    'a stale completion must not clear newer pending work',
  );

  pending[1].resolve([
    {
      id: 'latest-blue',
      components: [
        { filamentId: physicalA, weight: 50 },
        { filamentId: physicalB, weight: 50 },
      ],
      previewColor: '#0000FF',
    },
  ]);
  await flush();
  assert.equal(document.querySelector('[data-virtual-match-candidates]')?.getAttribute('aria-busy'), 'false');
  assert.ok(document.querySelector('[data-virtual-match-candidate="latest-blue"]'));
  assert.equal(document.querySelector('[data-virtual-match-candidate="stale-green"]'), null);

  setText(document, 'match-target', '#FF0000');
  await flush();
  const cancellationsBeforeClose = cancellations.length;
  document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-cancel"]')!.click();
  assert.ok(cancellations.length > cancellationsBeforeClose, 'closing the dialog must cancel active Match work');
  pending[2].resolve([]);
  await flush();
  assert.equal(document.querySelector('[data-virtual-filament-dialog]'), null);

  openAdd(document);
  changeRadio(document, '[data-virtual-mode="match"]');
  setText(document, 'match-target', '#FFFFFF');
  await flush();
  const staleSearch = pending.at(-1)!;
  current = snapshot({ sourceRevision: 42, sourceHash: 'hash-42' });
  listener?.();
  assert.match(document.querySelector('[data-virtual-dialog-errors]')?.textContent ?? '', /snapshot changed/i);
  assert.equal(document.querySelector('[data-virtual-match-pending]'), null);
  staleSearch.resolve([
    {
      id: 'late-after-revision',
      components: [
        { filamentId: physicalA, weight: 50 },
        { filamentId: physicalC, weight: 50 },
      ],
      previewColor: '#FFFFFF',
    },
  ]);
  await flush();
  assert.equal(document.querySelector('[data-virtual-match-candidate="late-after-revision"]'), null);
  assert.equal(totalMutationCalls(calls), 0);
  library.dispose();
  assert.equal(listener, undefined);
});

await test('edits reverse Gradient endpoints and duplicates a complete source recipe', async () => {
  const { document, container } = createDom();
  const source = snapshot();
  const calls = mutationCalls();
  const library = new VirtualFilamentLibrary(
    container,
    adapter(() => source, calls),
  );
  library.mount();

  rowAction<HTMLButtonElement>(document, mixedOcean, 'edit').click();
  assert.equal(field<HTMLInputElement>(document, 'component-a-surface-offset').value, '0.25');
  assert.equal(field<HTMLInputElement>(document, 'component-b-surface-offset').value, '-0.5');
  changeRadio(document, '[data-virtual-mode="gradient"]');
  changeSelect(document, 'gradient-component-0', physicalA);
  changeSelect(document, 'gradient-component-1', physicalC);
  changeRadio(document, '[data-virtual-gradient-direction="b-to-a"]');
  setNumber(document, 'gradient-sublayers', '5');
  const visual = document.querySelector<HTMLElement>('[data-virtual-gradient-preview]')!;
  assert.match(visual.textContent ?? '', /B→A vertical preview.*A 20%→80%.*Crimson PLA.*Snow PLA/i);
  assert.match(visual.style.background, /linear-gradient/i);
  assert.match(
    document.querySelector('[data-virtual-draft-preview]')?.textContent ?? '',
    /component A 20% → 80%.*component B 80% → 20%.*5 Local-Z/i,
  );
  await submitDialog(document);

  assert.equal(calls.edit.length, 1);
  const edit = calls.edit[0];
  assert.equal(edit.filamentId, mixedOcean);
  assert.equal(edit.draft.mode, 'gradient');
  if (edit.draft.mode !== 'gradient') throw new Error('Expected Gradient draft');
  assert.deepEqual([edit.draft.projection.gradient_start, edit.draft.projection.gradient_end], [0.2, 0.8]);
  assert.equal(edit.draft.projection.local_z_max_sublayers, 5);
  assert.equal(edit.draft.componentASurfaceOffsetMm, 0.25);
  assert.equal(edit.draft.componentBSurfaceOffsetMm, -0.5);
  assert.deepEqual(
    edit.draft.components.map((component) => component.filamentId),
    [physicalA, physicalC],
  );

  rowAction<HTMLButtonElement>(document, mixedOcean, 'duplicate').click();
  assert.equal(field<HTMLInputElement>(document, 'name').value, 'Ocean mix copy');
  assert.equal(field<HTMLInputElement>(document, 'component-a-surface-offset').value, '0.25');
  assert.equal(field<HTMLInputElement>(document, 'component-b-surface-offset').value, '-0.5');
  await submitDialog(document);
  assert.equal(calls.duplicate.length, 1);
  const duplicate = calls.duplicate[0];
  assert.equal(duplicate.sourceFilamentId, mixedOcean);
  assert.equal(duplicate.draft.name, 'Ocean mix copy');
  assert.equal(duplicate.draft.mode, 'ratio');
  assert.equal(duplicate.draft.componentASurfaceOffsetMm, 0.25);
  assert.equal(duplicate.draft.componentBSurfaceOffsetMm, -0.5);
  assert.deepEqual(
    { expectedRevision: duplicate.expectedRevision, sourceHash: duplicate.sourceHash },
    { expectedRevision: 41, sourceHash: 'hash-41' },
  );
  assert.ok(Object.isFrozen(duplicate));
  library.dispose();
});

await test('guards enable/delete, shows dependencies and async errors, and never mutates rows optimistically', async () => {
  const { document, container } = createDom();
  const source = snapshot();
  const calls = mutationCalls();
  let failEnable = true;
  let failDelete = true;
  const custom = adapter(() => source, calls, {
    onSetEnabled: async (request) => {
      calls.enabled.push(request);
      if (failEnable) {
        failEnable = false;
        throw new Error('stale enable guard');
      }
    },
    onDelete: async (request) => {
      calls.delete.push(request);
      if (failDelete) {
        failDelete = false;
        throw new Error('dependency changed');
      }
    },
  });
  const errors: unknown[] = [];
  custom.onError = (error) => errors.push(error);
  const library = new VirtualFilamentLibrary(container, custom);
  library.mount();

  rowAction<HTMLButtonElement>(document, mixedOcean, 'enabled').click();
  await flush();
  assert.equal(calls.enabled.length, 1);
  assert.deepEqual(
    {
      expectedRevision: calls.enabled[0].expectedRevision,
      sourceHash: calls.enabled[0].sourceHash,
      filamentId: calls.enabled[0].filamentId,
      enabled: calls.enabled[0].enabled,
    },
    { expectedRevision: 41, sourceHash: 'hash-41', filamentId: mixedOcean, enabled: false },
  );
  assert.equal(
    document.querySelector(`[data-virtual-filament-row="${mixedOcean}"]`)?.dataset.enabled,
    'true',
    'failed mutation must not optimistically change the row',
  );
  assert.match(document.querySelector('[data-virtual-filament-error]')?.textContent ?? '', /stale enable guard/i);
  assert.ok(Object.isFrozen(calls.enabled[0].draft));

  rowAction<HTMLButtonElement>(document, mixedOcean, 'delete').click();
  assert.equal(document.querySelector('[data-virtual-filament-dialog="delete"]')?.getAttribute('role'), 'alertdialog');
  assert.match(
    document.querySelector('[data-virtual-delete-dependencies]')?.textContent ?? '',
    /Dragon body part.*Painted wing facets/i,
  );
  document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="delete-cancel"]')!.click();
  await flush();
  assert.equal(calls.delete.length, 0, 'delete cancel must not call the adapter');

  rowAction<HTMLButtonElement>(document, mixedOcean, 'delete').click();
  document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="delete-confirm"]')!.click();
  await flush();
  assert.equal(calls.delete.length, 1);
  assert.match(document.querySelector('[data-virtual-dialog-errors]')?.textContent ?? '', /dependency changed/i);
  assert.ok(document.querySelector('[data-virtual-filament-dialog="delete"]'), 'failure keeps confirmation open');
  document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="delete-confirm"]')!.click();
  await flush();
  assert.equal(calls.delete.length, 2);
  assert.equal(document.querySelector('[data-virtual-filament-dialog]'), null);
  assert.ok(
    document.querySelector(`[data-virtual-filament-row="${mixedOcean}"]`),
    'even success waits for a changed authoritative snapshot',
  );
  assert.ok(Object.isFrozen(calls.delete[1]));
  assert.ok(Object.isFrozen(calls.delete[1].draft));
  assert.equal(errors.length, 2);
  library.dispose();
});

await test('fails an open authoring dialog closed when revision or hash changes', async () => {
  const { dom, document, container } = createDom();
  let current = snapshot();
  let listener: (() => void) | undefined;
  const calls = mutationCalls();
  const custom = adapter(() => current, calls, {
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  });
  const library = new VirtualFilamentLibrary(container, custom);
  library.mount();

  rowAction<HTMLButtonElement>(document, mixedOcean, 'edit').click();
  setText(document, 'name', 'Stale draft');
  current = snapshot({ sourceRevision: 42, sourceHash: 'hash-42' });
  listener?.();
  assert.match(document.querySelector('[data-virtual-dialog-errors]')?.textContent ?? '', /snapshot changed/i);
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-virtual-dialog-action="author-submit"]')?.disabled,
    true,
  );
  const form = document.querySelector<HTMLFormElement>('[data-virtual-filament-dialog="author"]')!;
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(totalMutationCalls(calls), 0);
  key(dom, form, 'Escape');
  await flush();
  assert.equal(document.querySelector('[data-virtual-filament-dialog]'), null);
  library.dispose();
  assert.equal(listener, undefined);
});

console.log(`VirtualFilamentLibrary DOM tests passed (${passed})`);

interface MutationCalls {
  readonly add: AddVirtualFilamentRequest[];
  readonly edit: EditVirtualFilamentRequest[];
  readonly duplicate: DuplicateVirtualFilamentRequest[];
  readonly enabled: SetVirtualFilamentEnabledRequest[];
  readonly delete: DeleteVirtualFilamentRequest[];
}

function mutationCalls(): MutationCalls {
  return { add: [], edit: [], duplicate: [], enabled: [], delete: [] };
}

function totalMutationCalls(calls: MutationCalls): number {
  return calls.add.length + calls.edit.length + calls.duplicate.length + calls.enabled.length + calls.delete.length;
}

function adapter(
  getSnapshot: () => VirtualFilamentLibrarySnapshot,
  calls: MutationCalls,
  overrides: Partial<VirtualFilamentLibraryAdapter> = {},
): VirtualFilamentLibraryAdapter {
  return {
    getSnapshot,
    onAdd: (request) => {
      calls.add.push(request);
    },
    onEdit: (request) => {
      calls.edit.push(request);
    },
    onDuplicate: (request) => {
      calls.duplicate.push(request);
    },
    onSetEnabled: (request) => {
      calls.enabled.push(request);
    },
    onDelete: (request) => {
      calls.delete.push(request);
    },
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<Pick<VirtualFilamentLibrarySnapshot, 'sourceRevision' | 'sourceHash'>> = {},
): VirtualFilamentLibrarySnapshot {
  const physicalChoices = [
    {
      id: physicalA,
      toolId: 1,
      name: 'Crimson PLA',
      material: 'PLA',
      color: '#FF0000',
      enabled: true,
      compatible: true,
    },
    {
      id: physicalB,
      toolId: 2,
      name: 'Ocean PLA',
      material: 'PLA',
      color: '#0000FF',
      enabled: true,
      compatible: true,
    },
    {
      id: physicalC,
      toolId: 3,
      name: 'Snow PLA',
      material: 'PLA',
      color: '#FFFFFF',
      enabled: true,
      compatible: true,
    },
    {
      id: physicalD,
      toolId: 4,
      name: 'Carbon PETG',
      material: 'PETG-CF',
      color: '#202020',
      enabled: false,
      compatible: false,
      incompatibilityReason: 'abrasive profile is unavailable',
    },
  ] as const;
  return {
    sourceRevision: overrides.sourceRevision ?? 41,
    sourceHash: overrides.sourceHash ?? 'hash-41',
    physicalChoices,
    mixedRows: [
      {
        id: mixedOcean,
        enabled: true,
        draft: ratioDraft(),
        dependencyLabels: ['Dragon body part', 'Painted wing facets'],
      },
    ],
    matchCandidates: [
      {
        id: 'candidate-purple',
        label: 'Pigment purple',
        components: [
          { filamentId: physicalA, weight: 50 },
          { filamentId: physicalB, weight: 50 },
        ],
        previewColor: '#800080',
      },
      {
        id: 'candidate-pale-red',
        label: 'Pale red',
        components: [
          { filamentId: physicalA, weight: 80 },
          { filamentId: physicalC, weight: 20 },
        ],
        previewColor: '#FFCCCC',
      },
    ],
  };
}

function ratioDraft(): VirtualFilamentRatioDraft {
  return {
    name: 'Ocean mix',
    displayColor: '#800080',
    componentASurfaceOffsetMm: 0.25,
    componentBSurfaceOffsetMm: -0.5,
    mode: 'ratio',
    components: [
      { filamentId: physicalA, toolId: 1 },
      { filamentId: physicalB, toolId: 2 },
    ],
    mixBPercent: 50,
    projection: requireMixedFilamentAuthoring(
      { mode: 'ratio', componentIds: [1, 2], mixBPercent: 50 },
      { physicalToolCount: 4 },
    ),
  };
}

function createDom() {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document;
  return {
    dom,
    document,
    container: document.getElementById('host') as HTMLElement,
  };
}

function openAdd(document: Document): void {
  document.querySelector<HTMLButtonElement>('[data-virtual-filament-add]')!.click();
}

function field<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement = HTMLInputElement>(
  document: Document,
  name: string,
): T {
  return document.querySelector<T>(`[data-virtual-field="${name}"]`)!;
}

function setText(document: Document, name: string, value: string): void {
  const input = field<HTMLInputElement | HTMLTextAreaElement>(document, name);
  input.value = value;
  input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
}

function setNumber(document: Document, name: string, value: string): void {
  setText(document, name, value);
}

function changeSelect(document: Document, name: string, value: string): void {
  const select = field<HTMLSelectElement>(document, name);
  select.value = value;
  select.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
}

function changeRadio(document: Document, selector: string): void {
  const radio = document.querySelector<HTMLInputElement>(selector)!;
  radio.checked = true;
  radio.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
}

function quickTool(document: Document, toolId: number): void {
  document.querySelector<HTMLButtonElement>(`[data-virtual-quick-tool="${toolId}"]`)!.click();
}

async function submitDialog(document: Document): Promise<void> {
  const form = document.querySelector<HTMLFormElement>('[data-virtual-filament-dialog="author"]')!;
  form.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

function rowAction<T extends HTMLElement>(document: Document, filamentId: string, action: string): T {
  return document.querySelector<T>(`[data-virtual-filament-action="${action}"][data-filament-id="${filamentId}"]`)!;
}

function key(
  dom: InstanceType<typeof JSDOM>,
  target: EventTarget,
  value: string,
  options: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    }),
  );
}

function pointer(
  dom: InstanceType<typeof JSDOM>,
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  values: Readonly<{ pointerId: number; clientX: number; clientY: number }>,
): void {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
  });
  target.dispatchEvent(event);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
