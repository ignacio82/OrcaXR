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
  ['objects_reveal', 'revealObjectsTreeEntity', { objectsReveal: entity }, [entity]],
];

let passed = 0;
for (const [actionId, operation, request, expectedArgs] of cases) {
  const surfaces = buildRegistry().get(actionId)!.capability.surfaces;
  assert.ok(surfaces.some((surface) => surface.startsWith('dom-')));
  assert.ok(surfaces.some((surface) => surface.startsWith('xr-')));
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
        [operation]: (...args: unknown[]) => {
          calls.push(args);
          return completion;
        },
        setStatus() {
          throw new Error('An enabled plate action must not report unavailable');
        },
      } as unknown as OrcaWorkspace;
      const registry = buildRegistry();
      const ui = new UiState();
      ui.update({ plateCount: 2, modelCount: 1, hasSelection: true });
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
        const error = new Error('Synthetic stale plate acknowledgement');
        reject(error);
        await assert.rejects(invocation, (actual) => actual === error);
      }
      assert.equal(settled, true);
      passed++;
      console.log(`  ✓ ${surface} ${actionId} waits for ${outcome} acknowledgement`);
    }
  }
}
console.log(`\nAsynchronous plate actions: ${passed} tests passed.`);
