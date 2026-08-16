/**
 * What this machine has already been calibrated for, and whether a past result
 * may be applied to what is loaded now (parity P8.5).
 *
 * A calibration number is only meaningful together with the machine, nozzle,
 * and material it was measured on. A pressure-advance value from a 0.4 mm
 * nozzle printing PLA is simply wrong on a 0.6 mm nozzle printing PETG, and
 * applying it silently produces a worse print than never calibrating at all.
 * So every record carries the conditions it was measured under, and applying
 * one is gated on those conditions still holding — {@link assessCalibrationApplicability}
 * names each mismatch rather than returning a bare boolean.
 *
 * Three further rules shape this module.
 *
 * A record is evidence, so it is written once and never edited. Correcting a
 * measurement means recording another run; the ledger is append-and-delete, and
 * a comparison between two runs is the supported way to see a change.
 *
 * Re-running is bound to the method that produced the result. A definition
 * carries a fingerprint, and a re-run request against a definition whose
 * fingerprint has moved is refused rather than silently recompiled under
 * different geometry — otherwise "re-run" would quietly mean "run something
 * else and compare it to the old number".
 *
 * An export carries no secret. The record type has no field for a host, a
 * token, or a key, and the exporter additionally proves it: a payload
 * containing a credential-shaped key is refused rather than written.
 */

import { canonicalStringify, fnv1a64Text } from '../domain/canonical';
import type { CalibrationPresetTarget, CalibrationWorkflowId } from '../../features/calibrationInventory';
import type { CalibrationJobPlan, CalibrationJobRequest, CalibrationParameterValue } from './types';
import { CALIBRATION_JOB_DEFINITION_VERSION, CALIBRATION_JOB_SCHEMA_VERSION } from './types';

export const CALIBRATION_HISTORY_SCHEMA_VERSION = 1 as const;
export const CALIBRATION_HISTORY_FORMAT = 'orcaxr.calibration-history';

/** Newest first, and bounded: a ledger is for deciding, not for archiving. */
export const MAX_CALIBRATION_RECORDS = 200;

/**
 * The conditions a measurement was taken under. Deliberately descriptive and
 * hashed rather than addressable: a printer is identified by what it *is*, so a
 * record can outlive the endpoint it was captured through and can never carry
 * one.
 */
export interface CalibrationConditions {
  readonly printerModel: string;
  readonly firmwareFlavor: string;
  readonly firmwareVersion: string;
  readonly nozzleDiameterMm: number;
  readonly filamentMaterial: string;
  /** Stable hash of the filament preset this ran against. */
  readonly filamentPresetHash: string;
  /** Stable hash of the process preset this ran against. */
  readonly processPresetHash: string;
}

export interface CalibrationMeasurement {
  readonly key: string;
  readonly value: number | string;
  readonly unit: string | null;
}

export interface CalibrationChosenResult {
  readonly key: string;
  readonly value: number | string;
  readonly unit: string | null;
}

/** The preset version a result was written into, when one was written. */
export interface CalibrationAppliedPreset {
  readonly scope: CalibrationPresetTarget['scope'];
  readonly presetName: string;
  readonly presetVersion: string;
  readonly key: string;
}

export interface CalibrationRecord {
  readonly schemaVersion: typeof CALIBRATION_HISTORY_SCHEMA_VERSION;
  readonly id: string;
  readonly recordedAt: string;
  readonly operator: string;
  readonly method: {
    readonly definitionId: CalibrationWorkflowId;
    readonly definitionVersion: number;
    readonly fingerprint: string;
    readonly label: string;
  };
  readonly parameters: Readonly<Record<string, CalibrationParameterValue>>;
  readonly conditions: CalibrationConditions;
  readonly artifacts: {
    readonly projectHash: string;
    readonly gcodeHash: string | null;
  };
  readonly measurements: readonly CalibrationMeasurement[];
  /** The value the operator selected, or null when a run produced no usable one. */
  readonly chosen: CalibrationChosenResult | null;
  readonly appliedPreset: CalibrationAppliedPreset | null;
  readonly note: string | null;
}

