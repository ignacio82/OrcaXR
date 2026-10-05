import assert from 'node:assert/strict';
import { ActionContext } from '../ActionContext';
import { buildRegistry } from '../catalog';
import { UiState } from '../UiState';
import type { OrcaWorkspace } from '../../workspace/OrcaWorkspace';

let passed = 0;
for (const surface of ['dom-menu', 'keyboard', 'xr-menu'] as const) {
  for (const operation of ['undo', 'redo'] as const) {
    for (const outcome of ['accepted', 'rejected'] as const) {
      let resolve!: (value: boolean) => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<boolean>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      let calls = 0;
      const workspace = {
        [operation]: () => {
          calls++;
          return completion;
        },
        setStatus() {
          throw new Error('An enabled history action must not report unavailable');
        },
      } as unknown as OrcaWorkspace;
      const registry = buildRegistry();
      const ui = new UiState();
      ui.update({ canUndo: true, canRedo: true });
      const context = new ActionContext(workspace, ui, registry);
      let settled = false;
      const invocation = registry.invoke(`edit_${operation}`, surface, context, ui.get());
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
      assert.equal(calls, 1);
      assert.equal(settled, false, 'the registry must wait for the authoritative history response');
      if (outcome === 'accepted') {
        resolve(true);
        assert.equal(await invocation, true);
      } else {
        const error = new Error('Synthetic stale history acknowledgement');
        reject(error);
        await assert.rejects(invocation, (actual) => actual === error);
      }
      assert.equal(settled, true);
      passed++;
      console.log(`  ✓ ${surface} ${operation} waits for ${outcome} acknowledgement`);
    }
  }
}
console.log(`\nAsynchronous history actions: ${passed} tests passed.`);
