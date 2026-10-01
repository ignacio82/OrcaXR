import assert from 'node:assert/strict';
import {
  ProjectPersistenceController,
  type PersistenceClock,
  type PersistenceEffectsPort,
  type PersistenceProjectPort,
  type PersistenceProjectState,
} from '../ProjectPersistenceController';
import type { ProjectExportGuard, SerializedProjectSnapshot } from '../../project/ports';
import { createProjectFixture } from '../../project/__tests__/fixtures';

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Clock implements PersistenceClock {
  time = 0;
  id = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown) {
    this.timers.delete(timer as number);
  }
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
  }
}
function harness() {
  const fixture = createProjectFixture();
  let state: PersistenceProjectState = {
    guard: {
      projectId: fixture.ids.project,
      revision: 0,
      semanticHash: 'hash-0',
      assetFingerprint: 'assets-0',
    },
    name: 'Example',
    dirty: false,
  };
  let listener = () => {};
  const calls: string[] = [];
  const stored: SerializedProjectSnapshot[] = [];
  const clock = new Clock();
  const project: PersistenceProjectPort = {
    read: () => state,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
    serialize: async (purpose) => {
      calls.push(purpose);
      const guard = state.guard;
      return {
        guard,
        serialized: {
          bytes: new Uint8Array([1]),
          mediaType: 'application/zip',
          suggestedFilename: 'Example.3mf',
          sourceHash: guard.semanticHash,
          sourceRevision: guard.revision,
        },
      };
    },
    acknowledge: (guard) => {
      assert.deepEqual(guard, state.guard, 'stale checkpoint');
      state = { ...state, dirty: false };
      calls.push('checkpoint');
      listener();
    },
  };
  const effects: PersistenceEffectsPort = {
    download: async () => {
      calls.push('download');
    },
    storeRecovery: async (snapshot) => {
      calls.push('store');
      stored.push(snapshot);
    },
    discardRecovery: async (_projectId, sessionId) => {
      calls.push(`discard:${sessionId}`);
    },
    confirmNavigation: async () => 'cancel',
  };
  const controller = new ProjectPersistenceController(project, effects, 'tab-session', clock);
  const edit = (overrides: Partial<ProjectExportGuard> = {}) => {
    const revision = state.guard.revision + 1;
    state = {
      ...state,
      dirty: true,
      guard: {
        ...state.guard,
        revision,
        semanticHash: `hash-${revision}`,
        ...overrides,
      },
    };
    listener();
  };
  return { controller, project, effects, clock, calls, stored, edit };
}

await test('autosave starts after five idle seconds and never marks a manual checkpoint', async () => {
  const h = harness();
  await h.clock.advance(10_000);
  assert.deepEqual(h.calls, []);
  h.edit();
  await h.clock.advance(4_999);
  assert.deepEqual(h.calls, []);
  await h.clock.advance(1);
  assert.deepEqual(h.calls, ['recovery', 'store']);
  assert.equal(h.project.read().dirty, true);
  assert.equal(await h.controller.captureNow(), false);
  h.controller.dispose();
});

await test('continuous edits cannot postpone capture beyond thirty seconds', async () => {
  const h = harness();
  h.edit();
  for (let i = 0; i < 29; i++) {
    await h.clock.advance(1_000);
    h.edit();
  }
  assert.deepEqual(h.calls, []);
  await h.clock.advance(1_000);
  assert.equal(h.stored.length, 1);
  assert.equal(h.stored[0].guard.revision, 30);
  h.controller.dispose();
});

await test('one queue coalesces captures and prioritizes an explicit save after the active request', async () => {
  const h = harness();
  h.edit();
  const release = deferred<void>();
  const serialize = h.project.serialize;
  h.project.serialize = async (purpose, token) => {
    const result = await serialize(purpose, token);
    if (purpose === 'recovery') await release.promise;
    return result;
  };
  const active = h.controller.captureNow();
  h.edit();
  const pending = h.controller.captureNow();
  assert.equal(h.controller.captureNow(), pending);
  const manual = h.controller.save();
  assert.deepEqual(h.calls, ['recovery']);
  release.resolve();
  assert.equal(await active, true);
  assert.equal(await manual, true);
  assert.equal(await pending, false);
  assert.deepEqual(h.calls, ['recovery', 'store', 'manual', 'download', 'checkpoint']);
  h.controller.dispose();
});

