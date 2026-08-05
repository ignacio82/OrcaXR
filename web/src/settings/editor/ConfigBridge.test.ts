import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { ConfigMap } from '../../project/domain/model';
import { EngineOptionCatalog, parseEngineOptionSchema } from '../generated/loader';
import { applySettingsCommitToConfig, decodeSettingsConfig } from './configBridge';
import type { SettingsDraftCommit } from './types';

const schema = parseEngineOptionSchema(
  readFileSync(new URL('../generated/engine-options.schema.json', import.meta.url), 'utf8'),
);
const catalog = new EngineOptionCatalog(schema);

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('decodes generated engine wire values into typed editor values', () => {
  const source: ConfigMap = {
    layer_height: '0.24',
    wall_loops: '3',
    enable_support: '1',
    sparse_infill_density: '15%',
    compatible_printers: 'U1;Centauri Carbon',
    nozzle_diameter: [0.4, 0.6],
    orcaxr_internal_marker: 'preserve-me',
  };
  const decoded = decodeSettingsConfig(catalog, source);

  assert.equal(decoded.values.layer_height, 0.24);
  assert.equal(decoded.values.wall_loops, 3);
  assert.equal(decoded.values.enable_support, true);
  assert.equal(decoded.values.sparse_infill_density, 15);
  assert.deepEqual(decoded.values.compatible_printers, ['U1', 'Centauri Carbon']);
  assert.deepEqual(decoded.values.nozzle_diameter, [0.4, 0.6]);
  assert.deepEqual(decoded.unknownKeys, ['orcaxr_internal_marker']);
  assert.deepEqual(decoded.diagnostics, []);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.values.nozzle_diameter), true);
  assert.deepEqual(source.nozzle_diameter, [0.4, 0.6], 'decoding cannot mutate canonical config values');
});

test('fails closed for malformed or definition-ambiguous stored values', () => {
  const decoded = decodeSettingsConfig(catalog, {
    wall_loops: '4.2',
    layer_height: { unexpected: true },
  });

  assert.deepEqual(decoded.values, {});
  assert.deepEqual(
    decoded.diagnostics.map((diagnostic) => [diagnostic.key, diagnostic.code]),
    [
      ['layer_height', 'invalid-wire-value'],
      ['wall_loops', 'invalid-wire-value'],
    ],
  );
  assert.deepEqual(decoded.unknownKeys, []);
});

test('applies only validated wire changes while preserving opaque raw overrides', () => {
  const previous: ConfigMap = {
    layer_height: 0.2,
    unknown_plugin_key: { retained: [1, true, null] },
    special_generated_key: 'opaque;wire',
  };
  const commit: SettingsDraftCommit = {
    baseRevision: 0,
    revision: 1,
    nextOverrides: { layer_height: 0.12, enable_support: true },
    changes: [
      {
        fieldId: 'PrintConfigDef::layer_height',
        key: 'layer_height',
        owner: 'PrintConfigDef',
        action: 'set',
        previousValue: 0.2,
        value: 0.12,
        serialized: '0.12',
      },
      {
        fieldId: 'PrintConfigDef::enable_support',
        key: 'enable_support',
        owner: 'PrintConfigDef',
        action: 'set',
        value: true,
        serialized: '1',
      },
    ],
  };
  const next = applySettingsCommitToConfig(previous, commit);
  assert.deepEqual(next, {
    layer_height: '0.12',
    unknown_plugin_key: { retained: [1, true, null] },
    special_generated_key: 'opaque;wire',
    enable_support: '1',
  });
  assert.deepEqual(previous, {
    layer_height: 0.2,
    unknown_plugin_key: { retained: [1, true, null] },
    special_generated_key: 'opaque;wire',
  });

  const removed = applySettingsCommitToConfig(next, {
    baseRevision: 1,
    revision: 2,
    nextOverrides: { enable_support: true },
    changes: [
      {
        fieldId: 'PrintConfigDef::layer_height',
        key: 'layer_height',
        owner: 'PrintConfigDef',
        action: 'remove',
        previousValue: 0.12,
      },
    ],
  });
  assert.deepEqual(removed, {
    unknown_plugin_key: { retained: [1, true, null] },
    special_generated_key: 'opaque;wire',
    enable_support: '1',
  });
});

test('rejects malformed or duplicate raw changes without touching the source map', () => {
  const base: ConfigMap = { retained: 'yes' };
  const malformed = (changes: SettingsDraftCommit['changes']): SettingsDraftCommit => ({
    baseRevision: 0,
    revision: 1,
    nextOverrides: {},
    changes,
  });
  assert.throws(
    () =>
      applySettingsCommitToConfig(
        base,
        malformed([{ fieldId: 'x', key: 'x', owner: 'owner', action: 'set', value: 1 }]),
      ),
    /no serialized engine value/,
  );
  assert.throws(
    () =>
      applySettingsCommitToConfig(
        base,
        malformed([
          { fieldId: 'x', key: 'x', owner: 'owner', action: 'remove' },
          { fieldId: 'x2', key: 'x', owner: 'owner', action: 'remove' },
        ]),
      ),
    /more than once/,
  );
  assert.deepEqual(base, { retained: 'yes' });
});

console.log(`\nSettings config bridge: ${passed} tests passed.`);
