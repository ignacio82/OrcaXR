import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PINNED_PRESET_SEMANTICS,
  PresetGraph,
  PresetGraphError,
  presetId,
  type PresetCatalogInput,
  type PresetCompatibilityAssessment,
} from './PresetGraph';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fixture(): PresetCatalogInput {
  return {
    Vendor: {
      machine: [
        {
          type: 'machine',
          name: 'Machine 0.4',
          from: 'system',
          instantiation: 'true',
          nozzle_diameter: ['0.4', '0.4'],
          default_print_profile: 'Standard 0.4',
          default_filament_profile: ['PLA', 'PETG'],
          inherited_value: 'base',
        },
        {
          type: 'machine',
          name: 'My Machine',
          from: 'user',
          instantiation: 'true',
          inherits: 'Machine 0.4',
          inherited_value: 'child',
        },
      ],
      process: [
        {
          type: 'process',
          name: 'Process base',
          from: 'system',
          instantiation: 'false',
          compatible_printers: ['Machine 0.4'],
          nested: { preserved: true },
          layer_height: '0.2',
        },
        {
          type: 'process',
          name: 'Standard 0.4',
          from: 'system',
          instantiation: 'true',
          inherits: 'Process base',
          layer_height: '0.24',
        },
        {
          type: 'process',
          name: 'Wrong 0.6',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Machine 0.6'],
          layer_height: '0.3',
        },
      ],
      filament: [
        {
          type: 'filament',
          name: 'PLA base',
          from: 'system',
          instantiation: 'false',
          compatible_printers: ['Machine 0.4'],
          filament_type: ['PLA'],
        },
        {
          type: 'filament',
          name: 'PLA',
          from: 'system',
          instantiation: 'true',
          inherits: 'PLA base',
        },
        {
          type: 'filament',
          name: 'PETG',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Machine 0.4'],
          compatible_prints: ['Standard 0.4'],
          filament_type: ['PETG'],
        },
        {
          type: 'filament',
          name: 'Conditioned',
          from: 'system',
          instantiation: 'true',
          compatible_printers_condition: 'printer_model == "Machine"',
          filament_type: ['PLA'],
        },
        {
          type: 'filament',
          rules: { abrasive: ['hardened_steel'] },
        },
      ],
    },
  };
}

