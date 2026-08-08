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
assert.deepEqual(schema.guiLayout.coverage, {
  ambiguousDefinitionKeys: [
    'chamber_temperature',
    'outer_wall_acceleration',
    'retract_lift_above',
    'retract_lift_below',
  ],
  definitionsWithoutLiteralPlacement: 395,
  dynamicPlacements: 26,
  exactDefinitionBindings: 420,
  groups: 93,
  literalPlacements: 424,
  projectConfigWrites: 3,
  specialWidgets: 4,
  tabs: 21,
  uniqueLiteralPlacementKeys: 417,
});
assert.deepEqual(
  Object.fromEntries(
    Object.entries(schema.guiLayout.semanticDispositions).map(([name, disposition]) => [name, disposition.status]),
  ),
  {
    dependencies: 'unresolved-unenforced',
    resetRules: 'unresolved-unenforced',
    scopes: 'unresolved-fail-closed',
  },
);

const catalog = new EngineOptionCatalog(schema);
assert.equal(catalog.get('layer_height').default.provided, true);
assert.equal(catalog.get('machine_start_gcode').presentation.multiline.value, true);
assert.equal(catalog.get('filament_retraction_length').storage.nullable, true);
assert.equal(catalog.get('machine_max_speed_x').presentation.fullLabel.value, 'Maximum speed X');
assert.equal(catalog.all('scale').length, 2);
assert.equal(catalog.guiTab(catalog.guiPlacements(catalog.get('layer_height'))[0].tabId).label, 'Quality');
assert.equal(catalog.guiGroup(catalog.guiPlacements(catalog.get('layer_height'))[0].groupId).label, 'Layer height');
assert.equal(catalog.hasCustomGuiWidget('printable_area'), true);
assert.equal(catalog.hasExactProjectConfigWrite('dithering_local_z_direct_multicolor'), true);
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

const incompleteAmbiguousBinding = JSON.parse(json) as {
  guiLayout: {
    placements: Array<{
      definitionBinding: { definitionIds: string[]; status: 'exact' | 'ambiguous' };
    }>;
  };
};
const ambiguousPlacement = incompleteAmbiguousBinding.guiLayout.placements.find(
  (placement) => placement.definitionBinding.status === 'ambiguous',
)!;
ambiguousPlacement.definitionBinding.definitionIds.splice(1);
ambiguousPlacement.definitionBinding.status = 'exact';
assert.throws(
  () => validateEngineOptionSchema(incompleteAmbiguousBinding),
  /must bind every definition owner in schema order/,
);

const truncatedLayout = JSON.parse(json) as {
  guiLayout: {
    coverage: {
      definitionsWithoutLiteralPlacement: number;
      exactDefinitionBindings: number;
      literalPlacements: number;
      uniqueLiteralPlacementKeys: number;
    };
    placements: Array<{ definitionBinding: { status: string }; optionKey: string }>;
  };
};
const removedIndex = truncatedLayout.guiLayout.placements.findIndex(
  (placement) => placement.optionKey === 'additional_cooling_fan_speed',
);
assert.notEqual(removedIndex, -1);
const [removedPlacement] = truncatedLayout.guiLayout.placements.splice(removedIndex, 1);
assert.equal(
  truncatedLayout.guiLayout.placements.some((placement) => placement.optionKey === removedPlacement.optionKey),
  false,
);
truncatedLayout.guiLayout.coverage.literalPlacements -= 1;
truncatedLayout.guiLayout.coverage.uniqueLiteralPlacementKeys -= 1;
truncatedLayout.guiLayout.coverage.definitionsWithoutLiteralPlacement += 1;
if (removedPlacement.definitionBinding.status === 'exact') {
  truncatedLayout.guiLayout.coverage.exactDefinitionBindings -= 1;
}
assert.throws(() => validateEngineOptionSchema(truncatedLayout), /literalPlacements/);

const falseFailClosedSemantics = JSON.parse(json) as {
  guiLayout: { semanticDispositions: { dependencies: { status: string } } };
};
falseFailClosedSemantics.guiLayout.semanticDispositions.dependencies.status = 'unresolved-fail-closed';
assert.throws(
  () => validateEngineOptionSchema(falseFailClosedSemantics),
  /semanticDispositions\.dependencies\.status/,
);

const relabelledPrinterSurface = JSON.parse(json) as {
  guiLayout: {
    tabs: Array<{ id: string; surface: string; symbol: string }>;
    groups: Array<{ tabId: string; surface: string }>;
    placements: Array<{ tabId: string; surface: string }>;
  };
};
const printerTab = relabelledPrinterSurface.guiLayout.tabs.find((tab) =>
  tab.symbol.startsWith('TabPrinter::'),
)!;
printerTab.surface = 'process';
for (const group of relabelledPrinterSurface.guiLayout.groups) {
  if (group.tabId === printerTab.id) group.surface = 'process';
}
for (const placement of relabelledPrinterSurface.guiLayout.placements) {
  if (placement.tabId === printerTab.id) placement.surface = 'process';
}
assert.throws(
  () => validateEngineOptionSchema(relabelledPrinterSurface),
  /guiLayout\.tabs\[\d+\]\.surface/,
);

process.stdout.write('engine-option runtime loader test passed\n');
