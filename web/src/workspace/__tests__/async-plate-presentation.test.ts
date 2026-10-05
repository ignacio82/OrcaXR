import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
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
  const workspace = new OrcaWorkspace(buildRegistry());
  const controller = (workspace as unknown as { canonicalProject: CanonicalWorkspaceController }).canonicalProject;
  const first = controller.getSummary().activePlateId;
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const model = controller.importBufferGeometry(geometry, { name: 'First' });
  const second = await controller.addPlate('Second');
  const other = controller.importBufferGeometry(geometry, { name: 'Second' });
  geometry.dispose();
  await controller.activatePlate(first);
  return { workspace, controller, first, second, model, other };
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
        else if (drift === 'edit') controller.renameObject(other.objectId, 'Newer');
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

console.log(`\nAsynchronous plate presentation: ${passed} tests passed.`);
