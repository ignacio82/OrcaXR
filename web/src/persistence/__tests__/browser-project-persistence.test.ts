import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { BrowserProjectPersistence } from '../BrowserProjectPersistence';
import type { PersistenceProjectPort, PersistenceProjectState } from '../ProjectPersistenceController';
import { createProjectFixture } from '../../project/__tests__/fixtures';

const dom = new JSDOM('<main></main>', { url: 'http://192.0.2.10/' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'localStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const location = {
  href: 'http://192.0.2.10/',
  origin: 'http://192.0.2.10',
  pathname: '/',
  search: '',
  reload: () => {
    reloads++;
  },
};
Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
let reloads = 0;
const fixture = createProjectFixture();
let state: PersistenceProjectState = {
  guard: { projectId: fixture.ids.project, revision: 0, semanticHash: 'a', assetFingerprint: 'a' },
  name: 'Settings only',
  dirty: false,
};
const observers = new Set<() => void>();
function edit() {
  state = { ...state, dirty: true, guard: { ...state.guard, revision: state.guard.revision + 1 } };
  for (const listener of observers) listener();
}
const project: PersistenceProjectPort = {
  read: () => state,
  subscribe: (listener) => {
    observers.add(listener);
    return () => {
      observers.delete(listener);
    };
  },
  serialize: async () => ({
    guard: state.guard,
    serialized: {
      bytes: new Uint8Array([1]),
      suggestedFilename: 'project.3mf',
      mediaType: 'model/3mf',
      sourceRevision: state.guard.revision,
      sourceHash: state.guard.semanticHash,
    },
  }),
  acknowledge: (guard) => {
    assert.deepEqual(guard, state.guard);
    state = { ...state, dirty: false };
    for (const listener of observers) listener();
  },
};
const workerContainer = new EventTarget() as EventTarget & { controller: object; getRegistration(): Promise<unknown> };
workerContainer.controller = {};
let activated = 0;
let duringActivation = () => {};
const waiting = {
  postMessage: (message: unknown) => {
    assert.deepEqual(message, { type: 'SKIP_WAITING' });
    activated++;
    duringActivation();
    workerContainer.controller = {};
    workerContainer.dispatchEvent(new Event('controllerchange'));
  },
};
workerContainer.getRegistration = async () => ({ update: async () => {}, waiting });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: workerContainer } });
const reports: string[] = [];
let downloads = 0;
const adapter = new BrowserProjectPersistence({
  project,
  host: document.querySelector('main')!,
  download: () => {
    downloads++;
  },
  restore: async () => {
    throw new Error('Unexpected restore');
  },
  report: (text) => reports.push(text),
  isXrPresenting: () => false,
  chooseInXr: async () => 'cancel',
  invoke: async () => {},
  directoryChanged: () => {},
});
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function choose(choice: string) {
  const button = document.querySelector<HTMLButtonElement>(`[data-unsaved-choice="${choice}"]`);
  assert.ok(button, choice);
  button.click();
}
function unloadBlocked() {
  const event = new dom.window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
await flush();
assert.ok(
  reports.some((text) => /storage is unavailable/.test(text)),
  'storage failure is visible',
);
assert.equal(unloadBlocked(), false);
edit();
assert.equal(unloadBlocked(), true);
const cancel = adapter.navigate('reload', () => {
  reloads++;
});
choose('cancel');
assert.equal(await cancel, false);
assert.equal(reloads, 0);
const save = adapter.navigate('reload', () => {
  reloads++;
});
choose('save');
assert.equal(await save, true);
assert.equal(downloads, 1, 'settings-only dirty work can be exported');
assert.equal(state.dirty, false);
assert.equal(unloadBlocked(), false);
edit();
const discard = adapter.navigate('navigate', () => {
  reloads++;
});
choose('discard');
assert.equal(await discard, true, 'unavailable recovery storage cannot trap navigation');
assert.equal(unloadBlocked(), false, 'only the approved revision may leave');
edit();
assert.equal(unloadBlocked(), true, 'new edits invalidate departure permission');
const cancelledUpdate = adapter.checkForUpdates();
await flush();
choose('cancel');
await cancelledUpdate;
assert.equal(activated, 0, 'cancel leaves the waiting application inactive');
const before = reloads;
const changedUpdate = adapter.checkForUpdates();
await flush();
duringActivation = edit;
choose('discard');
await flush();
choose('cancel');
await changedUpdate;
assert.equal(activated, 1);
assert.equal(reloads, before, 'an edit during update activation requires another decision before reload');
assert.equal(unloadBlocked(), true);
const closing = adapter.navigate('reload', () => {
  reloads++;
});
adapter.dispose();
assert.equal(await closing, false);
assert.equal(observers.size, 0);
assert.equal(document.querySelector('[data-recovery-panel]'), null);
assert.equal(document.querySelector('[data-unsaved-choice]'), null);
assert.equal(unloadBlocked(), false);
dom.window.close();
console.log(
  'Browser persistence: storage degradation, exact navigation approval, settings-only save, guarded update and disposal passed.',
);
