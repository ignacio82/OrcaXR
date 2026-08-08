import assert from 'node:assert/strict';
import { SceneGestureGuard } from '../SceneGestureGuard';

const guard = new SceneGestureGuard<object>();
const left = {};
const right = {};

assert.equal(guard.begin(left, true), false);
assert.equal(guard.allow(left, false), false, 'a UI-owned gesture must stay suppressed after its ray moves');
assert.equal(guard.begin(right, false), true);
assert.equal(guard.allow(right, false), true, 'another controller remains independent');
assert.equal(guard.allow(right, true), false);
assert.equal(guard.allow(right, false), false, 'touching UI cancels the remainder of a scene gesture');

assert.deepEqual(guard.snapshot(), {
  starts: 2,
  updates: 4,
  ends: 0,
  allowedTransitions: 2,
  suppressedTransitions: 4,
  activeControllers: 2,
  uiOwnedControllers: 2,
  disposed: false,
});

guard.end(left);
assert.equal(guard.begin(left, false), true, 'release resets only the released controller');
assert.equal(guard.allow(right, false), false, 'the other controller remains suppressed');

assert.deepEqual(guard.snapshot(), {
  starts: 3,
  updates: 5,
  ends: 1,
  allowedTransitions: 3,
  suppressedTransitions: 5,
  activeControllers: 2,
  uiOwnedControllers: 1,
  disposed: false,
});

guard.clear();
assert.equal(guard.begin(right, false), true);

const beforeDispose = guard.snapshot();
guard.dispose();
guard.dispose();
assert.equal(guard.begin(left, false), false, 'a disposed owner never re-enables scene mutation');
assert.equal(guard.allow(right, false), false, 'stale selecting events stay blocked after disposal');
assert.deepEqual(guard.snapshot(), {
  ...beforeDispose,
  activeControllers: 0,
  uiOwnedControllers: 0,
  disposed: true,
});

console.log('XR scene gesture guard tests passed');