test('pins the exact compatibility source and builds immutable inherited payloads', () => {
  assert.equal(PINNED_PRESET_SEMANTICS.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  assert.equal(PINNED_PRESET_SEMANTICS.files.preset.blob, '3646369750323d80880bc65ab4fa6be7eb3d4cdc');
  const input = fixture() as Record<string, any>;
  const graph = PresetGraph.build(input);
  const process = graph.find('Vendor', 'process', 'Standard 0.4')!;
  assert.equal(process.parentId, presetId('Vendor', 'process', 'Process base'));
  assert.equal(process.effective.layer_height, '0.24');
  assert.deepEqual(process.effective.compatible_printers, ['Machine 0.4']);
  assert.deepEqual(process.effective.nested, { preserved: true });
  assert.equal(Object.isFrozen(process), true);
  assert.equal(Object.isFrozen(process.raw), true);
  assert.equal(Object.isFrozen(process.effective.nested), true);
  assert.equal(graph.auxiliaryPayloads.length, 1);
  assert.deepEqual(graph.auxiliaryPayloads[0].raw.rules, { abrasive: ['hardened_steel'] });

  input.Vendor.process[0].compatible_printers[0] = 'mutated';
  input.Vendor.process[0].nested.preserved = false;
  assert.deepEqual(process.effective.compatible_printers, ['Machine 0.4']);
  assert.deepEqual(process.effective.nested, { preserved: true });
});

test('fails closed on missing, ambiguous, cyclic, duplicate, and malformed inheritance inputs', () => {
  const issueCodes = (input: unknown) => {
    try {
      PresetGraph.build(input);
      assert.fail('expected PresetGraphError');
    } catch (error) {
      assert.ok(error instanceof PresetGraphError);
      return error.issues.map((issue) => issue.code);
    }
  };

  assert.ok(
    issueCodes({
      V: { process: [{ type: 'process', name: 'Child', inherits: 'Missing' }] },
    }).includes('missing-parent'),
  );
  assert.ok(
    issueCodes({
      V: {
        process: [
          { type: 'process', name: 'A', inherits: 'B' },
          { type: 'process', name: 'B', inherits: 'A' },
        ],
      },
    }).includes('inheritance-cycle'),
  );
  assert.ok(
    issueCodes({
      V: {
        process: [
          { type: 'process', name: 'Same' },
          { type: 'process', name: 'Same' },
        ],
      },
    }).includes('duplicate-profile'),
  );
  assert.ok(
    issueCodes({
      A: { process: [{ type: 'process', name: 'Base' }] },
      B: { process: [{ type: 'process', name: 'Base' }] },
      C: { process: [{ type: 'process', name: 'Child', inherits: 'Base' }] },
    }).includes('ambiguous-parent'),
  );
  assert.ok(
    issueCodes({
      V: { process: [{ type: 'process', name: 'Broken', compatible_printers: 'Machine' }] },
    }).includes('invalid-profile'),
  );
});

test('matches pinned explicit-list precedence and direct-parent compatibility semantics', () => {
  const graph = PresetGraph.build(fixture());
  const machine = graph.find('Vendor', 'machine', 'Machine 0.4')!;
  const userMachine = graph.find('Vendor', 'machine', 'My Machine')!;
  const standard = graph.find('Vendor', 'process', 'Standard 0.4')!;
  const wrong = graph.find('Vendor', 'process', 'Wrong 0.6')!;
  const pla = graph.find('Vendor', 'filament', 'PLA')!;
  const petg = graph.find('Vendor', 'filament', 'PETG')!;

  assert.deepEqual(graph.assessPrinterCompatibility(standard.id, machine.id), {
    status: 'compatible',
    reason: 'explicit-name',
  });
  assert.deepEqual(graph.assessPrinterCompatibility(standard.id, userMachine.id), {
    status: 'compatible',
    reason: 'direct-parent-name',
  });
  assert.deepEqual(graph.assessPrinterCompatibility(wrong.id, machine.id), {
    status: 'incompatible',
    reason: 'explicit-list-miss',
  });
  assert.deepEqual(graph.assessPrintCompatibility(petg.id, standard.id, machine.id), {
    status: 'compatible',
    reason: 'explicit-name',
  });
  assert.deepEqual(graph.assessPrintCompatibility(pla.id, standard.id, machine.id), {
    status: 'compatible',
    reason: 'implicit-all',
  });
});

test('fails unresolved conditions closed and passes exact condition context to an injected evaluator', () => {
  const graph = PresetGraph.build(fixture());
  const machine = graph.find('Vendor', 'machine', 'Machine 0.4')!;
  const conditioned = graph.find('Vendor', 'filament', 'Conditioned')!;
  const unresolved = graph.assessPrinterCompatibility(conditioned.id, machine.id);
  assert.deepEqual(unresolved, {
    status: 'unresolved',
    reason: 'condition-evaluator-missing',
    expression: 'printer_model == "Machine"',
  });

  let contextExtruders = 0;
  const accepted = graph.assessPrinterCompatibility(conditioned.id, machine.id, (expression, context) => {
    assert.equal(expression, 'printer_model == "Machine"');
    assert.equal(context.extraConfig.printerPreset, 'Machine 0.4');
    contextExtruders = context.extraConfig.numExtruders ?? 0;
    return true;
  });
  assert.equal(contextExtruders, 2);
  assert.deepEqual(accepted, {
    status: 'compatible',
    reason: 'condition-true',
    expression: 'printer_model == "Machine"',
  });
  const failed = graph.assessPrinterCompatibility(conditioned.id, machine.id, () => {
    throw new Error('parser failed');
  });
  assert.equal(failed.status, 'unresolved');
  assert.equal(failed.reason, 'condition-evaluation-failed');
});

test('preserves compatible selections and deterministically substitutes printer defaults per slot', () => {
  const graph = PresetGraph.build(fixture());
  const machine = graph.find('Vendor', 'machine', 'Machine 0.4')!;
  const standard = graph.find('Vendor', 'process', 'Standard 0.4')!;
  const wrong = graph.find('Vendor', 'process', 'Wrong 0.6')!;
  const pla = graph.find('Vendor', 'filament', 'PLA')!;
  const petg = graph.find('Vendor', 'filament', 'PETG')!;

  const preserved = graph.resolveSelection({
    printerId: machine.id,
    processId: standard.id,
    filamentIds: [pla.id, petg.id],
    installedVendors: ['Vendor'],
  });
  assert.equal(preserved.process?.id, standard.id);
  assert.deepEqual(
    preserved.filaments.map((filament) => filament?.id),
    [pla.id, petg.id],
  );
  assert.equal(preserved.substitutions.length, 0);
  assert.equal(preserved.complete, true);

  const replaced = graph.resolveSelection({
    printerId: machine.id,
    processId: wrong.id,
    filamentIds: [undefined, undefined],
    installedVendors: ['Vendor'],
  });
  assert.equal(replaced.process?.id, standard.id);
  assert.deepEqual(
    replaced.filaments.map((filament) => filament?.name),
    ['PLA', 'PETG'],
  );
  assert.deepEqual(
    replaced.substitutions.map((substitution) => [
      substitution.kind,
      substitution.slot,
      substitution.reason,
      substitution.nextId,
    ]),
    [
      ['process', undefined, 'incompatible', standard.id],
      ['filament', 0, 'missing', pla.id],
      ['filament', 1, 'missing', petg.id],
    ],
  );
  assert.equal(Object.isFrozen(replaced), true);
  assert.equal(Object.isFrozen(replaced.filaments), true);
});

test('unrequested tool slots inherit the chosen filament instead of an unrelated material', () => {
  // A four-tool printer that names only one default filament. Orca fills the
  // extra extruders with the active preset; picking the catalog's first
  // compatible preset instead would pair PETG with PLA, which the engine
  // refuses to slice on temperature grounds.
  const input = fixture() as unknown as Record<string, { machine: Record<string, unknown>[] }>;
  input.Vendor.machine[0].nozzle_diameter = ['0.4', '0.4', '0.4', '0.4'];
  input.Vendor.machine[0].default_filament_profile = ['PLA'];
  const graph = PresetGraph.build(input as unknown as PresetCatalogInput);
  const machine = graph.find('Vendor', 'machine', 'Machine 0.4')!;
  const standard = graph.find('Vendor', 'process', 'Standard 0.4')!;
  const pla = graph.find('Vendor', 'filament', 'PLA')!;
  const petg = graph.find('Vendor', 'filament', 'PETG')!;

  const inherited = graph.resolveSelection({
    printerId: machine.id,
    processId: standard.id,
    filamentIds: [petg.id],
    installedVendors: ['Vendor'],
  });
  assert.deepEqual(
    inherited.filaments.map((filament) => filament?.id),
    [petg.id, petg.id, petg.id, petg.id],
  );
  assert.deepEqual(
    inherited.substitutions.map((substitution) => [substitution.slot, substitution.reason]),
    [
      [1, 'missing'],
      [2, 'missing'],
      [3, 'missing'],
    ],
  );

  // With nothing requested at all, every slot still lands on the printer's own
  // declared default rather than drifting apart.
  const defaults = graph.resolveSelection({
    printerId: machine.id,
    processId: standard.id,
    installedVendors: ['Vendor'],
  });
  assert.deepEqual(
    defaults.filaments.map((filament) => filament?.id),
    [pla.id, pla.id, pla.id, pla.id],
  );
});

test('proves the live bundled corpus contains name-heuristic false positives that exact lists reject', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../../../public/profiles/catalog.json', import.meta.url), 'utf8'),
  ) as unknown;
  const graph = PresetGraph.build(catalog);
  const u104 = graph.find('Snapmaker', 'machine', 'Snapmaker U1 (0.4 nozzle)')!;
  const u106 = graph.find('Snapmaker', 'machine', 'Snapmaker U1 (0.6 nozzle)')!;
  const wrongNameHeuristic = graph.find('Snapmaker', 'process', '0.40 Standard @Snapmaker U1 (0.8 nozzle)')!;
  const compatible04 = graph.compatibleProcesses(u104.id, { installedVendors: ['Snapmaker'] });
  const compatible06Filaments = graph.compatibleFilaments(
    u106.id,
    graph.find('Snapmaker', 'process', '0.30 Standard @Snapmaker U1 (0.6 nozzle)')!.id,
    { installedVendors: ['Snapmaker'] },
  );

  assert.equal(wrongNameHeuristic.name.includes('0.4'), true, 'the current substring heuristic accepts this');
  assert.equal(
    graph.assessPrinterCompatibility(wrongNameHeuristic.id, u104.id).status,
    'incompatible',
    'the pinned compatible_printers list rejects it',
  );
  assert.equal(
    compatible04.some((candidate) => candidate.id === wrongNameHeuristic.id),
    false,
  );
  assert.deepEqual(
    compatible06Filaments.map((candidate) => candidate.name),
    [],
    'the pinned corpus explicitly limits these generic presets to the 0.4 mm U1',
  );
  assert.equal(graph.auxiliaryPayloads.length, 1);
});

test('condition assessments remain a closed discriminated contract', () => {
  const assessment: PresetCompatibilityAssessment = {
    status: 'unresolved',
    reason: 'condition-evaluator-missing',
    expression: 'future expression',
  };
  assert.equal(assessment.status, 'unresolved');
});

console.log(`\n${passed} canonical preset graph tests passed.`);
