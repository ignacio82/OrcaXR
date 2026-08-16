import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PINNED_PRESET_SEMANTICS, PresetGraph, type PresetCatalogInput } from './PresetGraph';
import {
  CUSTOM_PRESET_VENDOR,
  PRESET_BUNDLE_FORMAT,
  PRESET_LIBRARY_SCHEMA_VERSION,
  PresetLibrary,
  PresetLibraryStore,
  applyPresetLibraryOperation,
  coerceOverrideValue,
  emptyPresetLibraryState,
  formatOverrideValue,
  stableStringify,
  type PresetLibraryIssueCode,
  type PresetLibraryKeyValueStorage,
  type PresetLibraryResult,
} from './PresetLibrary';
import { ProfileCatalog } from '../../slicer/ProfileLoader';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const CLOCK = { now: () => '2026-08-16T00:00:00.000Z' };

function codes(result: { readonly issues: readonly { readonly code: PresetLibraryIssueCode }[] }): string[] {
  return result.issues.map((issue) => issue.code);
}

/**
 * Shaped like the real corpus in the ways that matter: model names contain
 * spaces, nozzle variants inherit from a sibling variant rather than from a
 * common root, and non-instantiable templates carry no model at all.
 */
function fixture(): PresetCatalogInput {
  return {
    Acme: {
      machine: [
        { type: 'machine', name: 'fdm_acme_common', from: 'system', instantiation: 'false', nozzle_diameter: ['0.4'] },
        {
          type: 'machine',
          name: 'Acme Big Printer 0.4 nozzle',
          from: 'system',
          instantiation: 'true',
          inherits: 'fdm_acme_common',
          printer_model: 'Acme Big Printer',
          printer_variant: '0.4',
          nozzle_diameter: ['0.4'],
          printable_area: ['0x0', '220x0', '220x220', '0x220'],
        },
        {
          type: 'machine',
          name: 'Acme Big Printer 0.2 nozzle',
          from: 'system',
          instantiation: 'true',
          inherits: 'Acme Big Printer 0.4 nozzle',
          printer_model: 'Acme Big Printer',
          printer_variant: '0.2',
          nozzle_diameter: ['0.2'],
        },
        {
          type: 'machine',
          name: 'Acme Small Printer 0.4 nozzle',
          from: 'system',
          instantiation: 'true',
          inherits: 'fdm_acme_common',
          printer_model: 'Acme Small Printer',
          printer_variant: '0.4',
          nozzle_diameter: ['0.4'],
        },
      ],
      process: [
        {
          type: 'process',
          name: 'Standard @Acme Big',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Acme Big Printer 0.4 nozzle'],
          layer_height: '0.2',
          sparse_infill_density: '15%',
        },
        {
          type: 'process',
          name: 'Standard @Acme Small',
          from: 'system',
          instantiation: 'true',
          compatible_printers: ['Acme Small Printer 0.4 nozzle'],
          layer_height: '0.2',
        },
      ],
      filament: [
        {
          type: 'filament',
          name: 'Acme PLA',
          from: 'system',
          instantiation: 'true',
          filament_type: ['PLA'],
          nozzle_temperature: ['210'],
        },
      ],
    },
  };
}

function library(state?: unknown): PresetLibrary {
  const created = PresetLibrary.create(fixture(), { clock: CLOCK, ...(state === undefined ? {} : { state }) });
  assert.deepEqual(created.issues, []);
  return created.library;
}

function ok(result: PresetLibraryResult, what: string): void {
  assert.equal(result.ok, true, `${what}: ${result.issues.map((issue) => issue.message).join('; ')}`);
}

test('a clean library installs nothing and hides nothing', () => {
  const lib = library();
  assert.equal(lib.isConfigured(), false);
  assert.deepEqual(lib.state, emptyPresetLibraryState(lib.catalogFingerprint));

  const inventory = lib.inventory();
  assert.deepEqual(inventory.vendors, ['Acme']);
  assert.deepEqual(
    inventory.models.map((model) => `${model.model}: ${model.variants.map((v) => v.variant).join(',')}`),
    ['Acme Big Printer: 0.2,0.4', 'Acme Small Printer: 0.4'],
    'variants sort numerically, and a multi-word model name survives the round trip',
  );
  assert.equal(
    inventory.models.every((model) => !model.installed && model.variants.every((variant) => !variant.installed)),
    true,
  );
  assert.equal(inventory.models[0].variants[0].nozzleDiameter, 0.2);

  // Before setup, every printer the catalog ships stays selectable: an
  // unconfigured build must still slice rather than present an empty picker.
  assert.deepEqual(
    lib
      .graph()
      .selectable('machine')
      .map((node) => node.name),
    ['Acme Big Printer 0.2 nozzle', 'Acme Big Printer 0.4 nozzle', 'Acme Small Printer 0.4 nozzle'],
  );
});

