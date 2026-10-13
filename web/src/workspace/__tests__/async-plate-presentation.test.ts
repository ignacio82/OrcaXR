import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
import type { ActionSurface } from '../../actions/ActionRegistry';
import type { InstanceId } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import type { AsyncTransformGesture } from '../AsyncTransformGesture';
import { ActionContext } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import type { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

class TestAudioContext {
  readonly destination = {};
  readonly listener = {};
  readonly currentTime = 0;

  createGain() {
    return {
      gain: { value: 1, setTargetAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
}

class TestHtmlElement {}

const browserGlobals: Readonly<Record<string, unknown>> = {
  window: {
    location: { search: '' },
    AudioContext: TestAudioContext,
    addEventListener() {},
    removeEventListener() {},
  },
  document: {},
  navigator: {},
  HTMLElement: TestHtmlElement,
  customElements: { define() {}, get() {} },
  crypto: webcrypto,
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const [{ OrcaWorkspace }, { buildRegistry }] = await Promise.all([
  import('../OrcaWorkspace'),
  import('../../actions/catalog'),
]);

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function setup() {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  const ui = new UiState();
  ui.update({ hasSelection: true, hasInstanceSelection: true, modelCount: 2 });
  workspace.actionContext = new ActionContext(workspace, ui, registry);
  const controller = (workspace as unknown as { canonicalProject: CanonicalWorkspaceController }).canonicalProject;
  const first = controller.getSummary().activePlateId;
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const model = controller.importBufferGeometry(geometry, { name: 'First' });
  const second = await controller.addPlate('Second');
  const other = controller.importBufferGeometry(geometry, { name: 'Second' });
  geometry.dispose();
  await controller.activatePlate(first);
  return { workspace, controller, first, second, model, other, registry, ui };
}

for (const operation of [
  'addPlate',
  'duplicatePlate',
  'deletePlate',
  'activatePlate',
  'renamePlate',
  'reorderPlates',
  'setPlatePrintable',
] as const) {
  await test(`${operation} waits for the real commit acknowledgement before success feedback`, async () => {
    const { workspace, controller, first, second } = await setup();
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = controller[operation].bind(controller);
      // Hold only delivery; the real guarded command must execute underneath.
      Object.assign(controller, {
        [operation]: async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(original, controller, args);
          await held;
          return result;
        },
      });
      const statuses: string[] = [];
      workspace.onStatusChanged = (status) => statuses.push(status);
      let pending: Promise<unknown>;
      switch (operation) {
        case 'addPlate':
          pending = workspace.addPlate();
          break;
        case 'duplicatePlate':
          pending = workspace.duplicatePlate(first);
          break;
        case 'deletePlate':
          pending = workspace.deletePlate(second);
          break;
        case 'activatePlate':
          pending = workspace.setActivePlate(second);
          break;
        case 'renamePlate':
          pending = workspace.renamePlate(first, 'Renamed');
          break;
        case 'reorderPlates':
          pending = workspace.reorderPlates([second, first]);
          break;
        case 'setPlatePrintable':
          pending = workspace.setPlatePrintable(first, false);
          break;
      }
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(settled, false);
      assert.deepEqual(statuses, []);
      release();
      await pending;
      assert.equal(statuses.length, 1);
    } finally {
      workspace.dispose();
    }
  });
}

await test('a rejected plate edit preserves state and emits no success feedback', async () => {
  const { workspace, controller, first } = await setup();
  try {
    const statuses: string[] = [];
    workspace.onStatusChanged = (status) => statuses.push(status);
    const pending = workspace.renamePlate(first, 'Stale rename');
    controller.setProjectConfig({ presentation_probe: 'newer' });
    const current = controller.getSummary();
    await assert.rejects(pending, /project or its history changed/);
    assert.deepEqual(controller.getSummary(), current);
    assert.deepEqual(statuses, []);
  } finally {
    workspace.dispose();
  }
});

await test('deleting the active plate preserves selection made before acknowledgement delivery', async () => {
  const { workspace, controller, first, other } = await setup();
  try {
    const original = controller.deletePlate.bind(controller);
    controller.deletePlate = async (...args) => {
      await original(...args);
      controller.selectInstance(other.instanceId);
    };
    await workspace.deletePlate(first);
    assert.equal(controller.getSummary().primaryInstanceId, other.instanceId);
  } finally {
    workspace.dispose();
  }
});

for (const drift of ['selection', 'edit', 'reset'] as const) {
  await test(`late Objects reveal preserves a newer ${drift}`, async () => {
    const { workspace, controller, other } = await setup();
    try {
      const original = controller.activatePlate.bind(controller);
      let newer: ReturnType<CanonicalWorkspaceController['getObjectsTree']>['selection'];
      controller.activatePlate = async (...args) => {
        const receipt = await original(...args);
        if (drift === 'selection') controller.selectInstance(other.instanceId);
        else if (drift === 'edit') await controller.renameObject(other.objectId, 'Newer');
        else controller.resetProject();
        newer = controller.getObjectsTree().selection;
        return receipt;
      };
      const statuses: string[] = [];
      workspace.onStatusChanged = (status) => statuses.push(status);
      await workspace.revealObjectsTreeEntity({ kind: 'object', id: other.objectId });
      assert.deepEqual(controller.getObjectsTree().selection, newer!);
      assert.deepEqual(statuses, []);
    } finally {
      workspace.dispose();
    }
  });
}

await test('Objects reveal awaits activation, selects the row, and preserves one undo step', async () => {
  const { workspace, controller, second, other } = await setup();
  try {
    const before = controller.getSummary().history.undoCount;
    const pending = workspace.revealObjectsTreeEntity({ kind: 'object', id: other.objectId });
    assert.notEqual(controller.getSummary().activePlateId, second);
    await pending;
    assert.equal(controller.getSummary().activePlateId, second);
    assert.equal(controller.getSummary().history.undoCount, before + 1);
    assert.deepEqual(controller.getObjectsTree().selection.refs, [{ kind: 'object', id: other.objectId }]);
  } finally {
    workspace.dispose();
  }
});

await test('a committed plate acknowledgement after disposal emits no presentation work', async () => {
  const { workspace, controller } = await setup();
  const statuses: string[] = [];
  workspace.onStatusChanged = (status) => statuses.push(status);
  const original = controller.addPlate.bind(controller);
  controller.addPlate = async (...args) => {
    const id = await original(...args);
    workspace.dispose();
    return id;
  };
  assert.ok(await workspace.addPlate());
  assert.deepEqual(statuses, []);
});

await test('canonical selection removal detaches the transform helper without a second selection edit', async () => {
  const { workspace, controller, model, first } = await setup();
  try {
    controller.selectInstance(model.instanceId);
    await Promise.resolve();
    const helper = new THREE.Object3D();
    workspace.add(helper);
    let detached = 0;
    Object.assign(workspace, {
      transformControls: {
        detach() {
          detached++;
        },
        getHelper() {
          return helper;
        },
        dispose() {},
      },
    });
    await workspace.deletePlate(first);
    assert.ok(detached > 0);
    assert.equal(helper.visible, false);
    assert.equal(helper.parent, null);
    assert.equal(controller.getSummary().primaryInstanceId, undefined);
  } finally {
    workspace.dispose();
  }
});

for (const operation of [
  'rename',
  'part',
  'printable',
  'drop',
  'position',
  'rotation',
  'scale',
  'nudge',
  'mirror',
  'reset',
  'center',
  'arrange',
] as const) {
  await test(`${operation} presentation waits for delivered acknowledgement and tolerates disposal`, async () => {
    for (const closeBeforeDelivery of [false, true]) {
      const { workspace, controller, model } = await setup();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        controller.selectInstance(model.instanceId);
        const method = (
          {
            rename: 'renameObject',
            part: 'renameVolume',
            printable: 'setInstancePrintable',
            drop: 'dropInstancesToBed',
            position: 'setInstanceTransform',
            rotation: 'setInstanceTransform',
            scale: 'setInstanceTransform',
            nudge: 'setInstanceTransform',
            mirror: 'mirrorInstances',
            reset: 'resetInstanceTransforms',
            center: 'centerInstancesOnPlate',
            arrange: 'arrangePlate',
          } as const
        )[operation];
        const original = controller[method].bind(controller);
        let committed!: () => void;
        const commit = new Promise<void>((resolve) => {
          committed = resolve;
        });
        Object.assign(controller, {
          [method]: async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(original, controller, args);
            committed();
            await held;
            return result;
          },
        });
        const statuses: string[] = [];
        workspace.onStatusChanged = (status) => statuses.push(status);
        const invoke = () => {
          switch (operation) {
            case 'rename':
              return workspace.renameObjectsTreeEntity({ kind: 'object', id: model.objectId }, 'Renamed');
            case 'part':
              return workspace.renameObjectsTreeEntity({ kind: 'volume', id: model.volumeId }, 'Renamed part');
            case 'printable':
              return workspace.toggleSelectedPrintable();
            case 'drop':
              return workspace.dropSelectedToBed();
            case 'position':
              return workspace.setSelectedModelPosition(12, 13, 14);
            case 'rotation':
              return workspace.setSelectedModelRotation(0.1, 0.2, 0.3);
            case 'scale':
              return workspace.setSelectedModelScale(2, 2, 2);
            case 'nudge':
              return workspace.nudgeSelected(1);
            case 'mirror':
              return workspace.mirrorSelected('x');
            case 'reset':
              return workspace.resetSelectedTransform('both');
            case 'center':
              return workspace.centerSelectedOnPlate();
            case 'arrange':
              return workspace.arrangePlate();
          }
        };
        const pending = invoke();
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await commit;
        assert.equal(settled, false);
        assert.deepEqual(statuses, []);
        if (closeBeforeDelivery) workspace.dispose();
        release();
        await pending;
        assert.equal(settled, true);
        if (closeBeforeDelivery) assert.deepEqual(statuses, []);
      } finally {
        release();
        workspace.dispose();
      }
    }
  });
}

await test('alignment settlement preserves newer measurement picks and disposed callbacks', async () => {
  for (const outcome of ['accepted', 'rejected'] as const)
    for (const drift of ['picks', 'dispose'] as const) {
      const { workspace, controller, model, other } = await setup();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const picks = [
          { instanceId: model.instanceId, feature: { kind: 'plane', index: 0, normal: [0, 0, 1], origin: [0, 0, 0] } },
          { instanceId: other.instanceId, feature: { kind: 'plane', index: 0, normal: [0, 0, -1], origin: [0, 0, 5] } },
        ];
        Object.assign(workspace, { measurePicks: picks });
        const original = controller.setInstanceTransform.bind(controller);
        let ready!: () => void;
        const committed = new Promise<void>((resolve) => {
          ready = resolve;
        });
        controller.setInstanceTransform = async (...args) => {
          const receipt = await original(...args);
          ready();
          await held;
          if (outcome === 'rejected') throw new Error('Synthetic late reply failure');
          return receipt;
        };
        const statuses: string[] = [];
        let changed = 0;
        workspace.onStatusChanged = (status) => statuses.push(status);
        workspace.onMeasureStateChanged = () => {
          changed++;
        };
        const pending = workspace.applyAssemblyAlignment('center-coincidence');
        await committed;
        const newer = picks.slice().reverse();
        if (drift === 'dispose') workspace.dispose();
        else Object.assign(workspace, { measurePicks: newer });
        release();
        await pending;
        if (drift === 'picks') assert.equal((workspace as unknown as { measurePicks: unknown }).measurePicks, newer);
        assert.equal(changed, 0);
        assert.deepEqual(statuses, []);
      } finally {
        release();
        workspace.dispose();
      }
    }
});

