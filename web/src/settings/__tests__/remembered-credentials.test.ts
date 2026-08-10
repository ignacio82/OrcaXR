import assert from 'node:assert/strict';

import {
  forgetRememberedCredentials,
  loadRememberedCredentials,
  saveRememberedCredentials,
  type KeyValueStorage,
} from '../RememberedCredentials';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function storage(initial: Record<string, string> = {}): KeyValueStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

test('a configured printer key and slicer token survive a reload', () => {
  const store = storage();
  saveRememberedCredentials(
    { printerApiKey: 'printer-key', printerApiKeys: {}, slicerToken: 'slicer-token', remember: true },
    store,
  );
  const loaded = loadRememberedCredentials(store);
  assert.equal(loaded.printerApiKey, 'printer-key');
  assert.equal(loaded.slicerToken, 'slicer-token');
  assert.equal(loaded.remember, true);
});

test('turning remembering off erases what was already stored', () => {
  const store = storage();
  saveRememberedCredentials(
    { printerApiKey: 'printer-key', printerApiKeys: {}, slicerToken: 'slicer-token', remember: true },
    store,
  );
  assert.ok(JSON.stringify([...store.entries.values()]).includes('printer-key'));

  // Being told to stop remembering has to remove the secret, not just stop
  // writing new ones — otherwise the old one outlives the instruction.
  saveRememberedCredentials(
    { printerApiKey: 'printer-key', printerApiKeys: {}, slicerToken: 'slicer-token', remember: false },
    store,
  );
  const raw = JSON.stringify([...store.entries.values()]);
  assert.equal(raw.includes('printer-key'), false);
  assert.equal(raw.includes('slicer-token'), false);

  const loaded = loadRememberedCredentials(store);
  assert.equal(loaded.remember, false, 'and the choice itself is remembered');
  assert.equal(loaded.printerApiKey, '');
});

test('forgetting removes the entry entirely', () => {
  const store = storage();
  saveRememberedCredentials({ printerApiKey: 'k', printerApiKeys: {}, slicerToken: 't', remember: true }, store);
  forgetRememberedCredentials(store);
  assert.equal(store.entries.size, 0);
  assert.deepEqual(loadRememberedCredentials(store), {
    printerApiKey: '',
    printerApiKeys: {},
    slicerToken: '',
    remember: true,
  });
});

test('clearing both secrets leaves nothing behind', () => {
  const store = storage();
  saveRememberedCredentials({ printerApiKey: 'k', printerApiKeys: {}, slicerToken: 't', remember: true }, store);
  saveRememberedCredentials({ printerApiKey: '', printerApiKeys: {}, slicerToken: '', remember: true }, store);
  assert.equal(store.entries.size, 0, 'an empty pair is an absent entry, not an empty record');
});

test('a corrupt or hostile store never throws and never yields junk', () => {
  for (const raw of ['not json', 'null', '[]', '"string"', '{"printerApiKey":42}']) {
    const loaded = loadRememberedCredentials(storage({ 'orcaxr.credentials': raw }));
    assert.equal(typeof loaded.printerApiKey, 'string');
    assert.equal(typeof loaded.slicerToken, 'string');
  }
  // An absurd value is refused rather than stored and handed back.
  const store = storage();
  saveRememberedCredentials(
    { printerApiKey: 'x'.repeat(5000), printerApiKeys: {}, slicerToken: 'fine', remember: true },
    store,
  );
  assert.equal(loadRememberedCredentials(store).printerApiKey, '');
  assert.equal(loadRememberedCredentials(store).slicerToken, 'fine');
});

test('a store written before the switch existed keeps remembering', () => {
  const loaded = loadRememberedCredentials(
    storage({ 'orcaxr.credentials': JSON.stringify({ printerApiKey: 'k', slicerToken: 't' }) }),
  );
  assert.equal(loaded.remember, true, 'those were only ever written deliberately');
  assert.equal(loaded.printerApiKey, 'k');
});

test('storage that throws is survivable', () => {
  const hostile: KeyValueStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadRememberedCredentials(hostile), {
    printerApiKey: '',
    printerApiKeys: {},
    slicerToken: '',
    remember: true,
  });
  saveRememberedCredentials({ printerApiKey: 'k', printerApiKeys: {}, slicerToken: 't', remember: true }, hostile);
  forgetRememberedCredentials(hostile);
});

test('no storage at all still returns a usable default', () => {
  assert.deepEqual(loadRememberedCredentials(null), {
    printerApiKey: '',
    printerApiKeys: {},
    slicerToken: '',
    remember: true,
  });
  saveRememberedCredentials({ printerApiKey: 'k', printerApiKeys: {}, slicerToken: 't', remember: true }, null);
});

test('each printer keeps its own key, so switching cannot send the wrong one', () => {
  const store = storage();
  saveRememberedCredentials(
    {
      printerApiKey: '',
      printerApiKeys: { 'printer-1': 'u1-key-value', 'printer-2': 'elegoo-key-value' },
      slicerToken: '',
      remember: true,
    },
    store,
  );
  const loaded = loadRememberedCredentials(store);
  assert.equal(loaded.printerApiKeys['printer-1'], 'u1-key-value');
  assert.equal(loaded.printerApiKeys['printer-2'], 'elegoo-key-value');

  // Turning remembering off erases every printer's key, not just the active one.
  saveRememberedCredentials({ ...loaded, remember: false }, store);
  const raw = JSON.stringify([...store.entries.values()]);
  assert.equal(raw.includes('u1-key-value'), false);
  assert.equal(raw.includes('elegoo-key-value'), false);
});

test('a corrupt per-printer map yields no keys rather than junk', () => {
  for (const raw of ['{"printerApiKeys":"no"}', '{"printerApiKeys":[1,2]}', '{"printerApiKeys":{"a":42}}']) {
    const loaded = loadRememberedCredentials(storage({ 'orcaxr.credentials': raw }));
    assert.deepEqual(loaded.printerApiKeys, {});
  }
});

console.log(`\nRemembered credentials: ${passed} tests passed.`);