test('installing one nozzle hides its siblings without breaking their inheritance', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.2']), 'install 0.2');

  assert.equal(lib.isConfigured(), true);
  assert.deepEqual(lib.state.installed, [{ vendor: 'Acme', model: 'Acme Big Printer', variants: ['0.2'] }]);
  assert.deepEqual(
    lib
      .graph()
      .selectable('machine')
      .map((node) => node.name),
    ['Acme Big Printer 0.2 nozzle'],
  );

  // The 0.4 preset is the 0.2's parent. Hiding it must not remove it, or the
  // installed printer would lose the bed it inherits.
  const hidden = lib.graph().find('Acme', 'machine', 'Acme Big Printer 0.4 nozzle');
  assert.equal(hidden?.isVisible, false, 'the sibling is hidden');
  assert.equal(
    lib.graph().find('Acme', 'machine', 'Acme Big Printer 0.2 nozzle')?.effective.printable_area !== undefined,
    true,
    'the installed printer still inherits through its hidden parent',
  );

  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.2', '0.4']), 'add 0.4');
  assert.deepEqual(lib.state.installed[0].variants, ['0.2', '0.4']);
});

test('an unknown model or nozzle is refused, and the refusal says what exists', () => {
  const lib = library();
  const before = stableStringify(lib.state as never);

  const unknownModel = lib.installPrinter('Acme', 'Acme Imaginary Printer', ['0.4']);
  assert.equal(unknownModel.ok, false);
  assert.deepEqual(codes(unknownModel), ['unknown-printer-model']);

  const unknownVariant = lib.installPrinter('Acme', 'Acme Big Printer', ['0.9']);
  assert.equal(unknownVariant.ok, false);
  assert.deepEqual(codes(unknownVariant), ['unknown-printer-variant']);
  assert.match(unknownVariant.issues[0].message, /available: 0\.2, 0\.4/);

  assert.equal(stableStringify(lib.state as never), before, 'a rejected install leaves the state byte-identical');
});

test('a custom printer overlays a system base and keeps its compatibility', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install base');
  ok(
    lib.createCustomPreset({
      kind: 'machine',
      name: 'Shop Floor Big',
      inherits: 'Acme Big Printer 0.4 nozzle',
      overrides: { printable_area: ['0x0', '200x0', '200x200', '0x200'] },
      license: 'CC BY 4.0',
      version: '2.1.0',
      note: 'shorter bed after the enclosure went in',
    }),
    'create custom printer',
  );

  const custom = lib.graph().find(CUSTOM_PRESET_VENDOR, 'machine', 'Shop Floor Big');
  assert.ok(custom, 'the custom preset is in the composed graph');
  assert.equal(custom.isSystem, false);
  assert.equal(custom.isVisible, true);
  assert.deepEqual(custom.effective.nozzle_diameter, ['0.4'], 'inherited from the base');
  assert.deepEqual(custom.effective.printable_area, ['0x0', '200x0', '200x200', '0x200'], 'overridden');

  // The payoff of storing an overlay rather than a flattened config: the
  // process names the *base* printer, and upstream's direct-parent-name rule
  // (Preset.cpp:639-717) carries that compatibility to the derived printer.
  const process = lib.graph().find('Acme', 'process', 'Standard @Acme Big');
  assert.ok(process);
  assert.equal(lib.graph().assessPrinterCompatibility(process.id, custom.id).reason, 'direct-parent-name');
  assert.deepEqual(
    lib
      .graph()
      .compatibleProcesses(custom.id)
      .map((node) => node.name),
    ['Standard @Acme Big'],
  );

  const record = lib.customPresets('machine')[0];
  assert.deepEqual(record.provenance, {
    source: 'user-derived',
    license: 'CC BY 4.0',
    version: '2.1.0',
    derivedFrom: { vendor: 'Acme', kind: 'machine', name: 'Acme Big Printer 0.4 nozzle' },
    createdAt: CLOCK.now(),
    updatedAt: CLOCK.now(),
    note: 'shorter bed after the enclosure went in',
  });
});