for (const mode of ['move', 'rotate', 'scale'] as const) {
  await test(`${mode} numeric inputs obey registry availability before canonical mutation`, async () => {
    const { workspace, controller, model, registry, ui } = await setup();
    try {
      controller.selectInstance(model.instanceId);
      const calls: { id: unknown; surface: ActionSurface }[] = [];
      const invoke = registry.invokeWithResult.bind(registry);
      registry.invokeWithResult = async (id, surface, ...args) => {
        calls.push({ id, surface });
        return invoke(id, surface, ...args);
      };
      const edit = () =>
        mode === 'move'
          ? workspace.setSelectedModelPosition(11, 12, 13)
          : mode === 'rotate'
            ? workspace.setSelectedModelRotation(0.1, 0.2, 0.3)
            : workspace.setSelectedModelScale(2, 3, 4);
      const before = controller.captureProjectExportGuard();
      ui.update({ hasInstanceSelection: false });
      await assert.rejects(edit(), /Select a model instance/);
      assert.deepEqual(controller.captureProjectExportGuard(), before);
      ui.update({ hasInstanceSelection: true });
      await edit();
      assert.notEqual(controller.captureProjectExportGuard().semanticHash, before.semanticHash);
      assert.deepEqual(calls, [
        { id: `tool_${mode}`, surface: 'dom-inspector' },
        { id: `tool_${mode}`, surface: 'dom-inspector' },
      ]);
      await controller.undoAsync();
      assert.equal(controller.captureProjectExportGuard().semanticHash, before.semanticHash);
    } finally {
      workspace.dispose();
    }
  });
  for (const surface of ['dom-scene', 'xr-scene'] as const) {
    await test(`${surface} ${mode} gesture checks each edit and chains only the registry's delivered receipt`, async () => {
      const { workspace, controller, model, registry, ui } = await setup();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        controller.selectInstance(model.instanceId);
        workspace.setTool(mode);
        const internals = workspace as unknown as {
          ownTransformGesture(ids: readonly InstanceId[], id: string, surface: ActionSurface): AsyncTransformGesture;
        };
        const actual = registry.invokeWithResult.bind(registry);
        const calls: string[] = [];
        let ready!: () => void;
        const committed = new Promise<void>((resolve) => {
          ready = resolve;
        });
        registry.invokeWithResult = async (id, route, ...args) => {
          assert.equal(route, surface);
          calls.push(String(id));
          const result = await actual(id, route, ...args);
          if (calls.length === 1) {
            ready();
            await held;
          }
          return result;
        };
        const before = controller.getSummary().history.undoCount;
        const owner = internals.ownTransformGesture([model.instanceId], `registry-${mode}-${surface}`, surface);
        const pose = (x: number) => ({ ...identityTransform(), translationMm: [x, 0, 0] as const });
        owner.update([{ instanceId: model.instanceId, transform: pose(10) }]);
        await committed;
        for (let i = 20; i <= 200; i++) owner.update([{ instanceId: model.instanceId, transform: pose(i) }]);
        assert.deepEqual(calls, [`tool_${mode}`]);
        release();
        await owner.finish();
        assert.deepEqual(calls, [`tool_${mode}`, `tool_${mode}`]);
        assert.equal(controller.getInstanceTransform(model.instanceId)?.translationMm[0], 200);
        assert.equal(controller.getSummary().history.undoCount, before + 1);
        // A later gesture sees a changed capability before executing any pose.
        const denied = internals.ownTransformGesture([model.instanceId], 'blocked-gesture', surface);
        ui.update({ hasInstanceSelection: false });
        denied.update([{ instanceId: model.instanceId, transform: pose(300) }]);
        await assert.rejects(denied.finish(), /Select a model instance/);
        assert.equal(controller.getInstanceTransform(model.instanceId)?.translationMm[0], 200);
      } finally {
        release();
        workspace.dispose();
      }
    });
  }
}

