import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EngineOptionCatalog,
  loadEngineOptionSchema,
  parseEngineOptionSchema,
  validateEngineOptionSchema,
} from './loader';

const schemaUrl = new URL('./engine-options.schema.json', import.meta.url);
const json = readFileSync(schemaUrl, 'utf8');
const schema = parseEngineOptionSchema(json);
assert.equal(schema.coverage.definitions, 816);
assert.equal(schema.coverage.uniqueKeys, 809);
assert.equal(schema.coverage.derivedAxisDefinitions, 12);
assert.equal(schema.coverage.derivedNullableDefinitions, 18);

const catalog = new EngineOptionCatalog(schema);
assert.equal(catalog.get('layer_height').default.provided, true);
assert.equal(catalog.get('machine_start_gcode').presentation.multiline.value, true);
assert.equal(catalog.get('filament_retraction_length').storage.nullable, true);
assert.equal(catalog.get('machine_max_speed_x').presentation.fullLabel.value, 'Maximum speed X');
assert.equal(catalog.all('scale').length, 2);
assert.throws(() => catalog.get('scale'), /Ambiguous engine option/);
assert.equal(catalog.get('scale', 'CLITransformConfigDef::CLITransformConfigDef').storage.optionType, 'coFloat');
assert.throws(() => catalog.get('not_a_real_engine_option'), /Unknown engine option/);

const loaded = await loadEngineOptionSchema('memory:engine-options', async () => new Response(json, { status: 200 }));
assert.equal(loaded.source.commit, schema.source.commit);
await assert.rejects(
  loadEngineOptionSchema(
    'memory:missing',
    async () => new Response('missing', { status: 404, statusText: 'Not Found' }),
  ),
  /HTTP 404 Not Found/,
);

const wrongCommit = JSON.parse(json) as { source: { commit: string } };
wrongCommit.source.commit = '0000000000000000000000000000000000000000';
assert.throws(() => validateEngineOptionSchema(wrongCommit), /source\.commit/);

const wrongCount = JSON.parse(json) as { coverage: { definitions: number } };
wrongCount.coverage.definitions -= 1;
assert.throws(() => validateEngineOptionSchema(wrongCount), /coverage\.definitions/);

const unknownDefinitionField = JSON.parse(json) as { definitions: Array<Record<string, unknown>> };
unknownDefinitionField.definitions[0].futureSyntax = true;
assert.throws(() => validateEngineOptionSchema(unknownDefinitionField), /futureSyntax.*unknown field/);

const unresolvedMetadata = JSON.parse(json) as {
  definitions: Array<{ presentation: { label: { resolved: boolean } } }>;
};
unresolvedMetadata.definitions[0].presentation.label.resolved = false;
assert.throws(() => validateEngineOptionSchema(unresolvedMetadata), /presentation\.label\.resolved/);

process.stdout.write('engine-option runtime loader test passed\n');