test('a custom filament derives only from a base the operator can select', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install');

  assert.deepEqual(
    lib.basePresetsFor('filament').map((node) => node.name),
    ['Acme PLA'],
  );

  ok(
    lib.createCustomPreset({
      kind: 'filament',
      name: 'Acme PLA — dry box',
      inherits: 'Acme PLA',
      overrides: { nozzle_temperature: ['215'] },
    }),
    'create custom filament',
  );
  const custom = lib.graph().find(CUSTOM_PRESET_VENDOR, 'filament', 'Acme PLA — dry box');
  assert.deepEqual(custom?.effective.filament_type, ['PLA'], 'type inherited');
  assert.deepEqual(custom?.effective.nozzle_temperature, ['215'], 'temperature overridden');

  const hiddenBase = lib.createCustomPreset({ kind: 'machine', name: 'From Template', inherits: 'fdm_acme_common' });
  assert.equal(hiddenBase.ok, false);
  assert.deepEqual(codes(hiddenBase), ['base-not-instantiable']);
});

test('bases are judged against the printer the operator has selected', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install big');
  ok(lib.installPrinter('Acme', 'Acme Small Printer', ['0.4']), 'install small');

  const big = lib.graph().find('Acme', 'machine', 'Acme Big Printer 0.4 nozzle');
  const small = lib.graph().find('Acme', 'machine', 'Acme Small Printer 0.4 nozzle');
  assert.ok(big && small);

  // Without a printer, everything visible is on offer. With one, only what
  // that printer can select — otherwise someone derives a preset the machine
  // they just installed can never use, and finds out at slice time.
  assert.deepEqual(
    lib.basePresetsFor('process').map((node) => node.name),
    ['Standard @Acme Big', 'Standard @Acme Small'],
  );
  assert.deepEqual(
    lib.basePresetsFor('process', { printerId: big.id }).map((node) => node.name),
    ['Standard @Acme Big'],
  );
  assert.deepEqual(
    lib.basePresetsFor('process', { printerId: small.id }).map((node) => node.name),
    ['Standard @Acme Small'],
  );

  const bigProcess = lib.graph().find('Acme', 'process', 'Standard @Acme Big');
  assert.ok(bigProcess);
  assert.deepEqual(
    lib.basePresetsFor('filament', { printerId: big.id, processId: bigProcess.id }).map((node) => node.name),
    ['Acme PLA'],
  );
  assert.deepEqual(
    lib.basePresetsFor('machine', { printerId: big.id }).map((node) => node.name),
    ['Acme Big Printer 0.4 nozzle', 'Acme Small Printer 0.4 nozzle'],
    'a printer is not judged against itself',
  );

  // A selection that has gone stale must not narrow the list to nothing.
  const stale = 'preset:Acme:machine:Gone' as typeof big.id;
  assert.deepEqual(
    lib.basePresetsFor('process', { printerId: stale }).map((node) => node.name),
    ['Standard @Acme Big', 'Standard @Acme Small'],
  );
});