await test('missing action context refuses numeric editing without a direct-controller fallback', async () => {
  const { workspace, controller, model } = await setup();
  try {
    controller.selectInstance(model.instanceId);
    workspace.actionContext = undefined;
    const before = controller.captureProjectExportGuard();
    await assert.rejects(workspace.setSelectedModelPosition(100, 100, 100), /surface is closed/);
    assert.deepEqual(controller.captureProjectExportGuard(), before);
  } finally {
    workspace.dispose();
  }
});

await test('production XR selection/drag/release reaches the declared scene action and settles its owner', async () => {
  const { workspace, controller, model, registry } = await setup();
  const xb = await import('xrblocks');
  const pointer = new THREE.Group();
  const hit = controller.surface.getVolumeMesh(model.instanceId, model.volumeId)!;
  xb.core.input.intersectionsForController.set(pointer, [{ object: hit, point: new THREE.Vector3(), distance: 1 }]);
  try {
    const actual = registry.invokeWithResult.bind(registry);
    const calls: unknown[][] = [];
    let acknowledged!: () => void;
    const receipt = new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
    registry.invokeWithResult = async (id, surface, ...args) => {
      calls.push([id, surface]);
      const result = await actual(id, surface, ...args);
      acknowledged();
      return result;
    };
    const before = controller.getInstanceTransform(model.instanceId)!;
    workspace.onSelectStart({ target: pointer });
    pointer.position.x = 0.05;
    workspace.onSelecting({ target: pointer });
    workspace.onSelectEnd({ target: pointer });
    await receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [['tool_move', 'xr-scene']]);
    assert.notDeepEqual(controller.getInstanceTransform(model.instanceId), before);
    assert.equal((workspace as unknown as { transformGestureOwners: Set<unknown> }).transformGestureOwners.size, 0);
    await controller.undoAsync();
    assert.deepEqual(controller.getInstanceTransform(model.instanceId), before);
  } finally {
    xb.core.input.intersectionsForController.delete(pointer);
    workspace.dispose();
  }
});

