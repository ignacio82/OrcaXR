import assert from 'node:assert/strict';
import { ApplicationInitialization } from '../ApplicationInitialization';
const app = new ApplicationInitialization();
let attempts = 0,
  reloads = 0,
  allowed = false;
app.connectRecovery({
  reload: async () => {
    if (!allowed) return false;
    reloads++;
    return true;
  },
  report: () => {},
});
await app.mount('panel', 'Panel', () => {
  throw new Error('Module unavailable');
});
await app.recover('panel');
assert.equal(reloads, 0);
allowed = true;
await app.recover('panel');
assert.equal(reloads, 1);
await app.mount('profiles', 'Profiles', () => {
  if (attempts++ === 0) throw new Error('Network unavailable');
});
await app.recover('profiles');
assert.equal(attempts, 2);
await app.recover('profiles');
assert.equal(attempts, 2);
app.dispose();
await app.recover('panel');
assert.equal(reloads, 1);
console.log('Application initialization recovery passed.');