test('overrides may not rewrite identity, invent keys, or carry non-finite numbers', () => {
  const lib = library();
  const reserved = lib.createCustomPreset({
    kind: 'process',
    name: 'Sneaky',
    inherits: 'Standard @Acme Big',
    overrides: { inherits: 'Standard @Acme Small', layer_height: '0.28' },
  });
  assert.equal(reserved.ok, false);
  assert.deepEqual(codes(reserved), ['reserved-key']);

  const unknownKey = lib.createCustomPreset({
    kind: 'process',
    name: 'Sneaky',
    inherits: 'Standard @Acme Big',
    overrides: { not_a_setting: '1' },
  });
  assert.deepEqual(codes(unknownKey), ['unknown-preset-key']);

  const badNumber = lib.createCustomPreset({
    kind: 'process',
    name: 'Sneaky',
    inherits: 'Standard @Acme Big',
    overrides: { layer_height: Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(codes(badNumber), ['invalid-value']);

  const systemName = lib.createCustomPreset({
    kind: 'process',
    name: 'Standard @Acme Big',
    inherits: 'Standard @Acme Big',
  });
  assert.deepEqual(codes(systemName), ['duplicate-preset-name']);

  assert.deepEqual(lib.customPresets(), [], 'nothing was written');
});

test('a preset that something else depends on cannot be deleted, renamed away, or uninstalled', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install');
  ok(lib.createCustomPreset({ kind: 'machine', name: 'Shop Floor', inherits: 'Acme Big Printer 0.4 nozzle' }), 'base');
  ok(lib.createCustomPreset({ kind: 'machine', name: 'Shop Floor B', inherits: 'Shop Floor' }), 'derived');

  const deleted = lib.deleteCustomPreset(CUSTOM_PRESET_VENDOR, 'machine', 'Shop Floor');
  assert.deepEqual(codes(deleted), ['dependent-preset']);
  assert.match(deleted.issues[0].message, /"Shop Floor B"/);

  const renamed = lib.updateCustomPreset(CUSTOM_PRESET_VENDOR, 'machine', 'Shop Floor', { name: 'Renamed' });
  assert.deepEqual(codes(renamed), ['dependent-preset']);

  const uninstalled = lib.uninstallPrinter('Acme', 'Acme Big Printer');
  assert.deepEqual(codes(uninstalled), ['dependent-preset']);

  // Clearing the last nozzle is the same act, and takes the same refusal.
  const cleared = lib.installPrinter('Acme', 'Acme Big Printer', []);
  assert.deepEqual(codes(cleared), ['dependent-preset']);

  assert.equal(lib.customPresets().length, 2);
  assert.deepEqual(lib.state.installed[0].variants, ['0.4']);

  ok(lib.deleteCustomPreset(CUSTOM_PRESET_VENDOR, 'machine', 'Shop Floor B'), 'delete the leaf first');
  ok(lib.deleteCustomPreset(CUSTOM_PRESET_VENDOR, 'machine', 'Shop Floor'), 'then its base');
  ok(lib.uninstallPrinter('Acme', 'Acme Big Printer'), 'then the printer');
  assert.equal(lib.isConfigured(), false);
});

test('an edit keeps the creation date and moves the updated date', () => {
  let stamp = '2026-08-16T00:00:00.000Z';
  const created = PresetLibrary.create(fixture(), { clock: { now: () => stamp } });
  const lib = created.library;
  ok(lib.createCustomPreset({ kind: 'process', name: 'Fast Draft', inherits: 'Standard @Acme Big' }), 'create');

  stamp = '2026-09-01T12:00:00.000Z';
  ok(
    lib.updateCustomPreset(CUSTOM_PRESET_VENDOR, 'process', 'Fast Draft', {
      overrides: { layer_height: '0.28' },
      version: '1.1.0',
    }),
    'update',
  );
  const record = lib.customPresets('process')[0];
  assert.equal(record.provenance.createdAt, '2026-08-16T00:00:00.000Z');
  assert.equal(record.provenance.updatedAt, '2026-09-01T12:00:00.000Z');
  assert.equal(record.provenance.version, '1.1.0');
  assert.equal(record.provenance.license, 'All rights reserved (operator-authored)', 'kept from the original');
  assert.deepEqual(lib.graph().find(CUSTOM_PRESET_VENDOR, 'process', 'Fast Draft')?.effective.layer_height, '0.28');
});

test('an exported bundle reimports with installation, inheritance, and compatibility intact', () => {
  const source = library();
  ok(source.installPrinter('Acme', 'Acme Big Printer', ['0.2', '0.4']), 'install');
  ok(source.installPrinter('Acme', 'Acme Small Printer', ['0.4']), 'install second');
  ok(
    source.createCustomPreset({
      kind: 'machine',
      name: 'Shop Floor Big',
      inherits: 'Acme Big Printer 0.4 nozzle',
      overrides: { printable_area: ['0x0', '200x0', '200x200', '0x200'] },
      license: 'CC0',
      version: '3.0.0',
    }),
    'custom printer',
  );
  ok(
    source.createCustomPreset({
      kind: 'filament',
      name: 'Shop PLA',
      inherits: 'Acme PLA',
      overrides: { nozzle_temperature: ['218'] },
    }),
    'custom filament',
  );

  const text = source.exportBundle('2026-08-16T00:00:00.000Z');
  assert.equal(text, source.exportBundle('2026-08-16T00:00:00.000Z'), 'the same library exports byte-identically');
  const bundle = JSON.parse(text);
  assert.equal(bundle.format, PRESET_BUNDLE_FORMAT);
  assert.equal(bundle.schemaVersion, PRESET_LIBRARY_SCHEMA_VERSION);
  assert.equal(bundle.engine.commit, PINNED_PRESET_SEMANTICS.commit);
  assert.equal(bundle.customPresets[0].provenance.license, 'CC0', 'the licence travels with the preset');

  const target = library();
  ok(target.importBundle(text), 'import');
  assert.deepEqual(target.state.installed, source.state.installed);
  assert.deepEqual(target.state.customPresets, source.state.customPresets);
  assert.equal(target.exportBundle('2026-08-16T00:00:00.000Z'), text, 'the round trip is byte-identical');

  const custom = target.graph().find(CUSTOM_PRESET_VENDOR, 'machine', 'Shop Floor Big');
  assert.ok(custom);
  assert.deepEqual(custom.effective.nozzle_diameter, ['0.4'], 'inheritance survived the trip');
  assert.deepEqual(
    target
      .graph()
      .compatibleProcesses(custom.id)
      .map((node) => node.name),
    ['Standard @Acme Big'],
    'compatibility survived the trip',
  );
});

test('a bundle from another engine, schema, or format is refused whole', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Small Printer', ['0.4']), 'install something first');
  const before = stableStringify(lib.state as never);

  assert.deepEqual(codes(lib.importBundle('{ not json')), ['invalid-bundle']);
  assert.deepEqual(codes(lib.importBundle('[]')), ['invalid-bundle']);
  assert.deepEqual(codes(lib.importBundle(JSON.stringify({ format: 'something-else' }))), ['invalid-bundle']);

  const base = JSON.parse(lib.exportBundle('2026-08-16T00:00:00.000Z'));
  assert.deepEqual(codes(lib.importBundle(JSON.stringify({ ...base, schemaVersion: 99 }))), ['unsupported-schema']);
  assert.deepEqual(codes(lib.importBundle(JSON.stringify({ ...base, engine: { repository: '', commit: 'abc' } }))), [
    'engine-mismatch',
  ]);

  const unknownPrinter = {
    ...base,
    installed: [{ vendor: 'Acme', model: 'Acme Imaginary Printer', variants: ['0.4'] }],
  };
  assert.deepEqual(codes(lib.importBundle(JSON.stringify(unknownPrinter))), ['unknown-printer-model']);

  assert.equal(stableStringify(lib.state as never), before, 'every refusal left the library untouched');
});

test('stored state that lost its provenance is reported, not silently trusted', () => {
  const created = PresetLibrary.create(fixture(), {
    clock: CLOCK,
    state: {
      schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
      catalogFingerprint: 'stale',
      installed: [{ vendor: 'Acme', model: 'Acme Big Printer', variants: ['0.4'] }],
      customPresets: [
        {
          vendor: CUSTOM_PRESET_VENDOR,
          kind: 'machine',
          name: 'No Provenance',
          inherits: 'Acme Big Printer 0.4 nozzle',
          overrides: {},
          provenance: { source: 'user-derived', derivedFrom: { name: 'Acme Big Printer 0.4 nozzle' } },
        },
      ],
    },
  });
  assert.deepEqual(
    created.issues.map((issue) => issue.code),
    ['invalid-provenance', 'invalid-provenance', 'invalid-provenance', 'invalid-provenance', 'engine-mismatch'],
    'licence, version, created, and updated are each required, and the stale fingerprint is reported',
  );
  assert.deepEqual(created.library.customPresets(), [], 'the unusable preset is dropped');
  assert.deepEqual(
    created.library.state.installed,
    [{ vendor: 'Acme', model: 'Acme Big Printer', variants: ['0.4'] }],
    'but it does not take the operator’s installed printers down with it — unlike a bundle, ' +
      'which is refused whole because the operator still has the file',
  );

  const unreadable = PresetLibrary.create(fixture(), { clock: CLOCK, state: { schemaVersion: 99 } });
  assert.deepEqual(
    unreadable.issues.map((issue) => issue.code),
    ['unsupported-schema'],
  );
  assert.equal(unreadable.library.isConfigured(), false, 'one bad write cannot lock the operator out');
  assert.deepEqual(
    unreadable.library.inventory().models.map((model) => model.model),
    ['Acme Big Printer', 'Acme Small Printer'],
    'and the catalog is still fully browsable',
  );
});

test('a setup made against a different catalog says so on load', () => {
  const source = library();
  ok(source.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install');

  const sameCatalog = PresetLibrary.create(fixture(), { clock: CLOCK, state: source.state });
  assert.deepEqual(sameCatalog.issues, [], 'the fingerprint matches, so there is nothing to say');
  assert.deepEqual(sameCatalog.library.state.installed, source.state.installed);

  // The corpus ships with the build, so this is the one moment a catalog
  // update is observable from inside the app.
  const next = fixture() as { Acme: { machine: Record<string, unknown>[] } };
  next.Acme.machine.push({
    type: 'machine',
    name: 'Acme New Printer 0.4 nozzle',
    from: 'system',
    instantiation: 'true',
    inherits: 'fdm_acme_common',
    printer_model: 'Acme New Printer',
    printer_variant: '0.4',
    nozzle_diameter: ['0.4'],
  });
  const updated = PresetLibrary.create(next, { clock: CLOCK, state: source.state });
  assert.deepEqual(
    updated.issues.map((issue) => `${issue.severity}:${issue.code}`),
    ['warning:engine-mismatch'],
  );
  assert.deepEqual(
    updated.library.state.installed,
    source.state.installed,
    'a printer the new catalog still has stays installed',
  );
  assert.equal(updated.library.inventory().models.length, 3, 'and the printer the update added is offered');

  const fresh = PresetLibrary.create(fixture(), { clock: CLOCK, state: { ...source.state, catalogFingerprint: '' } });
  assert.deepEqual(fresh.issues, [], 'a state with no recorded fingerprint is not accused of drifting');
});

test('a catalog update is planned before it is applied', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.2', '0.4']), 'install');
  ok(lib.installPrinter('Acme', 'Acme Small Printer', ['0.4']), 'install second');

  const unchanged = lib.planCatalogUpdate(fixture());
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.nextFingerprint, lib.catalogFingerprint);
  assert.deepEqual(unchanged.issues, []);

  const next = fixture() as { Acme: { machine: Record<string, unknown>[] } };
  next.Acme.machine = next.Acme.machine.filter((entry) => entry.name !== 'Acme Big Printer 0.2 nozzle');
  next.Acme.machine.push({
    type: 'machine',
    name: 'Acme New Printer 0.4 nozzle',
    from: 'system',
    instantiation: 'true',
    inherits: 'fdm_acme_common',
    printer_model: 'Acme New Printer',
    printer_variant: '0.4',
    nozzle_diameter: ['0.4'],
  });

  const plan = lib.planCatalogUpdate(next);
  assert.equal(plan.changed, true);
  assert.deepEqual(
    plan.addedModels.map((lineage) => lineage.name),
    ['Acme New Printer'],
  );
  assert.deepEqual(plan.removedModels, [], 'the model stayed; only one of its nozzles left');
  assert.deepEqual(
    plan.removedVariants.map((lineage) => lineage.name),
    ['Acme Big Printer 0.2'],
  );
  assert.deepEqual(codes(plan), ['unknown-printer-variant']);
  assert.equal(plan.issues[0].severity, 'warning');
  assert.equal(plan.applicable, true, 'a warning describes a loss; it does not block');

  const applied = lib.applyCatalogUpdate(next);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.library?.state.installed, [
    { vendor: 'Acme', model: 'Acme Big Printer', variants: ['0.4'] },
    { vendor: 'Acme', model: 'Acme Small Printer', variants: ['0.4'] },
  ]);
  assert.equal(lib.state.installed[0].variants.length, 2, 'the old library is left alone');
});

