import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { InitializationScope } from '../../startup/FeatureInitialization';
import { SurfaceLifecycle, ownPageLifetime } from '../SurfaceLifecycle';
const dom = new JSDOM('<button></button>');
const target = dom.window as Window;
const button = target.document.querySelector('button')!;
const lifetime = new SurfaceLifecycle();
let clicks = 0;
let disconnects = 0;
lifetime.listen(button, 'click', () => clicks++);
lifetime.observe({ disconnect: () => disconnects++ });
const original = () => 1;
const callback = { read: original };
lifetime.bind(callback, 'read', () => 2);
assert.equal(callback.read(), 2);
const other = { read: original };
lifetime.bind(other, 'read', () => 3);
const newer = () => 4;
other.read = newer;
const feature = new InitializationScope();
lifetime.attach(feature);
let settle: (value: number) => void = () => {};
const pending = feature.load(
  new Promise<number>((resolve) => {
    settle = resolve;
  }),
);
const rejected = assert.rejects(pending, /cancelled/);
let disposed = 0;
ownPageLifetime(target, lifetime, () => {
  disposed++;
  lifetime.dispose();
});
target.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
button.click();
assert.equal(clicks, 1, 'cached documents keep their event subscriptions');
assert.equal(feature.signal.aborted, false);
target.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: false }));
await rejected;
settle(42);
button.click();
target.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: false }));
assert.equal(clicks, 1, 'permanent departure removes handlers');
assert.equal(disposed, 1, 'the page-lifetime handler itself is removed');
assert.equal(disconnects, 1);
assert.equal(callback.read, original);
assert.equal(other.read, newer, 'cleanup cannot clobber a newer callback owner');
assert.equal(feature.signal.aborted, true);
let lateDisposed = 0;
assert.throws(() => lifetime.own({ dispose: () => lateDisposed++ }), /cancelled/);
assert.equal(lateDisposed, 1, 'late resources are released before rejection');
const lateFeature = new InitializationScope();
assert.throws(() => lifetime.attach(lateFeature), /cancelled/);
assert.equal(lateFeature.signal.aborted, true);
// A partially mounted surface must release resources even if one cleanup throws.
const partial = new SurfaceLifecycle();
let remaining = 0;
partial.own({ dispose: () => remaining++ });
partial.own({
  dispose: () => {
    throw new Error('fixture cleanup');
  },
});
partial.listen(button, 'click', () => clicks++);
partial.dispose();
button.click();
assert.equal(remaining, 1);
assert.equal(clicks, 1);
dom.window.close();
console.log('Surface ownership: cached navigation, permanent departure, partial mount and late work passed.');
