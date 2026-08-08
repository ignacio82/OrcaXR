import assert from 'node:assert/strict';
import { PaintOverlayRegistry } from './PaintOverlayRegistry';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('keeps one overlay per repeated-instance display and disposes stale entries exactly once', () => {
  const registry = new PaintOverlayRegistry<object, string, { id: string }>();
  const firstDisplay = {};
  const secondDisplay = {};
  const firstOverlay = { id: 'first' };
  const secondOverlay = { id: 'second' };
  registry.set(firstDisplay, 'shared-volume', firstOverlay);
  registry.set(secondDisplay, 'shared-volume', secondOverlay);

  assert.equal(registry.size, 2);
  assert.equal(registry.get(firstDisplay), firstOverlay);
  assert.equal(registry.get(secondDisplay), secondOverlay);
  assert.equal(registry.identityFor(firstDisplay), 'shared-volume');
  assert.equal(registry.identityFor(secondDisplay), 'shared-volume');

  const disposed: string[] = [];
  assert.equal(
    registry.prune(new Set([secondDisplay]), (overlay) => disposed.push(overlay.id)),
    1,
  );
  assert.deepEqual(disposed, ['first']);
  assert.equal(registry.get(firstDisplay), undefined);
  assert.equal(registry.get(secondDisplay), secondOverlay);

  registry.clear((overlay) => disposed.push(overlay.id));
  assert.deepEqual(disposed, ['first', 'second']);
  assert.equal(registry.size, 0);
});

console.log(`\nPaint overlay registry: ${passed} test passed.`);