test('an update that would orphan an operator preset is refused', () => {
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Small Printer', ['0.4']), 'install');
  ok(
    lib.createCustomPreset({ kind: 'machine', name: 'Shop Small', inherits: 'Acme Small Printer 0.4 nozzle' }),
    'custom',
  );

  const next = fixture() as { Acme: { machine: Record<string, unknown>[] } };
  next.Acme.machine = next.Acme.machine.filter((entry) => entry.name !== 'Acme Small Printer 0.4 nozzle');

  const plan = lib.planCatalogUpdate(next);
  assert.equal(plan.applicable, false);
  assert.deepEqual(
    plan.orphanedCustomPresets.map((lineage) => lineage.name),
    ['Shop Small'],
  );
  assert.equal(codes(plan).includes('unknown-base-preset'), true);

  const applied = lib.applyCatalogUpdate(next);
  assert.equal(applied.ok, false);
  assert.equal(applied.library, undefined);

  const broken = lib.planCatalogUpdate({ Acme: { machine: [{ name: 'x', inherits: 'nothing' }] } });
  assert.equal(broken.applicable, false);
  assert.deepEqual(codes(broken), ['graph-rejected']);
});

test('the store persists, reloads, and survives storage that refuses to write', () => {
  const backing = new Map<string, string>();
  const storage: PresetLibraryKeyValueStorage = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
    removeItem: (key) => void backing.delete(key),
  };

  const first = new PresetLibraryStore(fixture(), storage);
  assert.deepEqual(first.loadIssues, []);
  ok(first.library.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install');
  ok(first.library.createCustomPreset({ kind: 'filament', name: 'Shop PLA', inherits: 'Acme PLA' }), 'custom');
  assert.equal(first.save(), true);

  const reloaded = new PresetLibraryStore(fixture(), storage);
  assert.deepEqual(reloaded.loadIssues, []);
  assert.deepEqual(reloaded.library.state.installed, first.library.state.installed);
  assert.deepEqual(reloaded.library.customPresets().length, 1);
  assert.ok(reloaded.library.graph().find(CUSTOM_PRESET_VENDOR, 'filament', 'Shop PLA'));

  backing.set('orcaxr.preset-library', '{ truncated');
  const corrupted = new PresetLibraryStore(fixture(), storage);
  assert.deepEqual(
    corrupted.loadIssues.map((issue) => issue.code),
    ['unsupported-schema'],
  );
  assert.equal(corrupted.library.isConfigured(), false);

  const refusing = new PresetLibraryStore(fixture(), {
    getItem: () => {
      throw new Error('private mode');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('quota');
    },
  });
  assert.deepEqual(refusing.loadIssues, []);
  ok(refusing.library.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'in-memory install still works');
  assert.equal(refusing.save(), false, 'the failure is reported rather than thrown');
  assert.equal(new PresetLibraryStore(fixture(), undefined).save(), false);
});

