import assert from 'node:assert/strict';

import {
  FULL_SPECTRUM_AUTO_PAIR_PREFERENCES_STORAGE_KEY,
  loadFullSpectrumAutoPairPreferences,
  saveFullSpectrumAutoPairPreferences,
  type FullSpectrumAutoPairPreferenceStorage,
} from '../FullSpectrumAutoPairPreferences';

class MemoryStorage implements FullSpectrumAutoPairPreferenceStorage {
  value: string | null = null;
  lastKey = '';

  getItem(key: string): string | null {
    this.lastKey = key;
    return this.value;
  }

  setItem(key: string, value: string): void {
    this.lastKey = key;
    this.value = value;
  }
}

const storage = new MemoryStorage();
assert.deepEqual(loadFullSpectrumAutoPairPreferences(storage), { enabled: false });
assert.equal(storage.lastKey, FULL_SPECTRUM_AUTO_PAIR_PREFERENCES_STORAGE_KEY);
assert.equal(storage.value, '{"enabled":false}');

saveFullSpectrumAutoPairPreferences({ enabled: true }, storage);
assert.equal(storage.value, '{"enabled":true}');
assert.deepEqual(loadFullSpectrumAutoPairPreferences(storage), { enabled: true });

storage.value = '{"enabled":"true","confirmation":true,"secret":"drop-me"}';
assert.deepEqual(loadFullSpectrumAutoPairPreferences(storage), { enabled: false });
assert.equal(storage.value, '{"enabled":false}');

storage.value = '{bad json';
assert.deepEqual(loadFullSpectrumAutoPairPreferences(storage), { enabled: false });
assert.equal(storage.value, '{"enabled":false}');

assert.throws(
  () => saveFullSpectrumAutoPairPreferences({ enabled: 'yes' as unknown as boolean }, storage),
  /must be boolean/,
);

console.log('FullSpectrum auto-pair preference tests passed');
