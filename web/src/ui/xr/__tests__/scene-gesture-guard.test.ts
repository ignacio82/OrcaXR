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

guard.end(left);
assert.equal(guard.begin(left, false), true, 'release resets only the released controller');
assert.equal(guard.allow(right, false), false, 'the other controller remains suppressed');

guard.clear();
assert.equal(guard.begin(right, false), true);

console.log('XR scene gesture guard tests passed');
