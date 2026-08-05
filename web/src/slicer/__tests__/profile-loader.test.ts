import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { presetId } from '../../settings/presets/PresetGraph';
import { ProfileCatalog, ProfileCatalogLoadError } from '../ProfileLoader';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const bundledCatalog = JSON.parse(
  readFileSync(new URL('../../../public/profiles/catalog.json', import.meta.url), 'utf8'),
) as unknown;

test('compiles only compatible bundled triples and keeps legacy profile IDs stable', () => {
  const catalog = ProfileCatalog.fromRaw(bundledCatalog);
  assert.equal(catalog.profiles.length, 694);
  assert.equal(catalog.provenance.profileCorpus, 'pinned-v2.3.4-overlay-with-locked-adaptations');
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.code === 'profile-corpus-pinned-overlay'));

  const selected = catalog.find('Snapmaker U1 (0.4 nozzle)', '0.20 Standard', 'Snapmaker PLA');
  assert.ok(selected);
  assert.equal(selected.id, 'Snapmaker U1 (0.4 nozzle)|0.20 Standard @Snapmaker U1 (0.4 nozzle)|Snapmaker PLA @U1');
  assert.equal(selected.filamentName, 'Snapmaker PLA');
  assert.equal(selected.filamentPresetName, 'Snapmaker PLA @U1');
  assert.ok(selected.machinePresetId);
  assert.ok(selected.processPresetId);
  assert.ok(selected.filamentPresetId);

  const reordered = JSON.parse(JSON.stringify(bundledCatalog)) as Record<
    string,
    { machine: unknown[]; process: unknown[]; filament: unknown[] }
  >;
  for (const group of Object.values(reordered)) {
    group.machine.reverse();
    group.process.reverse();
    group.filament.reverse();
  }
  const afterReorder = ProfileCatalog.fromRaw(reordered).find(
    'Snapmaker U1 (0.4 nozzle)',
    '0.20 Standard',
    'Snapmaker PLA',
  );
  assert.equal(afterReorder?.id, selected.id);
  assert.equal(afterReorder?.machinePresetId, selected.machinePresetId);
  assert.equal(afterReorder?.processPresetId, selected.processPresetId);
  assert.equal(afterReorder?.filamentPresetId, selected.filamentPresetId);
});

test('removes name-substring false positives and incompatible filament exposure', () => {
  const catalog = ProfileCatalog.fromRaw(bundledCatalog);
  assert.equal(
    catalog.profiles.some(
      (profile) =>
        profile.machineName === 'Snapmaker U1 (0.4 nozzle)' &&
        profile.processName === '0.40 Standard @Snapmaker U1 (0.8 nozzle)',
    ),
    false,
  );
  const u106 = catalog.profiles.filter((profile) => profile.machineName === 'Snapmaker U1 (0.6 nozzle)');
  assert.deepEqual([...new Set(u106.map((profile) => profile.filamentName))], []);
  assert.equal(catalog.find('Snapmaker U1 (0.6 nozzle)', '0.30 Standard', 'Snapmaker PLA'), null);
  assert.match(
    catalog.explainUnavailable('Snapmaker U1 (0.6 nozzle)', '0.30 Standard', 'Snapmaker PLA') ?? '',
    /not compatible/,
  );
});

test('fails incomplete machines closed and emits actionable corpus diagnostics', () => {
  const catalog = ProfileCatalog.fromRaw(bundledCatalog);
  assert.equal(
    catalog.profiles.some((profile) => profile.machineName === 'Snapmaker U1 (0.2 nozzle)'),
    false,
  );
  const diagnostics = catalog.diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === 'no-compatible-filament' && diagnostic.machineName === 'Snapmaker U1 (0.2 nozzle)',
  );
  assert.equal(diagnostics.length, 8);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === 'error'));
  assert.ok(diagnostics.every((diagnostic) => diagnostic.message.includes('no visible compatible filament')));
  assert.match(
    catalog.explainUnavailable('Snapmaker U1 (0.2 nozzle)', '0.10 Standard', 'Snapmaker PLA') ?? '',
    /Unknown filament profile|not compatible/,
  );
});

test('applies validated replacements atomically and preserves the prior catalog after graph failure', () => {
  const catalog = ProfileCatalog.fromRaw({
    V: {
      machine: [
        {
          type: 'machine',
          name: 'Printer',
          from: 'system',
          instantiation: 'true',
          default_print_profile: 'Process',
          default_filament_profile: ['PLA'],
          nozzle_diameter: ['0.4'],
        },
      ],
      process: [
        {
          type: 'process',
          name: 'Process',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer'],
          layer_height: '0.2',
        },
      ],
      filament: [
        {
          type: 'filament',
          name: 'PLA',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer'],
          filament_type: ['PLA'],
        },
      ],
    },
  });
  const before = catalog.profiles;
  assert.equal(before.length, 1);

  assert.throws(
    () =>
      catalog.replaceFromRaw({
        V: {
          process: [
            { type: 'process', name: 'A', inherits: 'B' },
            { type: 'process', name: 'B', inherits: 'A' },
          ],
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProfileCatalogLoadError);
      assert.ok(error.diagnostics.some((diagnostic) => diagnostic.message.includes('inheritance cycle')));
      return true;
    },
  );
  assert.equal(catalog.profiles, before);
  assert.equal(catalog.find('Printer', 'Process', 'PLA')?.id, 'Printer|Process|PLA');
});

test('does not expose condition-based candidates without the pinned engine evaluator', () => {
  const catalog = ProfileCatalog.fromRaw({
    V: {
      machine: [
        {
          type: 'machine',
          name: 'Printer',
          from: 'system',
          instantiation: 'true',
          nozzle_diameter: ['0.4'],
        },
      ],
      process: [
        {
          type: 'process',
          name: 'Conditional process',
          from: 'system',
          instantiation: 'true',
          compatible_printers_condition: 'printer_model == "Printer"',
        },
      ],
      filament: [
        {
          type: 'filament',
          name: 'PLA',
          from: 'system',
          instantiation: 'true',
        },
      ],
    },
  });
  assert.equal(catalog.profiles.length, 0);
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.code === 'unresolved-compatibility'));
  assert.ok(catalog.diagnostics.some((diagnostic) => diagnostic.code === 'no-compatible-process'));
  assert.match(catalog.explainUnavailable('Printer', 'Conditional process', 'PLA') ?? '', /not compatible/);
});

