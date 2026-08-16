import assert from 'node:assert/strict';

import type { CalibrationWorkflowId } from '../../features/calibrationInventory';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import { getCalibrationJobDefinition } from './definitions';
import {
  CALIBRATION_HISTORY_FORMAT,
  CALIBRATION_HISTORY_SCHEMA_VERSION,
  CalibrationHistory,
  UNKNOWN_CONDITION,
  assessCalibrationApplicability,
  calibrationRerunRequest,
  compareCalibrationRecords,
  exportCalibrationHistory,
  findSecretsInPayload,
  importCalibrationHistory,
  calibrationMethodFromDefinition,
  calibrationMethodFromPlan,
  recordCalibrationRun,
  type CalibrationConditions,
  type CalibrationHistoryIssue,
  type CalibrationRecord,
} from './history';
import { CALIBRATION_HISTORY_STORAGE_KEY, CalibrationHistoryStore } from './historyStore';
import type { CalibrationFirmwareFlavor, CalibrationJobPlan, CalibrationJobPrerequisites } from './types';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function codes(issues: readonly CalibrationHistoryIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function prerequisites(flavor: CalibrationFirmwareFlavor = 'klipper'): CalibrationJobPrerequisites {
  return {
    printer: {
      id: 'printer:snapmaker-u1',
      manufacturer: 'Snapmaker',
      model: 'U1',
      bedWidthMm: 270,
      bedDepthMm: 270,
      buildHeightMm: 270,
      maxPrintSpeedMmPerS: 300,
      maxAccelerationMmPerS2: 10_000,
    },
    nozzle: { diameterMm: 0.4, minTemperatureC: 170, maxTemperatureC: 300, maxLayerHeightMm: 0.32 },
    filament: {
      id: 'filament:pla-red',
      name: 'Red PLA',
      material: 'PLA',
      minTemperatureC: 180,
      maxTemperatureC: 260,
      flowRatio: 0.98,
      maxVolumetricSpeedMm3PerS: 30,
      retractionLengthMm: 0.8,
    },
    process: {
      id: 'process:quality',
      layerHeightMm: 0.2,
      firstLayerHeightMm: 0.2,
      lineWidthMm: 0.45,
      outerWallSpeedMmPerS: 120,
      defaultAccelerationMmPerS2: 5_000,
      xyHoleCompensationMm: 0,
      xyContourCompensationMm: 0,
    },
    firmware: {
      flavor,
      nozzleTemperature: true,
      pressureAdvance: true,
      inputShaping: true,
      junctionDeviation: true,
      maxInputShapingFrequencyHz: 500,
    },
  };
}

function plan(id: CalibrationWorkflowId = 'pressure-advance-line'): CalibrationJobPlan {
  return compileCalibrationJob(createDefaultCalibrationJobRequest(id, prerequisites()), { jobId: `calibration:${id}` });
}

function conditions(overrides: Partial<CalibrationConditions> = {}): CalibrationConditions {
  return {
    printerModel: 'Snapmaker U1',
    firmwareFlavor: 'klipper',
    firmwareVersion: 'v0.12.0',
    nozzleDiameterMm: 0.4,
    filamentMaterial: 'PLA',
    filamentPresetHash: 'fnv1a64:1111111111111111',
    processPresetHash: 'fnv1a64:2222222222222222',
    ...overrides,
  };
}

function record(
  overrides: {
    readonly plan?: CalibrationJobPlan;
    readonly conditions?: CalibrationConditions;
    readonly measurements?: readonly { key: string; value: number | string; unit: string | null }[];
    readonly chosenKey?: string;
    readonly inconclusive?: boolean;
    readonly recordedAt?: string;
  } = {},
): CalibrationRecord {
  const compiled = overrides.plan ?? plan();
  const result = recordCalibrationRun(calibrationMethodFromPlan(compiled), overrides.conditions ?? conditions(), {
    operator: 'ignacio',
    recordedAt: overrides.recordedAt ?? '2026-08-16T09:00:00.000Z',
    measurements: overrides.measurements ?? [{ key: 'pressureAdvanceK', value: 0.042, unit: null }],
    ...(overrides.inconclusive ? {} : { chosenKey: overrides.chosenKey ?? 'pressureAdvanceK' }),
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
    gcodeHash: 'fnv1a64:bbbbbbbbbbbbbbbb',
  });
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  assert.ok(result.record);
  return result.record;
}

test('a run is recorded with the conditions it was measured under', () => {
  const compiled = plan();
  const stored = record();

  assert.equal(stored.schemaVersion, CALIBRATION_HISTORY_SCHEMA_VERSION);
  assert.match(stored.id, /^calib:[0-9a-f]{16}$/);
  assert.equal(stored.method.definitionId, 'pressure-advance-line');
  assert.equal(stored.method.fingerprint, compiled.definitionFingerprint);
  assert.deepEqual(stored.conditions, conditions());
  assert.deepEqual(stored.chosen, { key: 'pressureAdvanceK', value: 0.042, unit: null });
  assert.equal(stored.artifacts.gcodeHash, 'fnv1a64:bbbbbbbbbbbbbbbb');
  assert.deepEqual(stored.parameters, compiled.parameters, 'the sweep that produced the number travels with it');

  // The identity is the content, so the same evidence recorded twice is one
  // record rather than two.
  assert.equal(record().id, stored.id);
});

test('a record that could not be read back later is refused', () => {
  const compiled = plan();
  const missing = recordCalibrationRun(calibrationMethodFromPlan(compiled), conditions(), {
    operator: 'ignacio',
    recordedAt: '2026-08-16T09:00:00.000Z',
    measurements: [{ key: 'adaptivePressureAdvanceN', value: 1, unit: null }],
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(codes(missing.issues), ['missing-measurement'], 'Factor K is required by this method');
  assert.equal(missing.record, undefined);

  const invented = recordCalibrationRun(calibrationMethodFromPlan(compiled), conditions(), {
    operator: 'ignacio',
    recordedAt: '2026-08-16T09:00:00.000Z',
    measurements: [
      { key: 'pressureAdvanceK', value: 0.04, unit: null },
      { key: 'notAField', value: 3, unit: null },
    ],
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(codes(invented.issues), ['unknown-measurement']);

  const unmeasured = recordCalibrationRun(calibrationMethodFromPlan(compiled), conditions(), {
    operator: 'ignacio',
    recordedAt: '2026-08-16T09:00:00.000Z',
    measurements: [{ key: 'pressureAdvanceK', value: 0.04, unit: null }],
    chosenKey: 'adaptivePressureAdvanceN',
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(codes(unmeasured.issues), ['unknown-measurement'], 'a result must be one of the values taken');

  const anonymous = recordCalibrationRun(calibrationMethodFromPlan(compiled), conditions(), {
    operator: '  ',
    recordedAt: 'not-a-date',
    measurements: [{ key: 'pressureAdvanceK', value: Number.POSITIVE_INFINITY, unit: null }],
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(codes(anonymous.issues), [
    'invalid-record',
    'missing-measurement',
    'invalid-record',
    'invalid-record',
  ]);
});

test('a definition alone is enough to record against — no printer envelope required', () => {
  const definition = getCalibrationJobDefinition('retraction-tower');
  assert.ok(definition);
  const compiled = plan('retraction-tower');
  const fromDefinition = calibrationMethodFromDefinition(definition, compiled.parameters);
  const fromPlan = calibrationMethodFromPlan(compiled);
  assert.deepEqual(fromDefinition, fromPlan, 'the two routes describe the same method');

  const written = recordCalibrationRun(fromDefinition, conditions(), {
    operator: 'ignacio',
    recordedAt: '2026-08-16T09:00:00.000Z',
    measurements: [{ key: 'retractionLengthMm', value: 0.6, unit: 'mm' }],
    chosenKey: 'retractionLengthMm',
    projectHash: 'fnv1a64:aaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(written.issues, []);
  assert.equal(written.record?.method.fingerprint, definition.fingerprint);
  assert.deepEqual(written.record?.chosen, { key: 'retractionLengthMm', value: 0.6, unit: 'mm' });
});

test('a result never applies to a different nozzle, material, or machine', () => {
  const stored = record();

  const same = assessCalibrationApplicability(stored, conditions());
  assert.equal(same.applicable, true);
  assert.deepEqual(same.mismatches, []);
  assert.deepEqual(same.issues, []);

  for (const [field, value] of [
    ['nozzleDiameterMm', 0.6],
    ['filamentMaterial', 'PETG'],
    ['printerModel', 'Elegoo Centauri Carbon'],
    ['filamentPresetHash', 'fnv1a64:9999999999999999'],
  ] as const) {
    const assessment = assessCalibrationApplicability(stored, conditions({ [field]: value } as never));
    assert.equal(assessment.applicable, false, `${field} must block`);
    assert.equal(assessment.issues[0].code, 'condition-mismatch');
    assert.equal(assessment.issues[0].severity, 'error');
    assert.match(assessment.issues[0].message, new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // A firmware bump is worth saying and not worth refusing over.
  const newerFirmware = assessCalibrationApplicability(stored, conditions({ firmwareVersion: 'v0.13.0' }));
  assert.equal(newerFirmware.applicable, true);
  assert.deepEqual(
    newerFirmware.issues.map((entry) => entry.severity),
    ['warning'],
  );

  // A run that produced no chosen value has nothing to apply, whatever matches.
  const inconclusive = record({ inconclusive: true });
  assert.equal(inconclusive.chosen, null);
  assert.equal(assessCalibrationApplicability(inconclusive, conditions()).applicable, false);
});

test('two runs compare field by field, and say when they are not comparable', () => {
  const first = record({ recordedAt: '2026-08-16T09:00:00.000Z' });
  const second = record({
    recordedAt: '2026-08-17T09:00:00.000Z',
    measurements: [{ key: 'pressureAdvanceK', value: 0.051, unit: null }],
  });

  const same = compareCalibrationRecords(first, second);
  assert.equal(same.sameMethod, true);
  assert.equal(same.sameConditions, true);
  assert.deepEqual(same.parameterDifferences, []);
  assert.equal(same.measurementDifferences.length, 1);
  assert.equal(same.measurementDifferences[0].key, 'pressureAdvanceK');
  assert.ok(Math.abs((same.measurementDifferences[0].delta ?? 0) - 0.009) < 1e-9);
  assert.deepEqual(same.caveats, []);

  const otherMaterial = record({
    recordedAt: '2026-08-18T09:00:00.000Z',
    conditions: conditions({ filamentMaterial: 'PETG' }),
    measurements: [{ key: 'pressureAdvanceK', value: 0.08, unit: null }],
  });
  const across = compareCalibrationRecords(first, otherMaterial);
  assert.equal(across.sameConditions, false);
  assert.deepEqual(
    across.conditionDifferences.map((difference) => difference.field),
    ['filamentMaterial'],
  );
  assert.ok(across.caveats.some((caveat) => /different printing conditions/.test(caveat)));

  const otherMethod = record({
    plan: plan('retraction-tower'),
    measurements: [{ key: 'retractionLengthMm', value: 0.6, unit: 'mm' }],
    chosenKey: 'retractionLengthMm',
  });
  const unrelated = compareCalibrationRecords(first, otherMethod);
  assert.equal(unrelated.sameMethod, false);
  assert.ok(unrelated.caveats.some((caveat) => /not comparable/.test(caveat)));

  // A non-numeric measurement gets no delta rather than a fabricated one.
  const textual = record({
    plan: plan('tolerance-extension'),
    measurements: [{ key: 'passingClearanceMm', value: 'loose', unit: 'mm' }],
    chosenKey: 'passingClearanceMm',
  });
  const otherTextual = record({
    plan: plan('tolerance-extension'),
    recordedAt: '2026-08-19T09:00:00.000Z',
    measurements: [{ key: 'passingClearanceMm', value: 'snug', unit: 'mm' }],
    chosenKey: 'passingClearanceMm',
  });
  const textualComparison = compareCalibrationRecords(textual, otherTextual);
  assert.equal(textualComparison.measurementDifferences[0].delta, null);
});

test('re-running is bound to the method that produced the result', () => {
  const stored = record();
  const definition = getCalibrationJobDefinition('pressure-advance-line');
  assert.ok(definition);

  const rerun = calibrationRerunRequest(
    stored,
    { id: definition.id, fingerprint: definition.fingerprint, definitionVersion: definition.definitionVersion },
    prerequisites(),
  );
  assert.deepEqual(rerun.issues, []);
  assert.equal(rerun.request?.definitionId, 'pressure-advance-line');
  assert.deepEqual(rerun.request?.parameters, stored.parameters, 'the same sweep, not the current defaults');
  // The rebuilt request compiles, which is what makes "re-run" a real offer.
  const recompiled = compileCalibrationJob(rerun.request!, { jobId: 'calibration:rerun' });
  assert.equal(recompiled.definitionFingerprint, stored.method.fingerprint);

  const moved = calibrationRerunRequest(
    stored,
    { id: definition.id, fingerprint: 'fnv1a64:0000000000000000', definitionVersion: 1 },
    prerequisites(),
  );
  assert.deepEqual(codes(moved.issues), ['method-changed']);
  assert.equal(moved.request, undefined);
  assert.match(moved.issues[0].message, /different geometry/);

  const wrongMethod = calibrationRerunRequest(
    stored,
    { id: 'retraction-tower', fingerprint: stored.method.fingerprint, definitionVersion: 1 },
    prerequisites(),
  );
  assert.deepEqual(codes(wrongMethod.issues), ['method-changed']);
});

test('the ledger is newest first, deduplicating and bounded, and deletes by id', () => {
  const history = new CalibrationHistory();
  const older = record({ recordedAt: '2026-08-10T09:00:00.000Z' });
  const newer = record({
    recordedAt: '2026-08-20T09:00:00.000Z',
    measurements: [{ key: 'pressureAdvanceK', value: 0.05, unit: null }],
  });
  history.add(older);
  history.add(newer);
  history.add(older);
  assert.equal(history.size, 2, 'the same evidence twice is one record');
  assert.deepEqual(
    history.list().map((entry) => entry.recordedAt),
    ['2026-08-20T09:00:00.000Z', '2026-08-10T09:00:00.000Z'],
  );
  assert.equal(history.get(newer.id)?.id, newer.id);

  const retraction = record({
    plan: plan('retraction-tower'),
    measurements: [{ key: 'retractionLengthMm', value: 0.6, unit: 'mm' }],
    chosenKey: 'retractionLengthMm',
  });
  history.add(retraction);
  assert.deepEqual(
    history.list({ definitionId: 'retraction-tower' }).map((entry) => entry.id),
    [retraction.id],
  );

  assert.equal(history.delete('calib:nope').ok, false);
  assert.deepEqual(codes(history.delete('calib:nope').issues), ['unknown-record']);
  assert.equal(history.delete(older.id).ok, true);
  assert.equal(history.get(older.id), undefined);
  history.clear();
  assert.equal(history.size, 0);
});

test('an export is deterministic and provably free of secrets', () => {
  const first = record();
  const second = record({
    recordedAt: '2026-08-17T09:00:00.000Z',
    measurements: [{ key: 'pressureAdvanceK', value: 0.05, unit: null }],
  });
  const exported = exportCalibrationHistory([second, first], '2026-08-20T00:00:00.000Z');
  assert.deepEqual(exported.issues, []);
  assert.ok(exported.text);
  assert.equal(exported.text, exportCalibrationHistory([first, second], '2026-08-20T00:00:00.000Z').text);

  const payload = JSON.parse(exported.text);
  assert.equal(payload.format, CALIBRATION_HISTORY_FORMAT);
  assert.deepEqual(
    payload.records.map((entry: CalibrationRecord) => entry.recordedAt),
    ['2026-08-17T09:00:00.000Z', '2026-08-16T09:00:00.000Z'],
  );
  assert.equal(/token|apiKey|password|http:\/\//i.test(exported.text), false);

  // The scan is the guarantee, not the absence of a field for it: a record that
  // somehow carried a credential is refused rather than written.
  const poisoned = { ...first, note: 'see http://192.168.1.44:7125 for the log' } as CalibrationRecord;
  const refused = exportCalibrationHistory([poisoned], '2026-08-20T00:00:00.000Z');
  assert.equal(refused.text, undefined);
  assert.deepEqual(codes(refused.issues), ['secret-in-payload']);

  const keyed = { ...first, apiKey: 'abcd' } as unknown as CalibrationRecord;
  assert.deepEqual(codes(exportCalibrationHistory([keyed], '2026-08-20T00:00:00.000Z').issues), ['secret-in-payload']);
  assert.deepEqual(
    codes(findSecretsInPayload({ nested: { deviceToken: 'x' } })),
    ['secret-in-payload'],
    'the scan reaches every depth, not just the top level',
  );
});

test('an export reimports, and a refused one changes nothing', () => {
  const stored = record();
  const text = exportCalibrationHistory([stored], '2026-08-20T00:00:00.000Z').text!;
  const imported = importCalibrationHistory(text);
  assert.deepEqual(imported.issues, []);
  assert.deepEqual(imported.records, [stored]);

  assert.deepEqual(codes(importCalibrationHistory('{ not json').issues), ['invalid-payload']);
  assert.deepEqual(codes(importCalibrationHistory('{"format":"something"}').issues), ['invalid-payload']);
  assert.deepEqual(
    codes(importCalibrationHistory(JSON.stringify({ format: CALIBRATION_HISTORY_FORMAT, schemaVersion: 99 })).issues),
    ['unsupported-schema'],
  );
  assert.deepEqual(
    codes(
      importCalibrationHistory(
        JSON.stringify({ format: CALIBRATION_HISTORY_FORMAT, schemaVersion: 1, records: [{ id: 'x' }] }),
      ).issues,
    ),
    ['invalid-record'],
  );
});

test('a record from before conditions were tracked is kept, and can never be applied', () => {
  const stored = record();
  const legacy = {
    format: CALIBRATION_HISTORY_FORMAT,
    schemaVersion: 0,
    exportedAt: '2026-01-01T00:00:00.000Z',
    records: [
      {
        id: 'calib:legacy',
        recordedAt: '2026-01-01T00:00:00.000Z',
        operator: 'ignacio',
        method: stored.method,
        parameters: stored.parameters,
        artifacts: { projectHash: 'fnv1a64:cccccccccccccccc', gcodeHash: null },
        measurements: [{ key: 'pressureAdvanceK', value: 0.033, unit: null }],
        chosen: { key: 'pressureAdvanceK', value: 0.033, unit: null },
        appliedPreset: null,
        note: null,
      },
    ],
  };
  const imported = importCalibrationHistory(JSON.stringify(legacy));
  assert.equal(imported.records?.length, 1, 'losing the history would be worse than keeping it unusable');
  assert.deepEqual(
    imported.issues.map((entry) => entry.severity),
    ['warning'],
  );
  const migrated = imported.records![0];
  assert.equal(migrated.schemaVersion, CALIBRATION_HISTORY_SCHEMA_VERSION);
  assert.equal(migrated.conditions.filamentMaterial, UNKNOWN_CONDITION);
  assert.equal(Number.isNaN(migrated.conditions.nozzleDiameterMm), true);

  // Unknown conditions can never match, so the result is readable and inert.
  const assessment = assessCalibrationApplicability(migrated, conditions());
  assert.equal(assessment.applicable, false, 'inventing conditions would be a lie that later auto-applies');
  assert.ok(assessment.issues.some((entry) => entry.code === 'condition-mismatch' && entry.severity === 'error'));

  // It still compares, which is the whole reason for keeping it.
  const comparison = compareCalibrationRecords(migrated, stored);
  assert.equal(comparison.sameMethod, true);
  assert.equal(comparison.measurementDifferences.length, 1);
});

test('the store round-trips, and degrades rather than losing a session', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };

  const first = new CalibrationHistoryStore(storage);
  assert.deepEqual(first.loadIssues, []);
  const stored = record();
  first.history.add(stored);
  assert.equal(first.save('2026-08-20T00:00:00.000Z'), true);

  const reloaded = new CalibrationHistoryStore(storage);
  assert.deepEqual(reloaded.loadIssues, []);
  assert.deepEqual(reloaded.history.list(), [stored], 'the stored form is the export form');

  backing.set(CALIBRATION_HISTORY_STORAGE_KEY, '{ truncated');
  const corrupted = new CalibrationHistoryStore(storage);
  assert.deepEqual(codes(corrupted.loadIssues), ['invalid-payload']);
  assert.equal(corrupted.history.size, 0);

  const refusing = new CalibrationHistoryStore({
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
  refusing.history.add(stored);
  assert.equal(refusing.history.size, 1, 'an in-memory ledger still works');
  assert.equal(refusing.save('2026-08-20T00:00:00.000Z'), false, 'and the failure is reported, not thrown');
  assert.equal(new CalibrationHistoryStore(undefined).save(), false);
});

console.log(`\nCalibration history: ${passed} tests passed.`);