test('installation narrows what the real bundled catalog can slice', () => {
  const raw = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../public/profiles/catalog.json'), 'utf8'),
  ) as unknown;
  const lib = PresetLibrary.create(raw, { clock: CLOCK }).library;

  assert.deepEqual(
    lib.inventory().models.map((model) => `${model.vendor} / ${model.model}: ${model.variants.length}`),
    ['Elegoo / Elegoo Centauri Carbon: 4', 'Snapmaker / Snapmaker U1: 4'],
  );

  ok(lib.installPrinter('Snapmaker', 'Snapmaker U1', ['0.4']), 'install the U1 0.4');
  assert.deepEqual(lib.installedVendors(), ['Snapmaker']);
  assert.deepEqual(
    lib
      .graph()
      .selectable('machine')
      .map((node) => node.name),
    ['Snapmaker U1 (0.4 nozzle)'],
  );

  const everything = ProfileCatalog.fromRaw(raw);
  const installed = ProfileCatalog.fromRaw(lib.composeCatalog());
  assert.equal(
    new Set(everything.profiles.map((profile) => profile.machineName)).size > 1,
    true,
    'the full catalog offers several printers',
  );
  assert.deepEqual(
    [...new Set(installed.profiles.map((profile) => profile.machineName))],
    ['Snapmaker U1 (0.4 nozzle)'],
  );
  assert.equal(installed.profiles.length > 0, true, 'the installed printer still has sliceable combinations');
  assert.deepEqual(
    installed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    [],
    'hiding a printer must not orphan a process or filament',
  );
});

