import assert from 'node:assert/strict';
import { ActionContext } from '../ActionContext';
import { buildRegistry } from '../catalog';
import { UiState } from '../UiState';
import type { TransformEditRequest } from '../ActionRegistry';
import type { AsyncSessionAcknowledgement } from '../../project/AsyncEditorSession';
import { entityId } from '../../project/domain/ids';
import { identityTransform } from '../../project/domain/model';
import type { OrcaWorkspace } from '../../workspace/OrcaWorkspace';

// An opaque marker proves pass-through; controller/transport tests qualify its contents.
const receipt = Object.freeze({ requestId: 37 }) as AsyncSessionAcknowledgement<void>;
const request: TransformEditRequest = {
  changes: [{ instanceId: entityId<'instance'>('import:transform:instance'), transform: identityTransform() }],
  gestureId: 'gesture:37',
};
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

for (const mode of ['move', 'rotate', 'scale'] as const) {
  for (const surface of ['dom-inspector', 'dom-scene', 'xr-scene'] as const) {
    for (const accepted of [true, false]) {
      await test(`${surface} ${mode} preserves the actual ${accepted ? 'acknowledgement' : 'failure'}`, async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const failure = new Error('Synthetic lost acknowledgement');
        const seen: TransformEditRequest[] = [];
        const workspace = {
          async applyTransformEdit(edit: TransformEditRequest) {
            seen.push(edit);
            await held;
            if (!accepted) throw failure;
            return receipt;
          },
          setTool() {
            throw new Error('Committing a pose must not restart the active tool');
          },
          setStatus() {
            throw new Error('An enabled action must not report unavailable');
          },
        } as unknown as OrcaWorkspace;
        const registry = buildRegistry();
        const ui = new UiState();
        ui.update({ hasInstanceSelection: true });
        const context = new ActionContext(workspace, ui, registry);
        let settled = false;
        const pending = registry.invokeWithResult(`tool_${mode}`, surface, context, ui.get(), {
          transformEdit: request,
        });
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        assert.equal(settled, false);
        assert.deepEqual(seen, [request]);
        release();
        if (accepted) {
          const completion = await pending;
          assert.ok(Object.isFrozen(completion));
          assert.ok(completion.invoked && completion.result?.kind === 'project-edit');
          assert.equal(completion.result.acknowledgement, receipt);
        } else await assert.rejects(pending, (error) => error === failure);
        assert.equal(seen.length, 1, 'uncertain commands are never retried');
      });
    }
  }
}

await test('result and boolean APIs enforce the same disabled and undeclared surface boundary', async () => {
  let commands = 0;
  const workspace = {
    async applyTransformEdit() {
      commands++;
      return receipt;
    },
    setStatus() {},
  } as unknown as OrcaWorkspace;
  const registry = buildRegistry();
  const ui = new UiState();
  const context = new ActionContext(workspace, ui, registry);
  for (const method of ['invoke', 'invokeWithResult'] as const) {
    for (const surface of ['dom-inspector', 'dom-scene', 'xr-scene', 'xr-primary'] as const) {
      const denied = await registry[method]('tool_move', surface, context, ui.get(), { transformEdit: request });
      assert.deepEqual(
        denied,
        method === 'invoke'
          ? false
          : {
              invoked: false,
              reason:
                surface === 'xr-primary' ? 'Not offered on xr-primary.' : 'Select a model instance for this action.',
            },
      );
    }
  }
  ui.update({ hasInstanceSelection: true });
  assert.deepEqual(
    await registry.invokeWithResult('tool_move', 'xr-primary', context, ui.get(), { transformEdit: request }),
    { invoked: false, reason: 'Not offered on xr-primary.' },
  );
  assert.equal(commands, 0);
  assert.equal(await registry.invoke('tool_move', 'dom-scene', context, ui.get(), { transformEdit: request }), true);
  assert.equal(commands, 1);
});

await test('tool selection stays synchronous and returns no fabricated edit receipt', async () => {
  const selected: string[] = [];
  const workspace = {
    setTool(mode: string) {
      selected.push(mode);
    },
  } as OrcaWorkspace;
  const registry = buildRegistry();
  const ui = new UiState();
  ui.update({ hasInstanceSelection: true });
  const context = new ActionContext(workspace, ui, registry);
  const pending = registry.invokeWithResult('tool_rotate', 'dom-toolbar', context, ui.get());
  assert.deepEqual(selected, ['rotate']);
  assert.equal(ui.get().activeTool, 'rotate');
  assert.deepEqual(await pending, { invoked: true, result: undefined });
});

await test('lay-on-face scene commits await their handler and do not claim an XR scene route', async () => {
  const seen: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workspace = {
    async applyLayOnFace(value: unknown) {
      seen.push(value);
      await held;
    },
  } as unknown as OrcaWorkspace;
  const registry = buildRegistry();
  const ui = new UiState();
  ui.update({ hasInstanceSelection: true });
  const context = new ActionContext(workspace, ui, registry);
  const layOnFace = { instanceId: request.changes[0].instanceId, localNormal: [0, 0, -1] as const };
  const pending = registry.invoke('tool_lay_on_face', 'dom-scene', context, ui.get(), { layOnFace });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(seen, [layOnFace]);
  assert.equal(await registry.invoke('tool_lay_on_face', 'xr-scene', context, ui.get(), { layOnFace }), false);
  release();
  assert.equal(await pending, true);
});

console.log(`\nTransform registry routing: ${passed} tests passed.`);
