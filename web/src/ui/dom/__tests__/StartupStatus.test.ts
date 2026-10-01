import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { FeatureInitializationRegistry } from '../../../startup/FeatureInitialization';
import { StartupStatus } from '../StartupStatus';

const dom = new JSDOM('<div id="boot"></div>');
const root = dom.window.document.getElementById('boot') as HTMLElement;
const health = new FeatureInitializationRegistry();
health.define({ id: 'settings', label: 'Settings schema', core: true, recovery: 'retry' });
const attempts: string[] = [];
const panel = new StartupStatus(root, health, (id) => attempts.push(id));
panel.mount();
panel.mount();
assert.equal(root.dataset.bootState, 'loading');
await health.run('settings', () => {
  throw new Error('<strong>Fetch failed</strong>');
});
assert.equal(root.dataset.bootState, 'failed');
assert.equal(root.classList.contains('ready'), false);
assert.ok(root.textContent?.includes('<strong>Fetch failed</strong>'));
assert.equal(root.querySelectorAll('strong').length, 1, 'failure details remain text');
(root.querySelector('[data-startup-recovery]') as HTMLButtonElement).click();
assert.deepEqual(attempts, ['settings']);
await health.run('settings', () => {});
assert.equal(root.dataset.bootState, 'ready');
assert.equal(root.classList.contains('ready'), true);
health.define({ id: 'camera', label: 'Camera' });
assert.equal(root.dataset.bootState, 'ready', 'an unrequested camera is neutral');
panel.dispose();
await health.run('camera', () => {
  throw new Error('Late error');
});
assert.equal(root.textContent, '', 'a disposed surface receives no late health changes');
health.dispose();
dom.window.close();
console.log('Startup status surface passed.');