await test('failed download handoff and edits during export cannot clear dirty state', async () => {
  const h = harness();
  h.edit();
  h.effects.download = async () => {
    throw new Error('handoff failed');
  };
  await assert.rejects(h.controller.save(), /handoff failed/);
  assert.equal(h.project.read().dirty, true);
  const serialize = h.project.serialize;
  h.project.serialize = async (...args) => {
    const captured = await serialize(...args);
    h.edit();
    return captured;
  };
  await assert.rejects(h.controller.save(), /changed during export/);
  assert.equal(h.project.read().dirty, true);
  assert.equal(h.calls.includes('checkpoint'), false);
  h.controller.dispose();
});

await test('navigation exposes Save, Discard and Cancel with a single pending decision', async () => {
  const h = harness();
  h.edit();
  const choice = deferred<'save' | 'discard' | 'cancel'>();
  h.effects.confirmNavigation = () => choice.promise;
  const pending = h.controller.guardNavigation('new');
  assert.equal(h.controller.guardNavigation('reload'), pending);
  choice.resolve('cancel');
  assert.equal(await pending, false);
  h.effects.confirmNavigation = async () => 'save';
  assert.equal(await h.controller.guardNavigation('open'), true);
  assert.equal(h.project.read().dirty, false);
  h.edit();
  h.effects.confirmNavigation = async () => 'discard';
  assert.equal(await h.controller.guardNavigation('update'), true);
  assert.ok(h.calls.includes('discard:tab-session'));
  h.controller.dispose();
});

await test('a decision cannot discard edits made while its dialog was open', async () => {
  const h = harness();
  h.edit();
  const choice = deferred<'discard'>();
  h.effects.confirmNavigation = () => choice.promise;
  const pending = h.controller.guardNavigation('new');
  h.edit();
  choice.resolve('discard');
  assert.equal(await pending, false);
  assert.equal(
    h.calls.some((call) => call.startsWith('discard')),
    false,
  );
  h.controller.dispose();
});

await test('disposal settles queued saves and navigation and rejects late serialization results', async () => {
  const h = harness();
  h.edit();
  const release = deferred<SerializedProjectSnapshot>();
  h.project.serialize = () => release.promise;
  h.effects.confirmNavigation = () => new Promise(() => {});
  const active = h.controller.save();
  const queued = h.controller.save();
  const navigation = h.controller.guardNavigation('reload');
  h.controller.dispose();
  await assert.rejects(active, /disposed/);
  await assert.rejects(queued, /disposed/);
  assert.equal(await navigation, false);
  release.resolve({
    guard: h.project.read().guard,
    serialized: {
      bytes: new Uint8Array([1]),
      mediaType: 'application/zip',
      suggestedFilename: 'Example.3mf',
      sourceHash: 'hash-1',
      sourceRevision: 1,
    },
  });
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.clock.timers.size, 0);
  await assert.rejects(h.controller.save(), /disposed/);
});

await test('navigation approval binds the exact revision and disappears after another edit', async () => {
  const h = harness();
  assert.equal(await h.controller.guardNavigation('reload'), true);
  assert.deepEqual(h.controller.approvedNavigationGuard, h.project.read().guard);
  h.edit();
  assert.equal(h.controller.approvedNavigationGuard, undefined);
  h.effects.confirmNavigation = async () => 'discard';
  assert.equal(await h.controller.guardNavigation('navigate'), true);
  assert.deepEqual(h.controller.approvedNavigationGuard, h.project.read().guard);
  assert.equal(h.project.read().dirty, true, 'discard permission is not a saved checkpoint');
  h.edit();
  assert.equal(h.controller.approvedNavigationGuard, undefined);
  h.controller.dispose();
});

await test('recovery operations are exclusive and disposal settles a hung operation', async () => {
  const h = harness();
  const pending = deferred<boolean>();
  Object.assign(h.effects, {
    recovery: {
      list: async () => [],
      restore: () => pending.promise,
      download: async () => {},
      discard: async () => {},
    },
  });
  const recovering = h.controller.recoverSession('snapshot');
  assert.deepEqual(await h.controller.listRecoverySessions(), []);
  await assert.rejects(h.controller.discardRecovery('snapshot'), /still running/);
  h.controller.dispose();
  await assert.rejects(recovering, /disposed/);
  pending.resolve(true);
  await flush();
  await assert.rejects(h.controller.downloadRecovery('snapshot'), /disposed/);
});

console.log(`\n${passed} persistence controller tests passed.`);