export type CalibrationHistoryIssueCode =
  | 'invalid-record'
  | 'invalid-payload'
  | 'unsupported-schema'
  | 'unknown-record'
  | 'missing-measurement'
  | 'unknown-measurement'
  | 'method-changed'
  | 'condition-mismatch'
  | 'secret-in-payload';

export interface CalibrationHistoryIssue {
  readonly code: CalibrationHistoryIssueCode;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

export interface CalibrationHistoryResult {
  readonly ok: boolean;
  readonly issues: readonly CalibrationHistoryIssue[];
}

function issue(
  code: CalibrationHistoryIssueCode,
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): CalibrationHistoryIssue {
  return Object.freeze({ code, severity, path, message });
}

/**
 * Keys that must never reach a record or an export. The list is matched
 * case-insensitively against every key at every depth: an export is shared, and
 * "we did not put a token in it" is a weaker claim than "a token cannot be in
 * it".
 */
const SECRET_LIKE = ['token', 'apikey', 'api_key', 'secret', 'password', 'passwd', 'credential', 'authorization'];

/** Host-shaped values must not travel either: an endpoint identifies a network. */
const HOST_LIKE = /^(?:https?:\/\/|wss?:\/\/)|(?:^|\W)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\W|$)/i;

function looksSecret(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SECRET_LIKE.some((needle) => normalized.includes(needle.replace(/[^a-z_]/g, '')));
}