test('reconciles printer, process, and every filament slot while preserving compatible identities', () => {
  const catalog = ProfileCatalog.fromRaw({
    V: {
      machine: [
        {
          type: 'machine',
          name: 'Printer A',
          from: 'system',
          instantiation: 'true',
          nozzle_diameter: ['0.4', '0.4'],
          default_print_profile: 'A Standard',
          default_filament_profile: ['PLA', 'PETG'],
        },
        {
          type: 'machine',
          name: 'Printer B',
          from: 'system',
          instantiation: 'true',
          nozzle_diameter: ['0.4', '0.4'],
          default_print_profile: 'B Standard',
          default_filament_profile: ['PLA', 'ABS'],
        },
        {
          type: 'machine',
          name: 'Printer C',
          from: 'system',
          instantiation: 'true',
          nozzle_diameter: ['0.4'],
        },
      ],
      process: [
        {
          type: 'process',
          name: 'Shared',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer A', 'Printer B'],
          layer_height: '0.2',
        },
        {
          type: 'process',
          name: 'A Standard',
          alias: 'standard',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer A'],
          layer_height: '0.2',
        },
        {
          type: 'process',
          name: 'B Standard',
          alias: 'standard',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer B'],
          layer_height: '0.2',
        },
      ],
      filament: [
        {
          type: 'filament',
          name: 'PLA',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer A', 'Printer B'],
          filament_type: ['PLA'],
        },
        {
          type: 'filament',
          name: 'PETG',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer A', 'Printer B'],
          filament_type: ['PETG'],
        },
        {
          type: 'filament',
          name: 'ABS',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer B'],
          filament_type: ['ABS'],
        },
        {
          type: 'filament',
          name: 'TPU',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Printer A'],
          filament_type: ['TPU'],
        },
      ],
    },
  });
  const sharedPla = catalog.find('Printer A', 'Shared', 'PLA')!;
  const sharedPetg = catalog.find('Printer A', 'Shared', 'PETG')!;
  const printerB = catalog.find('Printer B', 'Shared', 'PLA')!;
  assert.ok(sharedPla.machinePresetId && sharedPla.processPresetId && sharedPla.filamentPresetId);
  assert.ok(sharedPetg.filamentPresetId && printerB.machinePresetId);

  const preserved = catalog.reconcileSelection({
    printerId: printerB.machinePresetId,
    processId: sharedPla.processPresetId,
    filamentIds: [sharedPla.filamentPresetId, sharedPetg.filamentPresetId],
  }).selection;
  assert.ok(preserved?.complete);
  assert.equal(preserved.process?.name, 'Shared');
  assert.deepEqual(
    preserved.filaments.map((filament) => filament?.name),
    ['PLA', 'PETG'],
  );
  assert.deepEqual(preserved.substitutions, []);

  const aStandardTpu = catalog.find('Printer A', 'A Standard', 'TPU')!;
  const aStandardPla = catalog.find('Printer A', 'A Standard', 'PLA')!;
  assert.ok(aStandardTpu.processPresetId && aStandardTpu.filamentPresetId && aStandardPla.filamentPresetId);
  const substituted = catalog.reconcileSelection({
    printerId: printerB.machinePresetId,
    processId: aStandardTpu.processPresetId,
    filamentIds: [aStandardPla.filamentPresetId, aStandardTpu.filamentPresetId],
  }).selection;
  assert.ok(substituted?.complete);
  assert.equal(substituted.process?.name, 'B Standard');
  assert.equal(substituted.filaments[0]?.name, 'PLA');
  assert.equal(substituted.filaments[1]?.name, 'ABS');
  assert.ok(substituted.substitutions.some((entry) => entry.kind === 'process' && entry.reason === 'incompatible'));
  assert.ok(
    substituted.substitutions.some(
      (entry) => entry.kind === 'filament' && entry.slot === 1 && entry.reason === 'incompatible',
    ),
  );

  const incomplete = catalog.reconcileSelection({
    printerId: presetId('V', 'machine', 'Printer C'),
  }).selection;
  assert.equal(incomplete?.complete, false);
  assert.ok(incomplete?.diagnostics.some((diagnostic) => diagnostic.code === 'no-compatible-process'));

  const unknown = catalog.reconcileSelection({
    printerId: 'preset:V:machine:Missing' as typeof printerB.machinePresetId,
  });
  assert.equal(unknown.selection, undefined);
  assert.match(unknown.unavailableReason ?? '', /no longer available/);
});

console.log(`\n${passed} compatibility-filtered profile catalog tests passed.`);