test('every surface routes through one operation switch', () => {
  const lib = library();
  ok(
    applyPresetLibraryOperation(lib, { kind: 'install', vendor: 'Acme', model: 'Acme Big Printer', variants: ['0.4'] }),
    'install',
  );
  ok(
    applyPresetLibraryOperation(lib, {
      kind: 'create',
      draft: { kind: 'filament', name: 'Shop PLA', inherits: 'Acme PLA' },
    }),
    'create',
  );
  ok(
    applyPresetLibraryOperation(lib, {
      kind: 'update',
      vendor: CUSTOM_PRESET_VENDOR,
      presetKind: 'filament',
      name: 'Shop PLA',
      draft: { version: '2.0.0' },
    }),
    'update',
  );
  assert.equal(lib.customPresets('filament')[0].provenance.version, '2.0.0');

  const exported = applyPresetLibraryOperation(lib, { kind: 'export' });
  assert.deepEqual(exported, { ok: true, issues: [] }, 'export changes nothing and reports nothing');

  ok(
    applyPresetLibraryOperation(lib, {
      kind: 'delete',
      vendor: CUSTOM_PRESET_VENDOR,
      presetKind: 'filament',
      name: 'Shop PLA',
    }),
    'delete',
  );
  assert.deepEqual(lib.customPresets(), []);
  assert.deepEqual(codes(applyPresetLibraryOperation(lib, { kind: 'import', bundle: 'nope' })), ['invalid-bundle']);
});