/** Walk a payload and report anything credential- or endpoint-shaped. */
export function findSecretsInPayload(value: unknown, path = '$'): readonly CalibrationHistoryIssue[] {
  const issues: CalibrationHistoryIssue[] = [];
  const visit = (node: unknown, at: string, depth: number): void => {
    if (depth > 12) return;
    if (typeof node === 'string') {
      if (HOST_LIKE.test(node)) {
        issues.push(issue('secret-in-payload', at, `${at} looks like a network address and may not be exported.`));
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${at}[${index}]`, depth + 1));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) {
        const childPath = `${at}.${key}`;
        if (looksSecret(key)) {
          issues.push(
            issue('secret-in-payload', childPath, `${childPath} is credential-shaped and may not be exported.`),
          );
          continue;
        }
        visit(entry, childPath, depth + 1);
      }
    }
  };
  visit(value, path, 0);
  return Object.freeze(issues);
}

export interface CalibrationRunEntry {
  readonly operator: string;
  readonly recordedAt: string;
  readonly measurements: readonly CalibrationMeasurement[];
  /** Which measured field the operator selected; omitted records an inconclusive run. */
  readonly chosenKey?: string;
  readonly appliedPreset?: CalibrationAppliedPreset;
  readonly note?: string;
  readonly projectHash: string;
  readonly gcodeHash?: string;
}

/**
 * The minimum a record needs to know about the method that produced it.
 *
 * Deliberately smaller than a compiled plan: recording a measurement does not
 * require re-deriving a printer envelope, and demanding one would mean the
 * shell fabricating a machine description just to write down a number.
 */
export interface CalibrationMethodDescriptor {
  readonly definitionId: CalibrationWorkflowId;
  readonly definitionVersion: number;
  readonly fingerprint: string;
  readonly label: string;
  readonly parameters: Readonly<Record<string, CalibrationParameterValue>>;
  readonly resultFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly unit: string | null;
    readonly required: boolean;
  }[];
}

/** The method behind a compiled plan — the sweep that actually ran. */
export function calibrationMethodFromPlan(plan: CalibrationJobPlan): CalibrationMethodDescriptor {
  return Object.freeze({
    definitionId: plan.definitionId,
    definitionVersion: plan.definitionVersion,
    fingerprint: plan.definitionFingerprint,
    label: plan.label,
    parameters: plan.parameters,
    resultFields: plan.resultFields,
  });
}

/** The method behind a definition plus the parameters a run was given. */
export function calibrationMethodFromDefinition(
  definition: {
    readonly id: CalibrationWorkflowId;
    readonly definitionVersion: number;
    readonly fingerprint: string;
    readonly label: string;
    readonly resultFields: CalibrationMethodDescriptor['resultFields'];
  },
  parameters: Readonly<Record<string, CalibrationParameterValue>>,
): CalibrationMethodDescriptor {
  return Object.freeze({
    definitionId: definition.id,
    definitionVersion: definition.definitionVersion,
    fingerprint: definition.fingerprint,
    label: definition.label,
    parameters: { ...parameters },
    resultFields: definition.resultFields,
  });
}

/**
 * Turn one finished run into a record, refusing anything that would make the
 * result unreadable later: a missing required field, a chosen value that was
 * never measured, or a measurement the method does not define.
 */
export function recordCalibrationRun(
  method: CalibrationMethodDescriptor,
  conditions: CalibrationConditions,
  entry: CalibrationRunEntry,
): { readonly record?: CalibrationRecord; readonly issues: readonly CalibrationHistoryIssue[] } {
  const issues: CalibrationHistoryIssue[] = [];
  const defined = new Map(method.resultFields.map((field) => [field.key, field]));
  const measured = new Map<string, CalibrationMeasurement>();

  for (const [index, measurement] of entry.measurements.entries()) {
    const path = `$.measurements[${index}]`;
    const field = defined.get(measurement.key);
    if (!field) {
      issues.push(
        issue(
          'unknown-measurement',
          path,
          `${method.label} defines no result field ${JSON.stringify(measurement.key)}.`,
        ),
      );
      continue;
    }
    if (typeof measurement.value === 'number' && !Number.isFinite(measurement.value)) {
      issues.push(issue('invalid-record', path, 'A measured value must be finite.'));
      continue;
    }
    if (typeof measurement.value === 'string' && !measurement.value.trim()) {
      issues.push(issue('invalid-record', path, 'A measured value must not be empty.'));
      continue;
    }
    measured.set(measurement.key, Object.freeze({ ...measurement, unit: field.unit }));
  }

  for (const field of method.resultFields) {
    if (field.required && !measured.has(field.key)) {
      issues.push(
        issue('missing-measurement', `$.measurements.${field.key}`, `${method.label} requires ${field.label}.`),
      );
    }
  }

  let chosen: CalibrationChosenResult | null = null;
  if (entry.chosenKey !== undefined) {
    const selected = measured.get(entry.chosenKey);
    if (!selected) {
      issues.push(
        issue(
          'unknown-measurement',
          '$.chosen',
          `${JSON.stringify(entry.chosenKey)} was chosen but never measured; a result must be one of the values taken.`,
        ),
      );
    } else {
      chosen = Object.freeze({ key: selected.key, value: selected.value, unit: selected.unit });
    }
  }

  if (!entry.operator.trim()) {
    issues.push(issue('invalid-record', '$.operator', 'A record names who took the measurement.'));
  }
  if (Number.isNaN(Date.parse(entry.recordedAt))) {
    issues.push(issue('invalid-record', '$.recordedAt', 'recordedAt must be an ISO-8601 timestamp.'));
  }
  issues.push(...findSecretsInPayload({ conditions, entry }));

  if (issues.some((candidate) => candidate.severity === 'error')) return { issues: Object.freeze(issues) };

  const body = {
    schemaVersion: CALIBRATION_HISTORY_SCHEMA_VERSION,
    recordedAt: entry.recordedAt,
    operator: entry.operator.trim(),
    method: {
      definitionId: method.definitionId,
      definitionVersion: method.definitionVersion,
      fingerprint: method.fingerprint,
      label: method.label,
    },
    parameters: { ...method.parameters },
    conditions: { ...conditions },
    artifacts: { projectHash: entry.projectHash, gcodeHash: entry.gcodeHash ?? null },
    measurements: [...measured.values()].sort((left, right) => (left.key < right.key ? -1 : 1)),
    chosen,
    appliedPreset: entry.appliedPreset ?? null,
    note: entry.note?.trim() ? entry.note.trim() : null,
  };
  // The identity is the content: two byte-identical runs are the same evidence,
  // and a re-import cannot fork the ledger by re-keying what it already holds.
  const record: CalibrationRecord = Object.freeze({
    ...body,
    id: `calib:${fnv1a64Text(canonicalStringify(body))}`,
  }) as CalibrationRecord;
  return { record, issues: Object.freeze(issues) };
}

export interface CalibrationConditionMismatch {
  readonly field: keyof CalibrationConditions;
  readonly recorded: string;
  readonly current: string;
  /** True when the difference invalidates the result rather than merely noting it. */
  readonly blocking: boolean;
}

export interface CalibrationApplicability {
  readonly applicable: boolean;
  readonly mismatches: readonly CalibrationConditionMismatch[];
  readonly issues: readonly CalibrationHistoryIssue[];
}

/**
 * Fields whose change invalidates a measurement outright. Nozzle diameter and
 * material change the physics; the printer model changes the machine. A
 * firmware version change is worth saying and not worth refusing over.
 */
const BLOCKING_CONDITIONS: ReadonlySet<keyof CalibrationConditions> = new Set([
  'printerModel',
  'nozzleDiameterMm',
  'filamentMaterial',
  'filamentPresetHash',
]);

/** Whether a past result may be applied to what is loaded now, and why not. */
export function assessCalibrationApplicability(
  record: CalibrationRecord,
  current: CalibrationConditions,
): CalibrationApplicability {
  const mismatches: CalibrationConditionMismatch[] = [];
  for (const field of Object.keys(record.conditions) as (keyof CalibrationConditions)[]) {
    const recorded = record.conditions[field];
    const now = current[field];
    if (String(recorded) === String(now)) continue;
    mismatches.push(
      Object.freeze({
        field,
        recorded: String(recorded),
        current: String(now),
        blocking: BLOCKING_CONDITIONS.has(field),
      }),
    );
  }
  const issues = mismatches
    .filter((mismatch) => mismatch.blocking)
    .map((mismatch) =>
      issue(
        'condition-mismatch',
        `$.conditions.${mismatch.field}`,
        `This result was measured with ${mismatch.field} ${mismatch.recorded}; the project is set to ${mismatch.current}.`,
      ),
    );
  const warnings = mismatches
    .filter((mismatch) => !mismatch.blocking)
    .map((mismatch) =>
      issue(
        'condition-mismatch',
        `$.conditions.${mismatch.field}`,
        `Measured with ${mismatch.field} ${mismatch.recorded}; now ${mismatch.current}.`,
        'warning',
      ),
    );
  return Object.freeze({
    // A run that produced no chosen value has nothing to apply, whatever the
    // conditions say.
    applicable: record.chosen !== null && issues.length === 0,
    mismatches: Object.freeze(mismatches),
    issues: Object.freeze([...issues, ...warnings]),
  });
}

export interface CalibrationComparison {
  readonly sameMethod: boolean;
  readonly sameConditions: boolean;
  readonly conditionDifferences: readonly CalibrationConditionMismatch[];
  readonly parameterDifferences: readonly {
    readonly key: string;
    readonly left: CalibrationParameterValue | null;
    readonly right: CalibrationParameterValue | null;
  }[];
  readonly measurementDifferences: readonly {
    readonly key: string;
    readonly left: number | string | null;
    readonly right: number | string | null;
    /** Present only when both sides are numbers, so a delta is a real delta. */
    readonly delta: number | null;
  }[];
  /** Why the two runs may not be read as measuring the same thing, if so. */
  readonly caveats: readonly string[];
}

/** Compare two runs field by field, and say when they are not comparable. */
export function compareCalibrationRecords(left: CalibrationRecord, right: CalibrationRecord): CalibrationComparison {
  const sameMethod = left.method.definitionId === right.method.definitionId;
  const conditionDifferences: CalibrationConditionMismatch[] = [];
  for (const field of Object.keys(left.conditions) as (keyof CalibrationConditions)[]) {
    if (String(left.conditions[field]) === String(right.conditions[field])) continue;
    conditionDifferences.push(
      Object.freeze({
        field,
        recorded: String(left.conditions[field]),
        current: String(right.conditions[field]),
        blocking: BLOCKING_CONDITIONS.has(field),
      }),
    );
  }

  const parameterKeys = [...new Set([...Object.keys(left.parameters), ...Object.keys(right.parameters)])].sort();
  const parameterDifferences = parameterKeys
    .map((key) => ({
      key,
      left: (left.parameters[key] ?? null) as CalibrationParameterValue | null,
      right: (right.parameters[key] ?? null) as CalibrationParameterValue | null,
    }))
    .filter((entry) => canonicalStringify(entry.left) !== canonicalStringify(entry.right))
    .map((entry) => Object.freeze(entry));

  const leftMeasured = new Map(left.measurements.map((measurement) => [measurement.key, measurement.value]));
  const rightMeasured = new Map(right.measurements.map((measurement) => [measurement.key, measurement.value]));
  const measurementKeys = [...new Set([...leftMeasured.keys(), ...rightMeasured.keys()])].sort();
  const measurementDifferences = measurementKeys
    .map((key) => {
      const leftValue = leftMeasured.get(key) ?? null;
      const rightValue = rightMeasured.get(key) ?? null;
      const delta = typeof leftValue === 'number' && typeof rightValue === 'number' ? rightValue - leftValue : null;
      return Object.freeze({ key, left: leftValue, right: rightValue, delta });
    })
    .filter((entry) => entry.left !== entry.right)
    .map((entry) => Object.freeze(entry));

  const caveats: string[] = [];
  if (!sameMethod) caveats.push('These runs used different calibration methods, so their numbers are not comparable.');
  else if (left.method.fingerprint !== right.method.fingerprint) {
    caveats.push('The method changed between these runs, so identical numbers may not mean identical geometry.');
  }
  if (conditionDifferences.some((difference) => difference.blocking)) {
    caveats.push('These runs were measured under different printing conditions.');
  }
  if (parameterDifferences.length > 0) caveats.push('These runs swept different parameter values.');

  return Object.freeze({
    sameMethod,
    sameConditions: conditionDifferences.length === 0,
    conditionDifferences: Object.freeze(conditionDifferences),
    parameterDifferences: Object.freeze(parameterDifferences),
    measurementDifferences: Object.freeze(measurementDifferences),
    caveats: Object.freeze(caveats),
  });
}

/**
 * Whether a record's method still is what it was, and why not.
 *
 * Shared with {@link calibrationRerunRequest} so "can this be repeated" and
 * "repeat it" can never disagree.
 */
export function canRerunCalibration(
  record: CalibrationRecord,
  definition: { readonly id: string; readonly fingerprint: string } | undefined,
): readonly CalibrationHistoryIssue[] {
  if (!definition || definition.id !== record.method.definitionId) {
    return Object.freeze([
      issue('method-changed', '$.method.definitionId', 'That record was produced by a different calibration.'),
    ]);
  }
  if (definition.fingerprint !== record.method.fingerprint) {
    return Object.freeze([
      issue(
        'method-changed',
        '$.method.fingerprint',
        `${record.method.label} has changed since this run; re-running would measure different geometry. ` +
          'Start a fresh run instead of repeating this one.',
      ),
    ]);
  }
  return Object.freeze([]);
}

/**
 * Rebuild the request that produced a record, so it can be run again under the
 * same method and parameters.
 *
 * Refused when the definition has moved: recompiling the old parameters under
 * new geometry would produce a number the operator would compare against the
 * old one as if nothing had changed.
 */
export function calibrationRerunRequest(
  record: CalibrationRecord,
  definition: { readonly id: string; readonly fingerprint: string; readonly definitionVersion: number },
  prerequisites: CalibrationJobRequest['prerequisites'],
): { readonly request?: CalibrationJobRequest; readonly issues: readonly CalibrationHistoryIssue[] } {
  const blocking = canRerunCalibration(record, definition);
  if (blocking.length > 0) return { issues: blocking };
  return {
    request: Object.freeze({
      schemaVersion: CALIBRATION_JOB_SCHEMA_VERSION,
      definitionId: record.method.definitionId,
      definitionVersion: CALIBRATION_JOB_DEFINITION_VERSION,
      definitionFingerprint: record.method.fingerprint,
      execution: 'manual',
      parameters: { ...record.parameters },
      prerequisites,
    }) as CalibrationJobRequest,
    issues: Object.freeze([]),
  };
}

/** Append-and-delete ledger, newest first and bounded. */
export class CalibrationHistory {
  private records: readonly CalibrationRecord[] = Object.freeze([]);

  constructor(records: readonly CalibrationRecord[] = []) {
    this.records = Object.freeze(sortRecords(records));
  }

  list(filter: { readonly definitionId?: string } = {}): readonly CalibrationRecord[] {
    return Object.freeze(
      this.records.filter(
        (record) => filter.definitionId === undefined || record.method.definitionId === filter.definitionId,
      ),
    );
  }

  get(id: string): CalibrationRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  /** Add one record. Re-adding identical evidence is a no-op, not a duplicate. */
  add(record: CalibrationRecord): CalibrationHistoryResult {
    if (this.records.some((candidate) => candidate.id === record.id)) {
      return Object.freeze({ ok: true, issues: Object.freeze([]) });
    }
    this.records = Object.freeze(sortRecords([record, ...this.records]).slice(0, MAX_CALIBRATION_RECORDS));
    return Object.freeze({ ok: true, issues: Object.freeze([]) });
  }

  delete(id: string): CalibrationHistoryResult {
    if (!this.records.some((record) => record.id === id)) {
      return Object.freeze({
        ok: false,
        issues: Object.freeze([issue('unknown-record', '$', `No calibration record ${JSON.stringify(id)}.`)]),
      });
    }
    this.records = Object.freeze(this.records.filter((record) => record.id !== id));
    return Object.freeze({ ok: true, issues: Object.freeze([]) });
  }

  clear(): void {
    this.records = Object.freeze([]);
  }

  get size(): number {
    return this.records.length;
  }
}

/**
 * One ledger change requested by a surface. Recording, comparing, re-running,
 * exporting, and deleting all arrive here, so a panel and an automation client
 * take the same validated path.
 */
export type CalibrationHistoryOperation =
  | { readonly kind: 'refresh' }
  | {
      readonly kind: 'record';
      readonly definitionId: string;
      readonly entry: CalibrationRunEntry;
    }
  | { readonly kind: 'compare'; readonly leftId: string; readonly rightId: string }
  | { readonly kind: 'rerun'; readonly recordId: string }
  | { readonly kind: 'apply'; readonly recordId: string }
  | { readonly kind: 'delete'; readonly recordId: string }
  | { readonly kind: 'export' };

export interface CalibrationHistoryExport {
  readonly format: typeof CALIBRATION_HISTORY_FORMAT;
  readonly schemaVersion: typeof CALIBRATION_HISTORY_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly records: readonly CalibrationRecord[];
}

/**
 * A deterministic, secret-free export. The scan is not decoration: this file is
 * the one an operator attaches to a forum post.
 */
export function exportCalibrationHistory(
  records: readonly CalibrationRecord[],
  exportedAt: string,
): { readonly text?: string; readonly issues: readonly CalibrationHistoryIssue[] } {
  const payload: CalibrationHistoryExport = {
    format: CALIBRATION_HISTORY_FORMAT,
    schemaVersion: CALIBRATION_HISTORY_SCHEMA_VERSION,
    exportedAt,
    records: sortRecords(records),
  };
  const secrets = findSecretsInPayload(payload);
  if (secrets.length > 0) return { issues: secrets };
  return { text: canonicalStringify(payload), issues: Object.freeze([]) };
}

/**
 * Read an export, migrating an older schema forward.
 *
 * Version 0 is the pre-conditions shape: it recorded a measurement without the
 * nozzle and material it was taken on. Those records are readable but can never
 * be applied, so they migrate with conditions marked unknown rather than being
 * dropped — losing the history would be worse, and inventing conditions would
 * be a lie that later auto-applies.
 */
export function importCalibrationHistory(text: string): {
  readonly records?: readonly CalibrationRecord[];
  readonly issues: readonly CalibrationHistoryIssue[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      issues: Object.freeze([
        issue('invalid-payload', '$', `Not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`),
      ]),
    };
  }
  if (!isRecordObject(parsed) || parsed.format !== CALIBRATION_HISTORY_FORMAT) {
    return { issues: Object.freeze([issue('invalid-payload', '$.format', 'Not a calibration history export.')]) };
  }
  const version = parsed.schemaVersion;
  if (version !== 0 && version !== CALIBRATION_HISTORY_SCHEMA_VERSION) {
    return {
      issues: Object.freeze([
        issue(
          'unsupported-schema',
          '$.schemaVersion',
          `Schema version ${String(version)} is not readable by this build (expected ${CALIBRATION_HISTORY_SCHEMA_VERSION} or 0).`,
        ),
      ]),
    };
  }
  if (!Array.isArray(parsed.records)) {
    return { issues: Object.freeze([issue('invalid-payload', '$.records', 'records must be an array.')]) };
  }

  const issues: CalibrationHistoryIssue[] = [];
  const records: CalibrationRecord[] = [];
  for (const [index, entry] of parsed.records.entries()) {
    const path = `$.records[${index}]`;
    const record = version === 0 ? migrateV0Record(entry, path, issues) : parseRecord(entry, path, issues);
    if (record) records.push(record);
  }
  issues.push(...findSecretsInPayload({ records }));
  if (issues.some((candidate) => candidate.severity === 'error')) return { issues: Object.freeze(issues) };
  return { records: Object.freeze(sortRecords(records)), issues: Object.freeze(issues) };
}

/** Conditions a v0 record never recorded; readable, never applicable. */
export const UNKNOWN_CONDITION = 'unknown';

function migrateV0Record(
  entry: unknown,
  path: string,
  issues: CalibrationHistoryIssue[],
): CalibrationRecord | undefined {
  if (!isRecordObject(entry)) {
    issues.push(issue('invalid-record', path, 'Record must be an object.'));
    return undefined;
  }
  const upgraded = {
    ...entry,
    schemaVersion: CALIBRATION_HISTORY_SCHEMA_VERSION,
    conditions: isRecordObject(entry.conditions) ? { ...v0Conditions(), ...entry.conditions } : v0Conditions(),
  };
  const record = parseRecord(upgraded, path, issues);
  if (record) {
    issues.push(
      issue(
        'condition-mismatch',
        path,
        'This record predates condition tracking, so it can be read and compared but never applied.',
        'warning',
      ),
    );
  }
  return record;
}

function v0Conditions(): CalibrationConditions {
  return {
    printerModel: UNKNOWN_CONDITION,
    firmwareFlavor: UNKNOWN_CONDITION,
    firmwareVersion: UNKNOWN_CONDITION,
    nozzleDiameterMm: Number.NaN,
    filamentMaterial: UNKNOWN_CONDITION,
    filamentPresetHash: UNKNOWN_CONDITION,
    processPresetHash: UNKNOWN_CONDITION,
  };
}

function parseRecord(entry: unknown, path: string, issues: CalibrationHistoryIssue[]): CalibrationRecord | undefined {
  if (!isRecordObject(entry)) {
    issues.push(issue('invalid-record', path, 'Record must be an object.'));
    return undefined;
  }
  const method = entry.method;
  const conditions = entry.conditions;
  if (!isRecordObject(method) || typeof method.definitionId !== 'string' || typeof method.fingerprint !== 'string') {
    issues.push(issue('invalid-record', `${path}.method`, 'Record must name the method that produced it.'));
    return undefined;
  }
  if (!isRecordObject(conditions)) {
    issues.push(
      issue('invalid-record', `${path}.conditions`, 'Record must carry the conditions it was measured under.'),
    );
    return undefined;
  }
  if (typeof entry.id !== 'string' || typeof entry.recordedAt !== 'string' || typeof entry.operator !== 'string') {
    issues.push(issue('invalid-record', path, 'Record must carry an id, a timestamp, and an operator.'));
    return undefined;
  }
  if (!Array.isArray(entry.measurements)) {
    issues.push(issue('invalid-record', `${path}.measurements`, 'measurements must be an array.'));
    return undefined;
  }
  return Object.freeze(entry as unknown as CalibrationRecord);
}

function sortRecords(records: readonly CalibrationRecord[]): CalibrationRecord[] {
  return [...records].sort((left, right) => {
    if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? 1 : -1;
    return left.id < right.id ? -1 : 1;
  });
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