await test('capability loss while a gesture receipt is delayed stops its pending pose without retry', async () => {
  const { workspace, controller, model, registry, ui } = await setup();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    controller.selectInstance(model.instanceId);
    const actual = registry.invokeWithResult.bind(registry);
    let ready!: () => void;
    const committed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let calls = 0;
    registry.invokeWithResult = async (...args) => {
      calls++;
      const result = await actual(...args);
      if (calls === 1) {
        ready();
        await held;
      }
      return result;
    };
    const owner = (
      workspace as unknown as {
        ownTransformGesture(ids: readonly InstanceId[], id: string, surface: ActionSurface): AsyncTransformGesture;
      }
    ).ownTransformGesture([model.instanceId], 'capability-drift', 'dom-scene');
    const pose = (x: number) => ({ ...identityTransform(), translationMm: [x, 0, 0] as const });
    const before = controller.getSummary().history.undoCount;
    owner.update([{ instanceId: model.instanceId, transform: pose(10) }]);
    await committed;
    owner.update([{ instanceId: model.instanceId, transform: pose(20) }]);
    ui.update({ hasInstanceSelection: false });
    const pending = owner.finish();
    release();
    await assert.rejects(pending, /Select a model instance/);
    assert.equal(calls, 2);
    assert.equal(controller.getInstanceTransform(model.instanceId)?.translationMm[0], 10);
    assert.equal(controller.getSummary().history.undoCount, before + 1);
  } finally {
    release();
    workspace.dispose();
  }
});

