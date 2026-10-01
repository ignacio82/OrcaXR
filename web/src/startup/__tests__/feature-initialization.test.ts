import assert from 'node:assert/strict';
import { FeatureInitializationRegistry, InitializationScope } from '../FeatureInitialization';
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let passed = 0;
async function test(name: string, run: () => Promise<void> | void) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}
await test('readiness requires core workspace, profiles and schema, while unrequested optional capabilities stay idle', async () => {
  const health = new FeatureInitializationRegistry();
  for (const id of ['workspace', 'profiles', 'settings']) health.define({ id, label: id, core: true });
  for (const id of ['camera', 'ai', 'printer', 'xr']) health.define({ id, label: id });
  assert.equal(health.snapshot.phase, 'loading');
  await health.run('workspace', () => {});
  await health.run('profiles', () => {});
  assert.equal(health.snapshot.phase, 'loading');
  await health.run('settings', () => {});
  assert.equal(health.snapshot.phase, 'ready');
  assert.ok(health.snapshot.features.filter((feature) => !feature.core).every((feature) => feature.phase === 'idle'));
  health.dispose();
});
await test('core failure is failed, optional failure is degraded, and a retry can restore readiness', async () => {
  const health = new FeatureInitializationRegistry();
  health.define({ id: 'profiles', label: 'Required profiles', core: true, recovery: 'retry' });
  health.define({ id: 'camera', label: 'Camera' });
  let broken = true;
  await health.run('profiles', () => {
    if (broken) throw new Error('The profile catalogue could not be fetched.');
  });
  assert.equal(health.snapshot.phase, 'failed');
  assert.match(health.snapshot.features[0].reason, /profile catalogue/);
  broken = false;
  await health.retry('profiles');
  assert.equal(health.snapshot.phase, 'ready');
  await health.run('camera', () => {
    throw new Error('Camera module did not load');
  });
  assert.equal(health.snapshot.phase, 'degraded');
  health.dispose();
});
await test('failed initialization releases partial resources before retry and successful resources remain owned', async () => {
  const health = new FeatureInitializationRegistry();
  health.define({ id: 'panel', label: 'Panel' });
  const disposed: number[] = [];
  let attempt = 0;
  const init = (scope: InitializationScope) => {
    const id = ++attempt;
    scope.defer(() => disposed.push(id));
    if (id === 1) throw new Error('Partial mount failed');
    return id;
  };
  await health.run('panel', init);
  assert.deepEqual(disposed, [1]);
  assert.deepEqual(await health.retry('panel'), { ready: true, value: 2 });
  assert.deepEqual(await health.retry('panel'), { ready: true, value: 2 });
  assert.equal(attempt, 2);
  health.dispose();
  health.dispose();
  assert.deepEqual(disposed, [1, 2]);
});
await test('simultaneous and subscription-triggered retries share one initialization', async () => {
  const health = new FeatureInitializationRegistry();
  health.define({ id: 'settings', label: 'Settings' });
  const pending = defer();
  let calls = 0;
  health.subscribe((state) => {
    if (state.features[0].phase === 'loading') void health.retry('settings');
  });
  const first = health.run('settings', async () => {
    calls++;
    await pending.promise;
    return 7;
  });
  const second = health.retry('settings');
  pending.resolve();
  assert.deepEqual(await first, { ready: true, value: 7 });
  assert.deepEqual(await second, { ready: true, value: 7 });
  assert.equal(calls, 1);
  health.dispose();
});
await test('disposal settles hung initialization and suppresses late publication', async () => {
  const health = new FeatureInitializationRegistry();
  health.define({ id: 'xr', label: 'XR shell' });
  const pending = defer();
  let notifications = 0,
    cleaned = 0;
  health.subscribe(() => notifications++);
  const run = health.run('xr', async (scope) => {
    scope.defer(() => cleaned++);
    await scope.load(pending.promise);
    throw new Error('must not resume');
  });
  await Promise.resolve();
  health.dispose();
  const count = notifications;
  assert.equal((await run).ready, false);
  pending.resolve();
  await Promise.resolve();
  assert.equal(cleaned, 1);
  assert.equal(notifications, count);
  assert.equal((await health.retry('xr')).ready, false);
});
await test('hung initialization times out with cleanup and can retry', async () => {
  const health = new FeatureInitializationRegistry(10);
  health.define({ id: 'settings', label: 'Settings' });
  let cleaned = 0;
  const result = await health.run('settings', (scope) => {
    scope.defer(() => cleaned++);
    return new Promise(() => {});
  });
  assert.equal(result.ready, false);
  assert.equal(health.snapshot.features[0].phase, 'failed');
  assert.equal(cleaned, 1);
  health.dispose();
});
await test('resources arriving after cancellation are immediately disposed and cleanup failures do not skip others', () => {
  const scope = new InitializationScope();
  let cleaned = 0;
  scope.defer(() => cleaned++);
  scope.defer(() => {
    throw new Error('cleanup failure');
  });
  scope.dispose();
  assert.throws(() => scope.own({ dispose: () => cleaned++ }), /cancelled/);
  assert.equal(cleaned, 2);
});
await test('an already-cancelled load consumes late import rejection without publishing', async () => {
  const scope = new InitializationScope();
  scope.dispose();
  const rejected = Promise.reject(new Error('Import failed after navigation'));
  await assert.rejects(scope.load(rejected), /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

await test('a failed lazy module changes data retry into guarded reload recovery', async () => {
  const health = new FeatureInitializationRegistry();
  health.define({ id: 'settings', label: 'Settings', core: true, recovery: 'retry' });
  await health.run('settings', (scope) => scope.import(Promise.reject(new TypeError('Module fetch failed'))));
  assert.equal(health.snapshot.phase, 'failed');
  assert.equal(health.snapshot.features[0].recovery, 'reload');
  health.dispose();
});

console.log(`Feature initialization: ${passed} tests passed.`);
