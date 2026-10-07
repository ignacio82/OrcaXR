import assert from 'node:assert/strict';
import { ActionContext } from '../ActionContext';
import { buildRegistry } from '../catalog';
import { UiState } from '../UiState';
import type { ActionInvocation } from '../ActionRegistry';
import { entityId } from '../../project/domain/ids';
import type { OrcaWorkspace } from '../../workspace/OrcaWorkspace';

const plateId = entityId<'plate'>('import:async:plate');
const sourceRevision = 7;
const entity = { kind: 'plate' as const, id: plateId };
const cases: readonly [string, string, ActionInvocation, readonly unknown[]][] = [
  ['add_plate', 'addPlate', {}, []],
  ['duplicate_plate', 'duplicatePlate', { plateTarget: { plateId, sourceRevision } }, [plateId, sourceRevision]],
  ['activate_plate', 'setActivePlate', { plateTarget: { plateId, sourceRevision } }, [plateId, sourceRevision]],
  ['delete_plate', 'deletePlate', { plateTarget: { plateId, sourceRevision } }, [plateId, sourceRevision]],
  [
    'rename_plate',
    'renamePlate',
    { plateRename: { plateId, sourceRevision, nextName: 'Acknowledged' } },
    [plateId, 'Acknowledged', sourceRevision],
  ],
  [
    'reorder_plates',
    'reorderPlates',
    { plateReorder: { orderedPlateIds: [plateId], sourceRevision } },
    [[plateId], sourceRevision],
  ],
  [
    'set_plate_printable',
    'setPlatePrintable',
    { platePrintable: { plateId, sourceRevision, printable: false } },
    [plateId, false, sourceRevision],
  ],
  [
    'objects_rename',
    'renameObjectsTreeEntity',
    { objectsRename: { entity: { kind: 'object', id: entityId<'object'>('import:async:object') }, name: 'Renamed' } },
    [{ kind: 'object', id: entityId<'object'>('import:async:object') }, 'Renamed'],
  ],
  ['toggle_printable', 'toggleSelectedPrintable', {}, []],
  ['drop_to_bed', 'dropSelectedToBed', {}, []],
  ['scale_to_fit_volume', 'scaleSelectionToFitPrintVolume', {}, []],
  ['arrange_all', 'arrangePlate', {}, []],
  ['mirror_x', 'mirrorSelected', {}, ['x']],
  ['mirror_y', 'mirrorSelected', {}, ['y']],
  ['mirror_z', 'mirrorSelected', {}, ['z']],
  ['reset_rotation', 'resetSelectedTransform', {}, ['rotation']],
  ['reset_scale', 'resetSelectedTransform', {}, ['scale']],
  ['center_on_plate', 'centerSelectedOnPlate', {}, []],
  [
    'assembly_align',
    'applyAssemblyAlignment',
    { assemblyAlignment: { kind: 'center-coincidence' } },
    ['center-coincidence', undefined],
  ],
  ['objects_reveal', 'revealObjectsTreeEntity', { objectsReveal: entity }, [entity]],
  ['delete_models', 'deleteSelectedModel', {}, []],
  ['edit_delete_selected', 'deleteSelectedModel', {}, []],
  ['edit_delete_all', 'deleteAllModels', {}, []],
  ['edit_cut', 'cutSelectedModel', {}, []],
  ['instance_to_object', 'convertInstanceToIndependentObject', {}, [undefined]],
  ['add_instance', 'addInstanceToSelection', {}, []],
  ['edit_duplicate', 'cloneSelectedModel', {}, []],
  ['fill_bed_with_instances', 'fillPlateWithSelection', {}, []],
  ['edit_paste', 'pasteClipboard', {}, []],
];

let passed = 0;
for (const [actionId, operation, request, expectedArgs] of cases) {
  const surfaces = buildRegistry().get(actionId)!.capability.surfaces;
  assert.ok(surfaces.some((surface) => surface.startsWith('dom-')));
  if (actionId !== 'assembly_align') assert.ok(surfaces.some((surface) => surface.startsWith('xr-')));
  for (const surface of surfaces) {
    for (const outcome of ['accepted', 'rejected'] as const) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<void>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      const calls: unknown[][] = [];
      const workspace = {
        hasClipboard: true,
        [operation]: (...args: unknown[]) => {
          calls.push(args);
          return completion;
        },
        setStatus() {
          throw new Error('An enabled editing action must not report unavailable');
        },
      } as unknown as OrcaWorkspace;
      const registry = buildRegistry();
      const ui = new UiState();
      ui.update({ plateCount: 2, modelCount: 1, hasSelection: true, hasInstanceSelection: true, hasClipboard: true });
      const context = new ActionContext(workspace, ui, registry);
      let settled = false;
      const invocation = registry.invoke(actionId, surface, context, ui.get(), request);
      void invocation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(calls, [expectedArgs], `${surface} ${actionId} must preserve its captured request`);
      assert.equal(settled, false, 'the registry must wait for the authoritative response');
      if (outcome === 'accepted') {
        resolve();
        assert.equal(await invocation, true);
      } else {
        const error = new Error('Synthetic stale editing acknowledgement');
        reject(error);
        await assert.rejects(invocation, (actual) => actual === error);
      }
      assert.equal(settled, true);
      passed++;
      console.log(`  ✓ ${surface} ${actionId} waits for ${outcome} acknowledgement`);
    }
  }
}
for (const outcome of ['accepted', 'rejected'] as const) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const receipt = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  const projectionError = new Error('Clipboard projection failed');
  const commandError = new Error('Cut was refused');
  const workspace = { hasClipboard: true, cutSelectedModel: () => receipt } as unknown as OrcaWorkspace;
  const ui = new UiState();
  const unsubscribe = ui.subscribe((state) => {
    if (state.hasClipboard) throw projectionError;
  });
  const context = new ActionContext(workspace, ui, buildRegistry());
  let settled = false;
  const pending = context.cutSelected();
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false, 'a failed clipboard projection must still settle the deletion receipt');
  if (outcome === 'accepted') resolve();
  else reject(commandError);
  await assert.rejects(pending, (error) => error === (outcome === 'accepted' ? projectionError : commandError));
  unsubscribe();
  passed++;
  console.log(`  ✓ clipboard projection failure retains ownership of ${outcome} cut`);
}
console.log(`\nAsynchronous editing actions: ${passed} tests passed.`);
