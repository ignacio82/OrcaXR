/**
 * Editing a calibration's parameters, and seeing what they produce (P8.3).
 *
 * The plan asks for parameter dialogs, a preview, and regenerate. All three are
 * one question — "what would these settings actually make?" — and the compiler
 * already answers it: `compileCalibrationJob` validates against the pinned
 * definition and either returns a plan or throws typed issues. So nothing here
 * re-implements a rule. This turns a definition into a form, turns edits back
 * into a request, and hands the compiler the result; regenerate is just asking
 * again, which is why it is not a separate concept.
 *
 * Text in, values out. A number field yields a string until it is parsed, and
 * parsing is where a form usually loses information: `Number('')` is 0, and
 * silently calibrating at zero because a field was cleared is exactly the class
 * of quiet wrongness this project keeps finding. Empty means absent here, and
 * an unparseable entry is reported rather than coerced.
 */

import { CalibrationJobValidationError, compileCalibrationJob, createDefaultCalibrationJobRequest } from './compiler';
import { getCalibrationJobDefinition } from './definitions';
import type {
  CalibrationJobPlan,
  CalibrationJobPrerequisites,
  CalibrationParameterDefinition,
  CalibrationParameterValue,
} from './types';
import type { CalibrationWorkflowId } from '../../features/calibrationInventory';
import type { CalibrationJobValidationIssue } from './compiler';

/** One editable row, carrying everything a surface needs to render it. */
export interface CalibrationFormField {
  readonly key: string;
  readonly label: string;
  readonly kind: CalibrationParameterDefinition['kind'];
  readonly unit: string | null;
  readonly editable: boolean;
  readonly choices: readonly string[];
  readonly range: CalibrationParameterDefinition['range'];
  readonly maxItems: number | null;
  /** Current value as text, which is what an input holds. */
  readonly text: string;
  /** True when the value differs from the definition's default. */
  readonly changed: boolean;
}

export interface CalibrationFormPreview {
  readonly fields: readonly CalibrationFormField[];
  /** Present when every parameter parsed and the compiler accepted them. */
  readonly plan: CalibrationJobPlan | null;
  /** Everything wrong, whether this module found it or the compiler did. */
  readonly issues: readonly CalibrationJobValidationIssue[];
}

/** Edits held as text, keyed by parameter, exactly as typed. */
export type CalibrationFormEdits = Readonly<Record<string, string>>;

function formatValue(value: CalibrationParameterValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Parse one field's text back into the shape its definition declares.
 *
 * Returns an issue rather than a value when the text cannot be read. Nothing is
 * guessed: a blank number is absent, not zero, and a list with one unreadable
 * entry is an unreadable list rather than a shorter one.
 */
function parseField(
  parameter: CalibrationParameterDefinition,
  text: string,
): { value: CalibrationParameterValue } | { issue: CalibrationJobValidationIssue } {
  const path = `$.parameters.${parameter.key}`;
  const trimmed = text.trim();
  if (parameter.kind === 'boolean') {
    if (trimmed === 'true') return { value: true };
    if (trimmed === 'false') return { value: false };
    return { issue: { code: 'unreadable-parameter', path, message: `${parameter.label} must be true or false` } };
  }
  if (parameter.kind === 'choice') {
    if (trimmed.length === 0) {
      return { issue: { code: 'unreadable-parameter', path, message: `${parameter.label} needs a choice` } };
    }
    // An unknown choice is passed through deliberately: the compiler owns the
    // list of valid ones, and duplicating that check here is how the two drift.
    return { value: trimmed };
  }
  if (parameter.kind === 'number') {
    if (trimmed.length === 0) {
      return { issue: { code: 'unreadable-parameter', path, message: `${parameter.label} needs a number` } };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { issue: { code: 'unreadable-parameter', path, message: `${parameter.label} is not a number` } };
    }
    return { value: parsed };
  }
  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // An empty list is a value, not a blank. Several pinned calibrations default
  // their `speeds` and `accelerations` to `[]` and mean it — refusing empty here
  // made those workflows uncompilable from their own defaults, which is how this
  // was found. Unlike a lone number, there is no ambiguity to protect against:
  // the compiler owns whether an empty list is allowed for this parameter.
  if (parts.length === 0) return { value: [] };
  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = Number(part);
    if (!Number.isFinite(parsed)) {
      return {
        issue: {
          code: 'unreadable-parameter',
          path,
          message: `${parameter.label} contains “${part}”, which is not a number`,
        },
      };
    }
    numbers.push(parsed);
  }
  return { value: numbers };
}

/**
 * The form for one calibration, and what its current values compile to.
 *
 * `jobId` is a caller's, because compilation is deterministic and must stay so:
 * a preview that minted its own id would produce a different plan every call
 * and could never be compared with the one that gets staged.
 */
export function buildCalibrationForm(
  definitionId: CalibrationWorkflowId,
  prerequisites: CalibrationJobPrerequisites,
  edits: CalibrationFormEdits,
  jobId: string,
): CalibrationFormPreview {
  const definition = getCalibrationJobDefinition(definitionId);
  if (!definition) {
    return Object.freeze({
      fields: Object.freeze([]),
      plan: null,
      issues: Object.freeze([
        { code: 'unknown-definition', path: '$.definitionId', message: `Unknown calibration ${definitionId}` },
      ]),
    });
  }

  const issues: CalibrationJobValidationIssue[] = [];
  const parameters: Record<string, CalibrationParameterValue> = {};
  const fields: CalibrationFormField[] = definition.parameters.map((parameter) => {
    const defaultText = formatValue(parameter.default);
    // A non-editable parameter shows its default and cannot be steered by an
    // edit, whatever a caller passes: the definition decides that, not the UI.
    const text = parameter.editable ? (edits[parameter.key] ?? defaultText) : defaultText;
    const parsed = parseField(parameter, text);
    if ('issue' in parsed) issues.push(parsed.issue);
    else parameters[parameter.key] = parsed.value;
    return Object.freeze({
      key: parameter.key,
      label: parameter.label,
      kind: parameter.kind,
      unit: parameter.unit,
      editable: parameter.editable,
      choices: parameter.choices,
      range: parameter.range,
      maxItems: parameter.maxItems,
      text,
      changed: text !== defaultText,
    });
  });

  // Nothing is put to the compiler while a value is unreadable: it would
  // report the *absence* of a parameter, which reads as a different fault
  // than the typo that caused it.
  if (issues.length > 0) {
    return Object.freeze({ fields: Object.freeze(fields), plan: null, issues: Object.freeze(issues) });
  }

  try {
    const request = createDefaultCalibrationJobRequest(definitionId, prerequisites, { parameters });
    const plan = compileCalibrationJob(request, { jobId });
    return Object.freeze({ fields: Object.freeze(fields), plan, issues: Object.freeze([]) });
  } catch (error) {
    if (error instanceof CalibrationJobValidationError) {
      return Object.freeze({ fields: Object.freeze(fields), plan: null, issues: error.issues });
    }
    return Object.freeze({
      fields: Object.freeze(fields),
      plan: null,
      issues: Object.freeze([
        { code: 'compile-failed', path: '$', message: error instanceof Error ? error.message : String(error) },
      ]),
    });
  }
}

/** A short, honest description of what a compiled plan will produce. */
export function describeCalibrationPlan(plan: CalibrationJobPlan): string {
  const [width, depth, height] = plan.geometry.requiredEnvelopeMm;
  return (
    `${plan.effects.length} band${plan.effects.length === 1 ? '' : 's'}, ` +
    `${width} × ${depth} × ${height} mm on the bed`
  );
}
