/**
 * ConfigIO unit tests (run: npx tsx config-io.test.ts).
 */
import assert from 'node:assert';
import { exportConfigJson, parseConfigJson, type ConfigBundle } from '../ConfigIO';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const bundle: ConfigBundle = {
  machineName: 'Snapmaker U1 (0.4 nozzle)',
  processName: '0.20 Standard',
  filamentName: 'Snapmaker PLA',
  config: { layer_height: '0.2', sparse_infill_density: '15%', filament_type: 'PLA;PLA' },
};

test('export → parse round-trips the bundle', () => {
  const parsed = parseConfigJson(exportConfigJson(bundle));
  assert.ok(parsed);
  assert.strictEqual(parsed!.machineName, bundle.machineName);
  assert.strictEqual(parsed!.processName, '0.20 Standard');
  assert.deepStrictEqual(parsed!.config, bundle.config);
});

test('a plain flat config object is accepted', () => {
  const parsed = parseConfigJson(JSON.stringify({ layer_height: '0.3', wall_loops: 3 }));
  assert.ok(parsed);
  assert.strictEqual(parsed!.machineName, 'Imported');
  assert.strictEqual(parsed!.config.layer_height, '0.3');
  assert.strictEqual(parsed!.config.wall_loops, '3'); // numbers coerced to strings
});

test('array values are joined with ";"', () => {
  const parsed = parseConfigJson(JSON.stringify({ config: { filament_colour: ['#fff', '#000'] } }));
  assert.strictEqual(parsed!.config.filament_colour, '#fff;#000');
});

test('invalid JSON returns null', () => {
  assert.strictEqual(parseConfigJson('{not json'), null);
});

test('empty object returns null', () => {
  assert.strictEqual(parseConfigJson('{}'), null);
});

console.log(`\nConfigIO: ${passed} tests passed.`);
