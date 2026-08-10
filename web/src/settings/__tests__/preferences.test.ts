import assert from 'node:assert/strict';

import {
  DEFAULT_PREFERENCES,
  PREFERENCES_SCHEMA_VERSION,
  PREFERENCE_KEYS,
  PROJECT_DATA_KEYS,
  SLICER_ENABLED_KEY,
  SLICER_URL_KEY,
  applyPreferences,
  exportPreferences,
  importPreferences,
  loadPreferences,
  migrateLegacyKeys,
  resetPreferences,
  savePreferences,
  type KeyValueStorage,
} from '../Preferences';

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

test('preferences survive a reload and fall back to defaults', () => {
  const store = storage();
  assert.deepEqual(loadPreferences(store), DEFAULT_PREFERENCES);

  savePreferences({ schemaVersion: PREFERENCES_SCHEMA_VERSION, reduceMotion: 'always' }, store);
  assert.equal(loadPreferences(store).reduceMotion, 'always');
});

test('a corrupt or hostile store never throws and never yields junk', () => {
  for (const raw of ['not json', 'null', '[]', '"text"', '{"reduceMotion":42}']) {
    const loaded = loadPreferences(storage({ 'orcaxr.preferences': raw }));
    assert.equal(loaded.reduceMotion, 'system', `"${raw}" must fall back, not propagate`);
    assert.equal(loaded.schemaVersion, PREFERENCES_SCHEMA_VERSION);
  }
});

/**
 * A real migration, not a hypothetical one: the slicer route shipped under
 * unnamespaced keys that collide with anything else on the origin.
 */
test('a pre-v2 install moves its slicer route under the namespace', () => {
  const store = storage({ external_slicer_url: 'http://printer.local:3000', external_slicer_enabled: 'true' });
  loadPreferences(store);

  assert.equal(store.entries.get(SLICER_URL_KEY), 'http://printer.local:3000');
  assert.equal(store.entries.get(SLICER_ENABLED_KEY), 'true');
  assert.equal(store.entries.has('external_slicer_url'), false, 'the colliding key is removed');
  assert.equal(store.entries.has('external_slicer_enabled'), false);
});

test('migration never overwrites a value set after migrating', () => {
  const store = storage({
    external_slicer_url: 'http://old.local:3000',
    [SLICER_URL_KEY]: 'http://new.local:3000',
  });
  migrateLegacyKeys(store);
  assert.equal(store.entries.get(SLICER_URL_KEY), 'http://new.local:3000', 'the newer value wins');
  assert.equal(store.entries.has('external_slicer_url'), false, 'and the stale one is cleared out');

  // Running it again changes nothing.
  const before = JSON.stringify([...store.entries]);
  migrateLegacyKeys(store);
  assert.equal(JSON.stringify([...store.entries]), before, 'migration is idempotent');
});

test('reset clears preferences and leaves projects and presets alone', () => {
  const store = storage({
    'orcaxr.preferences': '{"reduceMotion":"always"}',
    'orcaxr.printer': '{"host":"http://printer","port":7125}',
    'orcaxr.credentials': '{"printerApiKey":"secret"}',
    [SLICER_URL_KEY]: 'http://slicer:3000',
    external_slicer_enabled: 'true',
    // Work, not settings.
    'orcaxr.profiles': '{"catalog":"big"}',
    'orcaxr.full-spectrum.auto-pairs': '[[1,2]]',
    orcaxrProjectEntity: '{"project":"in progress"}',
  });

  resetPreferences(store);

  for (const key of PREFERENCE_KEYS) assert.equal(store.entries.has(key), false, `${key} should be cleared`);
  assert.equal(store.entries.has('external_slicer_enabled'), false, 'legacy keys go too');
  // The acceptance criterion: restoring preferences must not cost the operator
  // their projects or presets.
  for (const key of PROJECT_DATA_KEYS) assert.equal(store.entries.has(key), true, `${key} must survive a reset`);
});

