import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { mountExternalSlicerSettings } from '../ExternalSlicerSettings';
import { SlicerClient } from '../../../slicer/SlicerClient';
import { PINNED_ENGINE_PROVENANCE } from '../../../slicer/pinnedEngineProvenance';

const markup = `<input id="external-slicer-url"><input id="external-slicer-token"><input type="checkbox" id="external-slicer-enabled">
<button id="btn-external-slicer-connect">Connect</button><button id="btn-external-slicer-delete">Forget</button>
<span id="external-slicer-status"></span><div id="external-slicer-controls"></div><p id="external-slicer-hint"></p>`;
const proof = {
  schemaVersion: 1,
  engine: 'wasm',
  attested: true,
  upstream: { commit: PINNED_ENGINE_PROVENANCE.commit },
  artifacts: PINNED_ENGINE_PROVENANCE.artifacts,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let passed = 0;
async function test(name: string, run: (dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM(markup, { url: 'http://container.test:3000' });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    AbortController: { configurable: true, value: dom.window.AbortController },
  });
  try {
    await run(dom);
    passed++;
    console.log(`  ✓ ${name}`);
  } finally {
    SlicerClient.invalidateExternalSlicerProbe();
    dom.window.close();
  }
}
function mount(dom: JSDOM, statuses: string[] = []) {
  return mountExternalSlicerSettings({
    root: dom.window.document,
    initialToken: '',
    status: (message) => statuses.push(message),
    changed: () => {},
    credentialsChanged: () => {},
    reportFailure: async () => {},
  });
}
await test('a late serving-origin reply cannot overwrite a manually connected endpoint or status', async (dom) => {
  let release!: (value: unknown) => void;
  globalThis.fetch = async (request) => {
    if ((request instanceof Request ? request.url : String(request)).startsWith('http://container.test'))
      return {
        ok: true,
        json: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      } as Response;
    return { ok: true, json: async () => proof } as Response;
  };
  const surface = mount(dom);
  await tick();
  const doc = dom.window.document;
  const url = doc.getElementById('external-slicer-url');
  assert.equal(doc.getElementById('external-slicer-enabled').checked, false);
  assert.equal(SlicerClient.useExternalSlicer(), false);
  url.value = 'http://chosen.test:3000';
  url.dispatchEvent(new dom.window.Event('input'));
  doc.getElementById('btn-external-slicer-connect').click();
  await tick();
  assert.equal(url.value, 'http://chosen.test:3000');
  assert.equal(doc.getElementById('external-slicer-enabled').checked, true);
  assert.match(doc.getElementById('external-slicer-status').textContent, /Online.*attested/);
  release(proof);
  await tick();
  assert.equal(url.value, 'http://chosen.test:3000');
  assert.match(doc.getElementById('external-slicer-status').textContent, /Online.*attested/);
  surface.dispose();
});
await test('editing a candidate or credentials cancels discovery without replacing the draft', async (dom) => {
  globalThis.fetch = async () => new Promise(() => {});
  const surface = mount(dom);
  const doc = dom.window.document;
  const url = doc.getElementById('external-slicer-url');
  url.value = 'http://typed.test';
  url.dispatchEvent(new dom.window.Event('input'));
  const token = doc.getElementById('external-slicer-token');
  token.value = 'test-session-value';
  token.dispatchEvent(new dom.window.Event('input'));
  await tick();
  assert.equal(url.value, 'http://typed.test');
  assert.equal(SlicerClient.useExternalSlicer(), false);
  assert.equal(SlicerClient.getExternalSlicerConnection().phase, 'idle');
  surface.dispose();
  SlicerClient.setExternalSlicerToken('', { persist: false });
});
await test('an explicitly disabled discovered route causes no startup requests on remount', async (dom) => {
  globalThis.fetch = async () => ({ ok: true, json: async () => proof }) as Response;
  const first = mount(dom);
  await tick();
  const checkbox = dom.window.document.getElementById('external-slicer-enabled');
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.dispatchEvent(new dom.window.Event('change'));
  first.dispose();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('must stay disabled');
  };
  const second = mount(dom);
  await tick();
  assert.equal(calls, 0);
  assert.equal(checkbox.checked, false);
  assert.equal(dom.window.document.getElementById('external-slicer-url').value, 'http://container.test:3000');
  second.dispose();
});
await test('disposing a pending surface prevents late callbacks and removes its controls listeners', async (dom) => {
  let release!: (value: unknown) => void;
  globalThis.fetch = async () =>
    ({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }) as Response;
  const statuses: string[] = [];
  const surface = mount(dom, statuses);
  await tick();
  surface.dispose();
  surface.dispose();
  const before = dom.window.document.body.innerHTML;
  release(proof);
  await tick();
  dom.window.document.getElementById('btn-external-slicer-connect').click();
  assert.equal(dom.window.document.body.innerHTML, before);
  assert.equal(SlicerClient.useExternalSlicer(), false);
  assert.deepEqual(statuses, []);
});
console.log(`\nExternal slicer settings surface: ${passed} tests passed.`);