test('an override is read back in the shape the base already uses', () => {
  // The engine deserializes `nozzle_temperature` as a list and `layer_height`
  // as one value; a preset that stored the wrong shape would validate here and
  // then mean something else downstream.
  assert.deepEqual(coerceOverrideValue(['210'], '215'), ['215']);
  assert.deepEqual(coerceOverrideValue(['210', '210'], '215, 220'), ['215', '220']);
  assert.deepEqual(coerceOverrideValue([210], '215'), [215]);
  assert.deepEqual(coerceOverrideValue('0.2', '0.28'), '0.28');
  assert.deepEqual(coerceOverrideValue(0.2, '0.28'), 0.28);
  assert.deepEqual(coerceOverrideValue(0.2, 'thick'), 'thick', 'an unparseable number stays text for the validator');
  assert.deepEqual(coerceOverrideValue(true, 'false'), false);
  assert.deepEqual(coerceOverrideValue(undefined, ' 42 '), '42');
  assert.deepEqual(coerceOverrideValue(['a'], 'x, , y'), ['x', 'y'], 'empty list entries are dropped');

  assert.equal(formatOverrideValue(['215', '220']), '215, 220');
  assert.equal(formatOverrideValue('0.2'), '0.2');
  assert.equal(formatOverrideValue(undefined), '');

  // Round trip: what the panel shows is what the library stores.
  const lib = library();
  ok(lib.installPrinter('Acme', 'Acme Big Printer', ['0.4']), 'install');
  const base = lib.basePresetsFor('filament')[0];
  const text = formatOverrideValue(base.effective.nozzle_temperature);
  assert.equal(text, '210');
  ok(
    lib.createCustomPreset({
      kind: 'filament',
      name: 'Hotter PLA',
      inherits: base.name,
      overrides: { nozzle_temperature: coerceOverrideValue(base.effective.nozzle_temperature, '215') },
    }),
    'create',
  );
  assert.deepEqual(lib.graph().find(CUSTOM_PRESET_VENDOR, 'filament', 'Hotter PLA')?.effective.nozzle_temperature, [
    '215',
  ]);
});

test('the composed catalog of an untouched library is the catalog itself', () => {
  const lib = library();
  const composed = PresetGraph.build(lib.composeCatalog());
  assert.deepEqual(
    composed.list().map((node) => `${node.vendor}/${node.kind}/${node.name}`),
    PresetGraph.build(fixture())
      .list()
      .map((node) => `${node.vendor}/${node.kind}/${node.name}`),
  );
});

console.log(`\n${passed} preset library tests passed.`);
