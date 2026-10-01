import assert from 'node:assert/strict';
import { FeatureInitializationRegistry } from '../FeatureInitialization';
import { initializationBlockReason } from '../InitializationPolicy';
const health = new FeatureInitializationRegistry();
for (const id of ['workspace', 'shell', 'profiles', 'settings']) health.define({ id, label: id, core: true });
const slice = { id: 'slice_active_plate', group: 'slice' };
assert.match(initializationBlockReason(slice, health.snapshot)!, /loading/);
for (const id of ['printer_emergency_stop', 'printer_firmware_restart', 'printer_pause', 'printer_cancel'])
  assert.equal(initializationBlockReason({ id, group: 'output' }, health.snapshot), undefined);
assert.equal(initializationBlockReason({ id: 'help_startup_recovery', group: 'help' }, health.snapshot), undefined);
await health.run('workspace', () => {});
await health.run('shell', () => {});
await health.run('profiles', () => {
  throw new Error('catalog unavailable');
});
assert.match(initializationBlockReason(slice, health.snapshot)!, /profiles is unavailable/);
assert.equal(initializationBlockReason({ id: 'tool_move', group: 'scene' }, health.snapshot), undefined);
await health.run('profiles', () => {});
await health.run('settings', () => {
  throw new Error('schema unavailable');
});
for (const action of [
  slice,
  { id: 'settings_apply_project', group: 'advanced' },
  { id: 'presets_install_printer', group: 'advanced' },
  { id: 'calib_place_geometry', group: 'calibration' },
])
  assert.match(initializationBlockReason(action, health.snapshot)!, /settings is unavailable/);
await health.run('settings', () => {});
assert.equal(initializationBlockReason(slice, health.snapshot), undefined);
health.define({ id: 'camera', label: 'Camera' });
assert.equal(health.snapshot.phase, 'ready');
await health.run('camera', () => {
  throw new Error('optional import failed');
});
assert.equal(health.snapshot.phase, 'degraded');
assert.equal(initializationBlockReason(slice, health.snapshot), undefined);
health.dispose();
console.log('Initialization action policy passed.');