const lifecycleActions = [
  ['edit_delete_selected', 'deleteSelectedInstance'],
  ['edit_delete_all', 'deleteAllObjectsOnPlate'],
  ['edit_cut', 'cutSelectedObject'],
  ['instance_to_object', 'convertInstanceToIndependentObject'],
  ['add_instance', 'duplicateSelectedInstance'],
  ['edit_duplicate', 'duplicateSelectedInstance'],
  ['fill_bed_with_instances', 'fillPlateWithInstances'],
  ['edit_paste', 'pasteClipboard'],
] as const;
for (const [action, method] of lifecycleActions) {
  for (const completion of ['acknowledged', 'disposed', 'failed', 'lost'] as const) {
    await test(`${action} preserves ${completion} completion through the real registry and workspace`, async () => {
      const { workspace, controller, model, other, registry, ui } = await setup();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let committed!: () => void;
      const applied = new Promise<void>((resolve) => {
        committed = resolve;
      });
      try {
        controller.selectInstance(model.instanceId);
        if (action === 'instance_to_object') await controller.duplicateSelectedInstance();
        if (action === 'edit_paste') {
          controller.copySelectedObject();
          ui.update({ hasClipboard: true });
        }
        const before = controller.captureProjectExportGuard();
        const historyBefore = controller.getSummary().history.undoCount;
        const statuses: string[] = [];
        workspace.onStatusChanged = (status) => statuses.push(status);
        const original = controller[method].bind(controller);
        const failure = new Error('Synthetic lifecycle receipt failure');
        let calls = 0;
        Object.assign(controller, {
          [method]: async (...args: unknown[]) => {
            calls++;
            if (completion === 'failed') {
              committed();
              await held;
              throw failure;
            }
            const value: unknown = await Reflect.apply(original, controller, args);
            committed();
            await held;
            if (completion === 'lost') throw failure;
            return value;
          },
        });
        let settled = false;
        const pending = registry.invoke(action, 'dom-menu', workspace.actionContext!, ui.get());
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await applied;
        assert.equal(settled, false);
        assert.equal(statuses.length, 0);
        if (action === 'edit_cut' && completion !== 'failed') assert.equal(ui.get().hasClipboard, true);
        assert.equal(calls, 1);
        if (completion === 'failed')
          assert.equal(controller.captureProjectExportGuard().semanticHash, before.semanticHash);
        else {
          assert.equal(controller.getSummary().history.undoCount, historyBefore + 1);
          assert.equal(controller.captureProjectExportGuard().assetFingerprint, before.assetFingerprint);
          controller.selectInstance(other.instanceId);
        }
        if (completion === 'disposed') workspace.dispose();
        const uiBeforeReply = { ...ui.get() };
        release();
        if (completion === 'failed' || completion === 'lost') {
          await assert.rejects(pending, (error) => error === failure);
          assert.ok(statuses.every((status) => status.includes('failed')));
          if (action === 'edit_cut' && completion === 'lost') assert.equal(ui.get().hasClipboard, true);
        } else {
          assert.equal(await pending, true);
          assert.equal(statuses.length, completion === 'disposed' ? 0 : 1);
        }
        assert.equal(calls, 1);
        assert.deepEqual(ui.get(), uiBeforeReply, 'late replies do not overwrite newer UI state');
        if (completion !== 'disposed' && completion !== 'failed') {
          assert.equal(controller.getSummary().primaryInstanceId, other.instanceId);
          await controller.undoAsync();
          assert.equal(controller.captureProjectExportGuard().semanticHash, before.semanticHash);
        }
      } finally {
        release();
        workspace.dispose();
      }
    });
  }
}

