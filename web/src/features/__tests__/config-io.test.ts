/**
 * ConfigIO unit tests (run: npx tsx config-io.test.ts).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { exportConfigJson, parseConfigJson, type ConfigBundle } from '../ConfigIO';
import { printConfigCollectionDelimiter } from '../../settings/configSerialization';

interface SchemaDefinition {
  key: string;
  owner: string;
  storage: {
    serialization: { collectionDelimiter: ',' | ';' | null };
    shape: 'scalar' | 'vector';
  };
}

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

test('string-vector arrays use semicolons', () => {
  const parsed = parseConfigJson(
    JSON.stringify({
      config: { compatible_printers: ['Snapmaker U1', 'Elegoo CC'], filament_colour: ['#fff', '#000'] },
    }),
  );
  assert.strictEqual(parsed!.config.compatible_printers, 'Snapmaker U1;Elegoo CC');
  assert.strictEqual(parsed!.config.filament_colour, '#fff;#000');
});

test('numeric-vector arrays use commas', () => {
  const parsed = parseConfigJson(
    JSON.stringify({ config: { flush_volumes_matrix: [0, 140, 140, 0], nozzle_diameter: [0.4, 0.4] } }),
  );
  assert.strictEqual(parsed!.config.flush_volumes_matrix, '0,140,140,0');
  assert.strictEqual(parsed!.config.nozzle_diameter, '0.4,0.4');
});

test('the delimiter classifier covers every generated PrintConfig vector definition', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../../settings/generated/engine-options.schema.json', import.meta.url), 'utf8'),
  ) as { definitions: SchemaDefinition[] };
  const definitions = schema.definitions.filter(
    (definition) => definition.owner.startsWith('PrintConfigDef::') && definition.storage.shape === 'vector',
  );
  assert.ok(definitions.length > 0);
  for (const definition of definitions) {
    assert.strictEqual(
      printConfigCollectionDelimiter(definition.key),
      definition.storage.serialization.collectionDelimiter,
      `${definition.owner}:${definition.key}`,
    );
  }
});

test('invalid JSON returns null', () => {
  assert.strictEqual(parseConfigJson('{not json'), null);
});

test('empty object returns null', () => {
  assert.strictEqual(parseConfigJson('{}'), null);
});

console.log(`\nConfigIO: ${passed} tests passed.`);
