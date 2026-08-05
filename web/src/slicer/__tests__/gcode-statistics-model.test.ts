import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GCODE_STATISTICS_SCHEMA,
  GCODE_STATISTICS_VERSION,
  GcodeStatisticsError,
  aggregateGcodeStatistics,
  classifyRichGcodeObservationCoverage,
  createVerifiedRichGcodeStatisticsSource,
  projectGcodeStatistics,
  type AuthoritativeGcodeStatisticsArtifact,
  type GcodeCustomTimeBreakdownRow,
  type GcodeFilamentStatisticsArtifact,
  type GcodeStatisticsBinding,
  type GcodeStatisticsConflictArtifact,
  type GcodeStatisticsCostUnit,
  type GcodeStatisticsProjection,
  type GcodeTimeModeArtifact,
  type VerifiedRichGcodeStatisticsSource,
} from '../GcodeStatisticsModel';
import {
  GCODE_RECORD_KIND,
  parseRichGcodeModel,
  type RichGcodeModel,
  type RichGcodeParseOptions,
} from '../RichGcodeModel';

let passed = 0;

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function hasStatisticsCode(...codes: readonly GcodeStatisticsError['code'][]): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof GcodeStatisticsError && codes.includes(error.code);
}

function sourceText(): string {
  return [
    'M83',
    ';LAYER_CHANGE',
    'G1 Z0.2',
    'T0',
    'G1 X10 E1',
    ';CUSTOM_GCODE',
    ';LAYER_CHANGE',
    'G1 Z0.4',
    'T1',
    'G1 X20 E1',
    '; COLOR_CHANGE,T1,#112233',
    ';PAUSE_PRINT',
  ].join('\n');
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function sourceHash(character: string): string {
  return `fnv1a64:${character.repeat(16)}`;
}

async function verifiedSource(
  text: string,
  options: RichGcodeParseOptions = {},
): Promise<VerifiedRichGcodeStatisticsSource> {
  return createVerifiedRichGcodeStatisticsSource(text, sha256(text), {
    filamentColors: ['#FF0000', '#00FF00'],
    ...options,
  });
}

const SOURCE_GCODE = sourceText();
const SOURCE_OUTPUT_HASH = sha256(SOURCE_GCODE);
const SOURCE = await verifiedSource(SOURCE_GCODE);

function binding(plateId = 'plate-a', overrides: Partial<GcodeStatisticsBinding> = {}): GcodeStatisticsBinding {
  return {
    jobId: 'job-42',
    plateId,
    sourceRevision: 7,
    sourceHash: sourceHash('1'),
    sourceAssetHash: sourceHash('2'),
    projectInputHash: hash('3'),
    gcodeOutputHash: SOURCE_OUTPUT_HASH,
    effectiveConfigHash: hash('5'),
    engineCommit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
    engineArtifactHash: hash('6'),
    ...overrides,
  };
}

const usd: GcodeStatisticsCostUnit = { id: 'USD', label: 'USD' };

function filamentRows(tools: readonly [number, number] = [0, 1]): GcodeFilamentStatisticsArtifact[] {
  return [
    {
      tool: tools[0],
      profileId: 'pla-red',
      profileHash: hash('a'),
      diameterMm: 1.75,
      densityGPerCm3: 1.24,
      costPerKg: 20,
      volumeSampleCount: 4,
      modelVolumeMm3: 100,
      supportVolumeMm3: 20,
      wipeTowerVolumeMm3: 10,
      flushedVolumeMm3: 5,
      totalVolumeMm3: 135,
    },
    {
      tool: tools[1],
      profileId: 'pla-blue',
      profileHash: hash('b'),
      diameterMm: 1.75,
      densityGPerCm3: 1.27,
      costPerKg: 25,
      volumeSampleCount: 3,
      modelVolumeMm3: 200,
      supportVolumeMm3: 0,
      wipeTowerVolumeMm3: 20,
      flushedVolumeMm3: 15,
      totalVolumeMm3: 235,
    },
  ];
}

function sameProfileAcrossToolsRows(): GcodeFilamentStatisticsArtifact[] {
  const rows = filamentRows();
  rows[1] = {
    ...rows[1],
    profileId: rows[0].profileId,
    profileHash: rows[0].profileHash,
    diameterMm: rows[0].diameterMm,
    densityGPerCm3: rows[0].densityGPerCm3,
    costPerKg: rows[0].costPerKg,
  };
  return rows;
}

function conflict(): GcodeStatisticsConflictArtifact {
  return {
    code: 'sequential-collision',
    message: 'Objects overlap in sequential mode',
    subjects: [
      { kind: 'object', objectId: 'object-cube', name: 'Part' },
      { kind: 'object', objectId: 'object-tower', name: 'Part' },
    ],
    layerUpperBoundOrdinal: 2,
    zMm: 0.4,
  };
}

function normalCustomSegments(): readonly GcodeCustomTimeBreakdownRow[] {
  return [
    { kind: 'pause', durationSeconds: 30, remainingSeconds: 120 },
    { kind: 'pause', durationSeconds: 80, remainingSeconds: 90 },
    { kind: 'color-change', durationSeconds: 10, remainingSeconds: 10 },
  ];
}

function silentCustomSegments(): readonly GcodeCustomTimeBreakdownRow[] {
  return [
    { kind: 'pause', durationSeconds: 35, remainingSeconds: 140 },
    { kind: 'pause', durationSeconds: 90, remainingSeconds: 105 },
    { kind: 'color-change', durationSeconds: 15, remainingSeconds: 15 },
  ];
}

interface ArtifactOptions {
  readonly binding?: GcodeStatisticsBinding;
  readonly filaments?: readonly GcodeFilamentStatisticsArtifact[];
  readonly includeSilent?: boolean;
  readonly timeCostPerHour?: number | null;
  readonly costUnit?: GcodeStatisticsCostUnit | null;
  readonly plannedWipeTowerToolChangeCount?: number | null;
  readonly normalCustomSegments?: readonly GcodeCustomTimeBreakdownRow[];
  readonly silentCustomSegments?: readonly GcodeCustomTimeBreakdownRow[];
  readonly conflictCheck?: AuthoritativeGcodeStatisticsArtifact['conflictCheck'];
  readonly conflicts?: readonly GcodeStatisticsConflictArtifact[];
  readonly omissions?: AuthoritativeGcodeStatisticsArtifact['omissions'];
}

function artifact(options: ArtifactOptions = {}): AuthoritativeGcodeStatisticsArtifact {
  const filaments = options.filaments ?? filamentRows();
  const normal: GcodeTimeModeArtifact = {
    id: 'normal',
    plannerBlockCount: 12,
    totalSeconds: 120,
    prepareSeconds: 20,
    layerSeconds: [60, 60],
    moveSeconds: [
      { id: GCODE_RECORD_KIND.TRAVEL, seconds: 20 },
      { id: GCODE_RECORD_KIND.EXTRUDE, seconds: 70 },
    ],
    roleSeconds: [
      { id: 1, seconds: 45 },
      { id: 2, seconds: 75 },
    ],
    customGcodeSeconds: options.normalCustomSegments ?? normalCustomSegments(),
  };
  const silent: GcodeTimeModeArtifact = {
    id: 'silent',
    plannerBlockCount: 12,
    totalSeconds: 140,
    prepareSeconds: 25,
    layerSeconds: [70, 70],
    moveSeconds: [
      { id: GCODE_RECORD_KIND.TRAVEL, seconds: 25 },
      { id: GCODE_RECORD_KIND.EXTRUDE, seconds: 80 },
    ],
    roleSeconds: [
      { id: 1, seconds: 50 },
      { id: 2, seconds: 90 },
    ],
    customGcodeSeconds: options.silentCustomSegments ?? silentCustomSegments(),
  };
  return {
    schema: GCODE_STATISTICS_SCHEMA,
    version: GCODE_STATISTICS_VERSION,
    binding: options.binding ?? binding(),
    layerCount: 2,
    processorFilamentChangeCount: 1,
    plannedWipeTowerToolChangeCount:
      options.plannedWipeTowerToolChangeCount === undefined ? 3 : options.plannedWipeTowerToolChangeCount,
    costUnit: options.costUnit === undefined ? usd : options.costUnit,
    timeCostPerHour: options.timeCostPerHour === undefined ? 3 : options.timeCostPerHour,
    timeModes: options.includeSilent === false ? [normal] : [normal, silent],
    filaments,
    roleToolUsage: filaments
      .map((filament, index) => ({
        role: index + 1,
        tool: filament.tool,
        volumeMm3: filament.modelVolumeMm3 + filament.supportVolumeMm3 + filament.wipeTowerVolumeMm3,
      }))
      .filter((row) => row.volumeMm3 > 0),
    diagnostics: [
      {
        source: 'engine',
        severity: 'warning',
        code: 'bed-temperature',
        message: 'Bed temperature is high',
        params: ['60'],
      },
    ],
    conflictCheck:
      options.conflictCheck ??
      ({ outcome: 'checked-none-found', exhaustive: true, reason: null, suppressionReasons: [] } as const),
    conflicts: options.conflicts ?? [],
    omissions: options.omissions ?? [],
  };
}

function replaceTimeMode(
  report: AuthoritativeGcodeStatisticsArtifact,
  id: GcodeTimeModeArtifact['id'],
  changes: Partial<GcodeTimeModeArtifact>,
): AuthoritativeGcodeStatisticsArtifact {
  return {
    ...report,
    timeModes: report.timeModes.map((mode) => (mode.id === id ? { ...mode, ...changes } : mode)),
  };
}

function close(actual: number | null, expected: number): void {
  if (actual === null) assert.fail(`Expected ${expected}, received unavailable`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not close to ${expected}`);
}

await test('cryptographically binds rich observations to the exact UTF-8 G-code output', async () => {
  assert.equal(SOURCE_OUTPUT_HASH, sha256(SOURCE_GCODE));
  const changedGcode = `${SOURCE_GCODE}\n; same layers, different bytes`;
  assert.equal(parseRichGcodeModel(changedGcode).layerCount, 2);
  await assert.rejects(
    createVerifiedRichGcodeStatisticsSource(changedGcode, SOURCE_OUTPUT_HASH),
    hasStatisticsCode('binding-mismatch'),
  );

  const staleOutputBinding = binding('plate-a', { gcodeOutputHash: sha256(changedGcode) });
  assert.throws(
    () => projectGcodeStatistics(SOURCE, artifact({ binding: staleOutputBinding }), staleOutputBinding),
    hasStatisticsCode('binding-mismatch'),
  );

  const forgedSource = { ...SOURCE } as VerifiedRichGcodeStatisticsSource;
  assert.throws(() => projectGcodeStatistics(forgedSource, artifact(), binding()), hasStatisticsCode('invalid-model'));

  const forgedError = Object.create(GcodeStatisticsError.prototype) as GcodeStatisticsError;
  Object.defineProperty(forgedError, 'code', { value: 'binding-mismatch', enumerable: true });
  const throwingArtifact = new Proxy(artifact(), {
    get() {
      throw forgedError;
    },
  });
  assert.throws(
    () => projectGcodeStatistics(SOURCE, throwingArtifact, binding()),
    hasStatisticsCode('invalid-artifact'),
  );

  const publicError = new GcodeStatisticsError('binding-mismatch', 'attacker-controlled');
  const throwingPublicArtifact = new Proxy(artifact(), {
    get() {
      throw publicError;
    },
  });
  assert.throws(
    () => projectGcodeStatistics(SOURCE, throwingPublicArtifact, binding()),
    hasStatisticsCode('invalid-artifact'),
  );
});

await test('projects exact time, material categories, role/tool usage, counts, and accessible units', () => {
  const report = artifact();
  const snapshot = JSON.stringify(report);
  const projection = projectGcodeStatistics(SOURCE, report, binding());
  const area = Math.PI * 0.875 ** 2;

  assert.equal(projection.status, 'ready');
  assert.equal(projection.timeModes[0].modelSeconds, 100);
  assert.equal(projection.timeModes[1].modelSeconds, 115);
  assert.deepEqual(
    projection.timeModes[0].customGcodeSeconds.map((segment) => segment.kind),
    ['pause', 'pause', 'color-change'],
    'repeated kinds remain distinct ordered planner segments',
  );
  close(projection.filaments[0].usage.total.filamentLengthMm, 135 / area);
  close(projection.filaments[0].usage.total.filamentWeightG, 0.1674);
  close(projection.filaments[0].usage.total.cost, 0.003348);
  assert.equal(projection.totals.model.volumeMm3, 300);
  assert.equal(projection.totals.wipeTower.volumeMm3, 30);
  assert.equal(projection.totals.flushed.volumeMm3, 20);
  assert.equal(projection.totals.total.volumeMm3, 370);
  close(projection.totals.timeCost, 0.1);
  close(projection.roleToolUsage[0].usage.filamentWeightG, 0.1612);
  assert.equal(projection.observedEvents.coverage.kind, 'complete');
  assert.equal(projection.observedEvents.toolChangeMarkers, 1);
  assert.equal(projection.processorFilamentChangeCount, 1);
  assert.equal(projection.plannedWipeTowerToolChangeCount, 3);
  assert.match(projection.accessibleLabel, /Plate plate-a: 2 min, 0\.47 g filament/);
  assert.match(projection.accessibleLabel, /USD total cost/);
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.timeModes[0].customGcodeSeconds));
  assert.equal(JSON.stringify(report), snapshot);

  const fractionalTotal = Math.fround(0.3);
  const fractionalPrepare = Math.fround(0.1);
  const fractional = replaceTimeMode(artifact({ includeSilent: false }), 'normal', {
    plannerBlockCount: 2,
    totalSeconds: fractionalTotal,
    prepareSeconds: fractionalPrepare,
    layerSeconds: [fractionalTotal, 0],
    moveSeconds: [{ id: GCODE_RECORD_KIND.EXTRUDE, seconds: fractionalTotal }],
    roleSeconds: [{ id: 1, seconds: fractionalTotal }],
    customGcodeSeconds: [],
  });
  assert.equal(
    projectGcodeStatistics(SOURCE, fractional, binding()).timeModes[0].modelSeconds,
    Math.fround(fractionalTotal - fractionalPrepare),
  );
});

await test('rejects stale schemas and every mismatched job/source/plate/config/engine/output binding field', () => {
  assert.throws(
    () => projectGcodeStatistics(SOURCE, { ...artifact(), version: 2 as 1 }, binding()),
    hasStatisticsCode('invalid-artifact'),
  );
  const mutations: readonly GcodeStatisticsBinding[] = [
    { ...binding(), jobId: 'job-other' },
    { ...binding(), plateId: 'plate-other' },
    { ...binding(), sourceRevision: 8 },
    { ...binding(), sourceHash: sourceHash('7') },
    { ...binding(), sourceAssetHash: sourceHash('8') },
    { ...binding(), projectInputHash: hash('9') },
    { ...binding(), gcodeOutputHash: hash('a') },
    { ...binding(), effectiveConfigHash: hash('b') },
    { ...binding(), engineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { ...binding(), engineArtifactHash: hash('c') },
  ];
  for (const expected of mutations) {
    assert.throws(() => projectGcodeStatistics(SOURCE, artifact(), expected), hasStatisticsCode('binding-mismatch'));
  }
});

await test('marks warning-degraded and bounded-prefix observations while engine values stay authoritative', async () => {
  const degradedText = `${SOURCE_GCODE}\nG1 Xnope`;
  const degradedBinding = binding('plate-a', { gcodeOutputHash: sha256(degradedText) });
  const degradedModel = parseRichGcodeModel(degradedText, { filamentColors: ['#FF0000', '#00FF00'] });
  const degradedProjection = projectGcodeStatistics(
    await verifiedSource(degradedText),
    artifact({ binding: degradedBinding }),
    degradedBinding,
  );
  assert.equal(classifyRichGcodeObservationCoverage(degradedModel).kind, 'degraded');
  assert.equal(degradedProjection.status, 'partial');
  assert.ok(degradedProjection.limitations.some((row) => row.code === 'source-degraded'));

  const prefixOptions: RichGcodeParseOptions = { limits: { records: 1 } };
  const prefixBinding = binding('plate-a', { gcodeOutputHash: SOURCE_OUTPUT_HASH });
  const prefixModel = parseRichGcodeModel(SOURCE_GCODE, prefixOptions);
  const prefixProjection = projectGcodeStatistics(
    await verifiedSource(SOURCE_GCODE, prefixOptions),
    artifact({ binding: prefixBinding }),
    prefixBinding,
  );
  assert.equal(classifyRichGcodeObservationCoverage(prefixModel).kind, 'prefix');
  assert.equal(prefixProjection.observedEvents.coverage.kind, 'prefix');
  assert.ok(prefixProjection.limitations.some((row) => row.code === 'source-prefix'));
  assert.equal(prefixProjection.totals.total.volumeMm3, 370);
});

await test('pins layer totals and ordered custom planner-segment semantics, including a conditional synthetic tail', () => {
  const valid = projectGcodeStatistics(SOURCE, artifact(), binding());
  assert.deepEqual(
    valid.timeModes[0].customGcodeSeconds.map((segment) => [segment.durationSeconds, segment.remainingSeconds]),
    [
      [30, 120],
      [80, 90],
      [10, 10],
    ],
  );
  const withoutCustomSegments = artifact({
    normalCustomSegments: [],
    silentCustomSegments: [],
  });
  assert.equal(
    projectGcodeStatistics(SOURCE, withoutCustomSegments, binding()).timeModes[0].customGcodeSeconds.length,
    0,
  );

  const endingAtPause = artifact({
    normalCustomSegments: [{ kind: 'pause', durationSeconds: 120, remainingSeconds: 120 }],
    silentCustomSegments: [{ kind: 'pause', durationSeconds: 140, remainingSeconds: 140 }],
  });
  assert.equal(
    projectGcodeStatistics(SOURCE, endingAtPause, binding()).timeModes[0].customGcodeSeconds[0].kind,
    'pause',
  );

  const base = artifact();
  const normal = base.timeModes[0];
  const invalidCases = [
    replaceTimeMode(base, 'normal', { layerSeconds: [59, 60] }),
    replaceTimeMode(base, 'normal', { roleSeconds: [] }),
    replaceTimeMode(base, 'normal', {
      moveSeconds: [{ id: GCODE_RECORD_KIND.EXTRUDE, seconds: Math.fround(121) }],
    }),
    replaceTimeMode(base, 'normal', {
      customGcodeSeconds: normal.customGcodeSeconds.map((segment, index) =>
        index === 1 ? { ...segment, remainingSeconds: 89 } : segment,
      ),
    }),
    replaceTimeMode(base, 'normal', { customGcodeSeconds: normal.customGcodeSeconds.slice(0, 2) }),
    replaceTimeMode(base, 'silent', {
      customGcodeSeconds: base.timeModes[1].customGcodeSeconds.map((segment, index) =>
        index === 0 ? { ...segment, kind: 'custom' } : segment,
      ),
    }),
    replaceTimeMode(base, 'silent', { plannerBlockCount: 11 }),
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () => projectGcodeStatistics(SOURCE, invalid, binding()),
      hasStatisticsCode('inconsistent-statistics'),
    );
  }
  assert.throws(
    () => projectGcodeStatistics(SOURCE, replaceTimeMode(base, 'normal', { plannerBlockCount: 1 }), binding()),
    hasStatisticsCode('invalid-artifact'),
  );
});

await test('propagates positive-volume missing assumptions but treats unused tools as exact zero', () => {
  const missingRows = filamentRows();
  missingRows[1] = { ...missingRows[1], diameterMm: null, densityGPerCm3: null, costPerKg: null };
  const missing = projectGcodeStatistics(
    SOURCE,
    artifact({
      filaments: missingRows,
      omissions: [
        { path: 'filaments[1].diameterMm', reason: 'Exact diameter is unavailable' },
        { path: 'filaments[1].densityGPerCm3', reason: 'Exact density is unavailable' },
        { path: 'filaments[1].costPerKg', reason: 'Exact material price is unavailable' },
      ],
    }),
    binding(),
  );
  assert.equal(missing.status, 'partial');
  assert.equal(missing.filaments[1].usage.total.filamentLengthMm, null);
  assert.equal(missing.totals.total.filamentWeightG, null);
  assert.equal(missing.totals.totalCost, null);
  assert.match(missing.accessibleLabel, /filament weight unavailable/);
  assert.doesNotMatch(missing.accessibleLabel, /0 g filament/);

  const unusedRows = filamentRows();
  unusedRows.push({
    tool: 2,
    profileId: 'unused-profile',
    profileHash: hash('c'),
    diameterMm: null,
    densityGPerCm3: null,
    costPerKg: null,
    volumeSampleCount: 0,
    modelVolumeMm3: 0,
    supportVolumeMm3: 0,
    wipeTowerVolumeMm3: 0,
    flushedVolumeMm3: 0,
    totalVolumeMm3: 0,
  });
  const unused = projectGcodeStatistics(SOURCE, artifact({ filaments: unusedRows }), binding());
  assert.equal(unused.status, 'ready');
  assert.equal(unused.filaments[2].usage.total.filamentLengthMm, 0);
  assert.equal(unused.filaments[2].usage.total.filamentWeightG, 0);
  assert.equal(unused.filaments[2].usage.total.cost, 0);
  close(unused.totals.total.filamentWeightG, 0.46585);

  const roundedRows = filamentRows();
  roundedRows[0] = {
    ...roundedRows[0],
    volumeSampleCount: 10_000_000,
    modelVolumeMm3: 999_999_999_999_900,
    supportVolumeMm3: 0,
    wipeTowerVolumeMm3: 0,
    flushedVolumeMm3: 0,
    totalVolumeMm3: 1_000_000_000_000_000,
  };
  assert.equal(projectGcodeStatistics(SOURCE, artifact({ filaments: roundedRows }), binding()).status, 'ready');
});

await test('rejects non-finite inputs and finite arithmetic-overflow payloads', () => {
  const overflowRows = filamentRows();
  overflowRows[0] = {
    ...overflowRows[0],
    modelVolumeMm3: Number.MAX_VALUE,
    supportVolumeMm3: Number.MAX_VALUE,
    wipeTowerVolumeMm3: 0,
    flushedVolumeMm3: 0,
    totalVolumeMm3: Number.MAX_VALUE,
  };
  const overflowBase = artifact({ filaments: overflowRows });
  const overflowReport: AuthoritativeGcodeStatisticsArtifact = {
    ...overflowBase,
    roleToolUsage: overflowBase.roleToolUsage.map((row, index) =>
      index === 0 ? { ...row, volumeMm3: Number.MAX_VALUE } : row,
    ),
  };
  const finiteTimeOverflow = replaceTimeMode(
    artifact({ includeSilent: false, timeCostPerHour: Number.MAX_VALUE }),
    'normal',
    {
      totalSeconds: Number.MAX_VALUE,
      prepareSeconds: 0,
      layerSeconds: [Number.MAX_VALUE / 2, Number.MAX_VALUE / 2],
      customGcodeSeconds: [],
    },
  );

  const invalidCases: readonly AuthoritativeGcodeStatisticsArtifact[] = [
    { ...artifact(), timeCostPerHour: Number.NaN },
    replaceTimeMode(artifact(), 'normal', { totalSeconds: Number.POSITIVE_INFINITY }),
    overflowReport,
    finiteTimeOverflow,
    artifact({
      filaments: filamentRows().map((row, index) => (index === 0 ? { ...row, diameterMm: Number.MIN_VALUE } : row)),
    }),
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () => projectGcodeStatistics(SOURCE, invalid, binding()),
      hasStatisticsCode('invalid-artifact', 'inconsistent-statistics'),
    );
  }
});

await test('rejects sparse arrays, unknown or cyclic fields, and malformed bounded artifacts', () => {
  const sparseSegments = new Array<GcodeCustomTimeBreakdownRow>(3);
  sparseSegments[0] = normalCustomSegments()[0];
  sparseSegments[2] = normalCustomSegments()[2];
  const segmentWithLegacyIdentity = {
    ...normalCustomSegments()[0],
    eventId: 'legacy-author-event',
  } as unknown as GcodeCustomTimeBreakdownRow;
  const extraTopLevel = { ...artifact(), unknownField: true } as unknown as AuthoritativeGcodeStatisticsArtifact;
  const cyclicRecord: Record<string, unknown> = { ...artifact() };
  cyclicRecord.unknownField = cyclicRecord;

  const malformedCases: readonly AuthoritativeGcodeStatisticsArtifact[] = [
    replaceTimeMode(artifact(), 'normal', { customGcodeSeconds: sparseSegments }),
    replaceTimeMode(artifact(), 'normal', {
      customGcodeSeconds: [segmentWithLegacyIdentity, ...normalCustomSegments().slice(1)],
    }),
    extraTopLevel,
    cyclicRecord as unknown as AuthoritativeGcodeStatisticsArtifact,
    { ...artifact(), layerCount: 3 },
    replaceTimeMode(artifact(), 'normal', { prepareSeconds: 121 }),
    {
      ...artifact(),
      filaments: [{ ...artifact().filaments[0], totalVolumeMm3: 999 }, artifact().filaments[1]],
    },
    { ...artifact(), roleToolUsage: [artifact().roleToolUsage[0], artifact().roleToolUsage[0]] },
    { ...artifact(), omissions: [{ path: 'totals.timeCost.detail', reason: 'Unknown nested path' }] },
    { ...artifact(), omissions: [{ path: 'timeCostPerHour', reason: 'Cannot omit a present value' }] },
    {
      ...artifact(),
      filaments: [{ ...artifact().filaments[0], tool: 255 }, artifact().filaments[1]],
    },
    {
      ...artifact(),
      diagnostics: [{ source: 'engine', severity: 'warning', code: 'x', message: 'x'.repeat(513), params: [] }],
    },
  ];
  for (const malformed of malformedCases) {
    assert.throws(
      () => projectGcodeStatistics(SOURCE, malformed, binding()),
      hasStatisticsCode('invalid-artifact', 'inconsistent-statistics'),
    );
  }
});

await test('distinguishes exhaustive clear, non-exhaustive detected, skipped, and unsupported conflict coverage', () => {
  const clear = projectGcodeStatistics(SOURCE, artifact(), binding());
  assert.equal(clear.status, 'ready');
  assert.equal(clear.conflicts.length, 0);

  const notRun = projectGcodeStatistics(
    SOURCE,
    artifact({
      conflictCheck: {
        outcome: 'not-run',
        exhaustive: false,
        reason: 'Adaptive layer heights suppress the pinned checker',
        suppressionReasons: ['adaptive-layer-height'],
      },
    }),
    binding(),
  );
  assert.equal(notRun.status, 'partial');
  assert.ok(notRun.limitations.some((row) => row.code === 'conflict-check-unavailable'));

  const unsupported = projectGcodeStatistics(
    SOURCE,
    artifact({
      conflictCheck: {
        outcome: 'unsupported',
        exhaustive: false,
        reason: 'This engine route did not expose the pinned conflict checker',
        suppressionReasons: [],
      },
    }),
    binding(),
  );
  assert.equal(unsupported.status, 'partial');
  assert.ok(unsupported.limitations.some((row) => row.code === 'conflict-check-unavailable'));

  const wipeConflict = conflict();
  const detected = projectGcodeStatistics(
    SOURCE,
    artifact({
      conflictCheck: {
        outcome: 'detected',
        exhaustive: false,
        reason: 'Pinned checker reports at most one non-deterministically selected conflict',
        suppressionReasons: [],
      },
      conflicts: [
        {
          ...wipeConflict,
          subjects: [wipeConflict.subjects[0], { kind: 'wipe-tower', name: 'Wipe tower' }],
        },
      ],
    }),
    binding(),
  );
  assert.equal(detected.status, 'partial');
  assert.ok(detected.limitations.some((row) => row.code === 'conflict-check-non-exhaustive'));
  assert.equal(detected.conflicts[0].subjects[1].kind, 'wipe-tower');
  assert.notEqual(
    wipeConflict.subjects[0].kind === 'object' ? wipeConflict.subjects[0].objectId : '',
    wipeConflict.subjects[1].kind === 'object' ? wipeConflict.subjects[1].objectId : '',
    'duplicate display names do not collapse canonical object identities',
  );

  assert.throws(
    () =>
      projectGcodeStatistics(
        SOURCE,
        artifact({
          conflictCheck: {
            outcome: 'detected',
            exhaustive: false,
            reason: 'Non-exhaustive',
            suppressionReasons: [],
          },
          conflicts: [{ ...conflict(), layerUpperBoundOrdinal: 3 }],
        }),
        binding(),
      ),
    hasStatisticsCode('invalid-artifact'),
  );

  const duplicateSubject = conflict();
  assert.throws(
    () =>
      projectGcodeStatistics(
        SOURCE,
        artifact({
          conflictCheck: {
            outcome: 'detected',
            exhaustive: false,
            reason: 'Non-exhaustive',
            suppressionReasons: [],
          },
          conflicts: [{ ...duplicateSubject, subjects: [duplicateSubject.subjects[0], duplicateSubject.subjects[0]] }],
        }),
        binding(),
      ),
    hasStatisticsCode('invalid-artifact'),
  );
});

await test('aggregates same-source plates by tool plus profile fingerprint and preserves plate-scoped segments', () => {
  const firstBinding = binding('plate-a');
  const secondBinding = binding('plate-b', { projectInputHash: hash('7') });
  const first = projectGcodeStatistics(
    SOURCE,
    artifact({ binding: firstBinding, filaments: sameProfileAcrossToolsRows() }),
    firstBinding,
  );
  const second = projectGcodeStatistics(
    SOURCE,
    artifact({ binding: secondBinding, filaments: sameProfileAcrossToolsRows(), timeCostPerHour: 6 }),
    secondBinding,
  );
  const all = aggregateGcodeStatistics([first, second]);

  assert.equal(all.status, 'ready');
  assert.equal(all.plateCount, 2);
  assert.equal(all.layerCount, 4);
  assert.equal(all.timeModes[0].totalSeconds, 240);
  assert.equal('layerSeconds' in all.timeModes[0], false, 'no fictitious all-plate layer sequence is exposed');
  assert.equal(all.timeModes[0].customGcodeSeconds.length, 6);
  assert.deepEqual(
    all.timeModes[0].customGcodeSeconds.map((segment) => segment.plateId),
    ['plate-a', 'plate-a', 'plate-a', 'plate-b', 'plate-b', 'plate-b'],
  );
  assert.equal(new Set(all.filaments.map((row) => row.profileHash)).size, 1);
  assert.deepEqual(
    all.filaments.map((row) => row.tool),
    [0, 1],
    'two physical tools sharing one profile fingerprint remain separate groups',
  );
  assert.ok(all.filaments.every((row) => row.sources.length === 2));
  assert.deepEqual(
    all.filaments.map((row) => row.volumeSampleCount),
    [8, 6],
  );
  assert.ok(all.roleToolUsage.every((row) => row.sources.length === 2));
  close(all.totals.timeCost, 0.3);
  assert.deepEqual(
    all.timeCostAssumptions.map((row) => row.costPerHour),
    [3, 6],
  );
  assert.equal(all.diagnostics[1].plateId, 'plate-b');
  assert.equal(all.bindings[1].projectInputHash, hash('7'));
  assert.ok(Object.isFrozen(all));
});

await test('keeps distinct profiles separate, permits same-unit prices, and rejects mixed cost units', () => {
  const firstBinding = binding('plate-a');
  const secondBinding = binding('plate-b');
  const first = projectGcodeStatistics(SOURCE, artifact({ binding: firstBinding }), firstBinding);
  const differentProfiles = filamentRows().map((filament, index) => ({
    ...filament,
    profileId: `${filament.profileId}-other`,
    profileHash: hash(index === 0 ? 'd' : 'e'),
    costPerKg: filament.costPerKg === null ? null : filament.costPerKg + 5,
  }));
  const second = projectGcodeStatistics(
    SOURCE,
    artifact({ binding: secondBinding, filaments: differentProfiles }),
    secondBinding,
  );
  assert.equal(aggregateGcodeStatistics([first, second]).filaments.length, 4);

  const eur: GcodeStatisticsCostUnit = { id: 'EUR', label: 'EUR' };
  const eurBinding = binding('plate-c');
  const eurPlate = projectGcodeStatistics(SOURCE, artifact({ binding: eurBinding, costUnit: eur }), eurBinding);
  assert.throws(() => aggregateGcodeStatistics([first, eurPlate]), hasStatisticsCode('incompatible-plates'));

  const unknownCostBinding = binding('plate-d');
  const unknownCostRows = differentProfiles.map((filament) => ({ ...filament, costPerKg: null }));
  const unknownCostPlate = projectGcodeStatistics(
    SOURCE,
    artifact({
      binding: unknownCostBinding,
      filaments: unknownCostRows,
      costUnit: null,
      timeCostPerHour: null,
      omissions: [
        { path: 'costUnit', reason: 'No canonical unit was exported' },
        { path: 'timeCostPerHour', reason: 'Machine time price was not exported' },
        { path: 'filaments[0].costPerKg', reason: 'Material price was not exported' },
        { path: 'filaments[1].costPerKg', reason: 'Material price was not exported' },
      ],
    }),
    unknownCostBinding,
  );
  const partiallyPriced = aggregateGcodeStatistics([first, unknownCostPlate]);
  assert.equal(partiallyPriced.costUnit?.id, 'USD');
  assert.equal(partiallyPriced.totals.totalCost, null);
  assert.match(partiallyPriced.filaments.find((row) => row.profileHash === hash('a'))!.accessibleLabel, /USD/);
});

await test('marks partial silent-mode aggregation and strictly propagates unavailable material assumptions', () => {
  const firstBinding = binding('plate-a');
  const secondBinding = binding('plate-b');
  const first = projectGcodeStatistics(SOURCE, artifact({ binding: firstBinding }), firstBinding);
  const normalOnly = projectGcodeStatistics(
    SOURCE,
    artifact({ binding: secondBinding, includeSilent: false }),
    secondBinding,
  );
  const partialSilent = aggregateGcodeStatistics([first, normalOnly]);
  assert.equal(normalOnly.status, 'ready');
  assert.equal(partialSilent.status, 'partial');
  assert.deepEqual(
    partialSilent.timeModes.map((mode) => mode.id),
    ['normal'],
  );
  assert.ok(
    partialSilent.limitations.some(
      (row) => row.code === 'silent-mode-partial' && row.plateId === secondBinding.plateId,
    ),
  );

  const missingRows = filamentRows();
  missingRows[1] = { ...missingRows[1], densityGPerCm3: null };
  const missing = projectGcodeStatistics(
    SOURCE,
    artifact({
      binding: secondBinding,
      filaments: missingRows,
      omissions: [{ path: 'filaments[1].densityGPerCm3', reason: 'Density was not exported' }],
    }),
    secondBinding,
  );
  const unavailable = aggregateGcodeStatistics([first, missing]);
  assert.equal(unavailable.status, 'partial');
  assert.equal(unavailable.totals.total.filamentWeightG, null);
  assert.equal(unavailable.totals.totalCost, null);
  assert.match(unavailable.accessibleLabel, /filament weight unavailable/);
});

await test('rejects duplicate, incompatible, empty, and forged aggregate projections', () => {
  const firstBinding = binding('plate-a');
  const first = projectGcodeStatistics(SOURCE, artifact({ binding: firstBinding }), firstBinding);
  assert.throws(() => aggregateGcodeStatistics([first, first]), hasStatisticsCode('incompatible-plates'));

  const otherSourceBinding = binding('plate-c', { sourceHash: sourceHash('f') });
  const otherSource = projectGcodeStatistics(SOURCE, artifact({ binding: otherSourceBinding }), otherSourceBinding);
  assert.throws(() => aggregateGcodeStatistics([first, otherSource]), hasStatisticsCode('incompatible-plates'));

  const forged: GcodeStatisticsProjection = { ...first };
  assert.throws(() => aggregateGcodeStatistics([forged]), hasStatisticsCode('incompatible-plates'));
  const overriddenContainer = [first];
  Object.defineProperty(overriddenContainer, 'map', { value: () => [] });
  assert.throws(() => aggregateGcodeStatistics(overriddenContainer), hasStatisticsCode('incompatible-plates'));
  assert.throws(() => aggregateGcodeStatistics([]), hasStatisticsCode('aggregation-cap'));
});

await test('rejects wrong rich-column constructors and sparse warning arrays before coverage classification', () => {
  const raw = parseRichGcodeModel(SOURCE_GCODE, { filamentColors: ['#FF0000', '#00FF00'] });
  const wrongKind: RichGcodeModel = {
    ...raw,
    columns: {
      ...raw.columns,
      kind: new Uint16Array(raw.columns.kind),
    } as unknown as RichGcodeModel['columns'],
  };
  assert.throws(() => classifyRichGcodeObservationCoverage(wrongKind), hasStatisticsCode('invalid-model'));

  class KindSubclass extends Uint8Array {}
  const subclassKind: RichGcodeModel = {
    ...raw,
    columns: { ...raw.columns, kind: new KindSubclass(raw.columns.kind) },
  };
  assert.throws(() => classifyRichGcodeObservationCoverage(subclassKind), hasStatisticsCode('invalid-model'));

  const ownLengthKind = new Uint8Array(raw.columns.kind);
  Object.defineProperty(ownLengthKind, 'length', { value: ownLengthKind.length });
  assert.throws(
    () =>
      classifyRichGcodeObservationCoverage({
        ...raw,
        columns: { ...raw.columns, kind: ownLengthKind },
      }),
    hasStatisticsCode('invalid-model'),
  );

  const ownIteratorKind = new Uint8Array(raw.columns.kind);
  Object.defineProperty(ownIteratorKind, Symbol.iterator, {
    value: Uint8Array.prototype[Symbol.iterator],
  });
  assert.throws(
    () =>
      classifyRichGcodeObservationCoverage({
        ...raw,
        columns: { ...raw.columns, kind: ownIteratorKind },
      }),
    hasStatisticsCode('invalid-model'),
  );

  const sparseWarnings = new Array<RichGcodeModel['warnings'][number]>(1);
  const sparseModel: RichGcodeModel = { ...raw, warnings: sparseWarnings };
  assert.throws(() => classifyRichGcodeObservationCoverage(sparseModel), hasStatisticsCode('invalid-model'));
  assert.throws(() => classifyRichGcodeObservationCoverage(new Proxy(raw, {})), hasStatisticsCode('invalid-model'));
});

console.log(`\n${passed} G-code statistics-model tests passed.`);