// One tool at a time: the transform handles stood over a selection under every tool, so a paint
// stroke, a lay-flat click or a measure pick that began on a handle also dragged the model.
await test('the transform handles show only while Move, Rotate or Scale is the tool', async () => {
  const { workspace, controller, model } = await setup();
  try {
    const helper = new THREE.Object3D();
    let attached = 0;
    Object.assign(workspace, {
      transformControls: {
        attach() {
          attached++;
        },
        detach() {},
        getHelper() {
          return helper;
        },
        setMode() {},
        dispose() {},
      },
    });
    controller.selectInstance(model.instanceId);
    await Promise.resolve();
    for (const tool of ['paint', 'seam_paint', 'lay_on_face', 'measure', 'brim_ears'] as const) {
      workspace.setTool(tool);
      assert.equal(helper.visible, false, `handles shown under ${tool}`);
      assert.equal(helper.parent, null, `handles in the scene under ${tool}`);
    }
    workspace.setTool('rotate');
    assert.equal(helper.visible, true);
    assert.equal(helper.parent, workspace);
    assert.ok(attached > 0);
    controller.clearSelection();
    await Promise.resolve();
    workspace.setTool('move');
    assert.equal(helper.visible, false, 'handles shown with nothing selected');
  } finally {
    workspace.dispose();
  }
});

console.log(`\nAsynchronous editing presentation: ${passed} tests passed.`);