test('an export carries the setup and never the secrets', () => {
  const store = storage({
    'orcaxr.printer': '{"host":"http://printer","port":7125}',
    'orcaxr.credentials': '{"printerApiKey":"secret-key","slicerToken":"secret-token"}',
    [SLICER_URL_KEY]: 'http://slicer:3000',
    'orcaxr.profiles': '{"catalog":"big"}',
  });

  const exported = exportPreferences(store);
  assert.equal(exported.format, 'orcaxr.preferences');
  assert.equal(exported.schemaVersion, PREFERENCES_SCHEMA_VERSION);
  assert.equal(exported.values['orcaxr.printer'], '{"host":"http://printer","port":7125}');
  assert.equal(exported.values[SLICER_URL_KEY], 'http://slicer:3000');

  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes('secret-key'), false, 'an export is shareable, so it holds no token');
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal('orcaxr.profiles' in exported.values, false, 'presets are not a preference');
});

test('an import applies what it recognises and reports the rest', () => {
  const store = storage();
  const result = importPreferences(
    {
      format: 'orcaxr.preferences',
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      values: {
        'orcaxr.printer': '{"host":"http://imported","port":7125}',
        'orcaxr.credentials': '{"printerApiKey":"do-not-import"}',
        'orcaxr.profiles': '{"catalog":"someone elses"}',
        'evil.key': 'payload',
        [SLICER_URL_KEY]: 42 as unknown as string,
      },
    },
    store,
  );

  assert.deepEqual(result.applied, ['orcaxr.printer']);
  // An import is a file from elsewhere: it must not reach credentials, project
  // data, or an arbitrary key on this origin.
  assert.equal(store.entries.has('orcaxr.credentials'), false);
  assert.equal(store.entries.has('orcaxr.profiles'), false);
  assert.equal(store.entries.has('evil.key'), false);
  assert.equal(store.entries.has(SLICER_URL_KEY), false, 'a non-text value is refused');
  assert.equal(result.warnings.length, 4);
  assert.match(result.warnings.join(' '), /secrets are never imported/);
});

test('an unusable or too-new export is refused whole', () => {
  for (const candidate of [null, 'text', {}, { format: 'something-else' }]) {
    const result = importPreferences(candidate, storage());
    assert.deepEqual(result.applied, []);
    assert.match(result.warnings[0], /not an OrcaXR preferences export|no usable schema version/);
  }
  const future = importPreferences(
    { format: 'orcaxr.preferences', schemaVersion: PREFERENCES_SCHEMA_VERSION + 1, values: {} },
    storage(),
  );
  assert.deepEqual(future.applied, []);
  // Better to say "update first" than to half-apply a shape this build cannot
  // read and leave the operator with a mixture.
  assert.match(future.warnings[0], /Update OrcaXR first/);
});

test('a pre-v2 export is migrated as it is applied', () => {
  const store = storage();
  const result = importPreferences(
    { format: 'orcaxr.preferences', schemaVersion: 1, values: { external_slicer_url: 'http://legacy:3000' } },
    store,
  );
  // v1 names are not preference keys any more, so the value arrives through the
  // migration rather than by being written under a name this build ignores.
  assert.equal(store.entries.get(SLICER_URL_KEY) ?? null, null);
  assert.match(result.warnings.join(' '), /not a preference this build recognises/);
});

test('only preferences with an observable effect are applied', () => {
  const root = { dataset: {} as DOMStringMap };
  applyPreferences({ schemaVersion: PREFERENCES_SCHEMA_VERSION, reduceMotion: 'always' }, root);
  assert.equal(root.dataset.reduceMotion, 'always');

  applyPreferences({ schemaVersion: PREFERENCES_SCHEMA_VERSION, reduceMotion: 'system' }, root);
  assert.equal(root.dataset.reduceMotion, undefined, 'system defers to the OS signal the stylesheet reads');

  // A missing root is survivable; the app still runs on its defaults.
  applyPreferences(DEFAULT_PREFERENCES, null);
});

test('no storage at all is survivable throughout', () => {
  assert.deepEqual(loadPreferences(null), DEFAULT_PREFERENCES);
  savePreferences(DEFAULT_PREFERENCES, null);
  resetPreferences(null);
  assert.deepEqual(exportPreferences(null).values, {});
  assert.match(
    importPreferences({ format: 'orcaxr.preferences', schemaVersion: 2, values: {} }, null).warnings[0],
    /no storage/,
  );
});

console.log(`\nApplication preferences: ${passed} tests passed.`);
