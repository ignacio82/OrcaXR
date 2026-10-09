/**
 * Printer control policy over the hosts' shared contract: which lifecycle
 * commands the reported state allows (`PrintJobControl.ts`), what sending one
 * would do or why it is refused, the sentence a failed send reports, the
 * compact status surfaces show and the guarded actions they offer
 * (`PrinterStatusSummary.ts`), and the hold-to-confirm gesture. Every answer
 * comes from the production functions; the Rust core answers the same
 * requests (`orcaxr_printer::control`, `orcaxr_printer::summary`).
 */
import type {
  ProjectGuardedPrinterActionWire,
  ProjectGuardedPrinterActionsRequestWire,
  ProjectHoldToConfirmReleaseWire,
  ProjectHoldToConfirmStateWire,
  ProjectMoonrakerConnectionViewWire,
  ProjectMoonrakerErrorCodeWire,
  ProjectOptionalPrintJobSnapshotWire,
  ProjectOptionalTextWire,
  ProjectPrintJobAvailabilityRequestWire,
  ProjectPrintJobCommandCheckRequestWire,
  ProjectPrintJobCommandDescriptorWire,
  ProjectPrintJobCommandErrorCodeWire,
  ProjectPrintJobCommandFailureRequestWire,
  ProjectPrintJobCommandPlanWire,
  ProjectPrintJobCommandRefusalWire,
  ProjectPrintJobCommandWire,
  ProjectPrintJobSnapshotWire,
  ProjectPrinterStatusRequestWire,
  ProjectPrinterStatusSummaryWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerConnectionState, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  executePrintJobCommand,
  PrintJobCommandError,
  printJobCommandAvailability,
  type PrintJobCommand,
  type PrintJobCommandDescriptor,
  type PrintJobCommandErrorCode,
} from './PrintJobControl';
import type { PrintJobSnapshot } from './PrintJobStatus';
import {
  guardedPrinterActions,
  summarizePrinterStatus,
  type GuardedPrinterAction,
  type HoldToConfirmState,
} from './PrinterStatusSummary';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);
const text = (value: string | undefined): ProjectOptionalTextWire =>
  value === undefined ? absent : { value: units(value) };
const optionalText = (value: ProjectOptionalTextWire): string | undefined =>
  'value' in value ? fromUnits(value.value) : undefined;

const COMMANDS: Readonly<Record<PrintJobCommand, ProjectPrintJobCommandWire>> = {
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel',
  'emergency-stop': 'emergencyStop',
  'firmware-restart': 'firmwareRestart',
};
const command = (wire: ProjectPrintJobCommandWire): PrintJobCommand =>
  (Object.keys(COMMANDS) as PrintJobCommand[]).find((key) => COMMANDS[key] === wire)!;
export const printJobCommandWire = (value: PrintJobCommand): ProjectPrintJobCommandWire => COMMANDS[value];
export const printJobCommandFromWire = command;
const ERRORS: Readonly<Record<PrintJobCommandErrorCode, ProjectPrintJobCommandErrorCodeWire>> = {
  'not-allowed': 'notAllowed',
  'job-changed': 'jobChanged',
  'request-failed': 'requestFailed',
  cancelled: 'cancelled',
  'session-changed': 'sessionChanged',
  'confirmation-required': 'confirmationRequired',
  busy: 'busy',
  'identity-unavailable': 'identityUnavailable',
};
const moonrakerCode = (wire: ProjectMoonrakerErrorCodeWire): MoonrakerErrorCode =>
  wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) as MoonrakerErrorCode;

/** The browser snapshot a wire snapshot stands for. */
export function printJobSnapshotFromWire(wire: ProjectPrintJobSnapshotWire): PrintJobSnapshot {
  const snapshot: Record<string, unknown> = { state: wire.state, updatedAtMs: wire.updatedAtMs };
  const put = (key: string, value: unknown) => {
    if (value !== undefined) snapshot[key] = value;
  };
  put('klippyState', optionalText(wire.klippyState));
  put('filename', optionalText(wire.filename));
  put('virtualSdActive', 'value' in wire.virtualSdActive ? wire.virtualSdActive.value : undefined);
  put('message', optionalText(wire.message));
  for (const key of [
    'progress',
    'currentLayer',
    'totalLayers',
    'printDurationS',
    'totalDurationS',
    'filamentUsedMm',
    'estimatedRemainingS',
  ] as const) {
    const field = wire[key];
    put(key, 'value' in field ? field.value : undefined);
  }
  for (const key of ['extruder', 'bed'] as const) {
    const field = wire[key];
    put(key, 'value' in field ? { actualC: field.value.actualC, targetC: field.value.targetC } : undefined);
  }
  return snapshot as unknown as PrintJobSnapshot;
}
const observed = (wire: ProjectOptionalPrintJobSnapshotWire): PrintJobSnapshot | null =>
  'value' in wire ? printJobSnapshotFromWire(wire.value) : null;

/** A connection in exactly the states the summary distinguishes. */
function connection(wire: ProjectMoonrakerConnectionViewWire): MoonrakerConnectionState {
  if ('reconnecting' in wire)
    return { status: 'reconnecting', delayMs: wire.reconnecting.delayMs } as unknown as MoonrakerConnectionState;
  if ('error' in wire)
    return { status: 'error', error: { code: moonrakerCode(wire.error.code) } } as unknown as MoonrakerConnectionState;
  const status = Object.keys(wire)[0];
  return { status } as unknown as MoonrakerConnectionState;
}

export function printJobCommandDescriptorWire(
  descriptor: PrintJobCommandDescriptor,
): ProjectPrintJobCommandDescriptorWire {
  return {
    command: COMMANDS[descriptor.command],
    label: units(descriptor.label),
    destructive: descriptor.destructive,
    allowed: descriptor.allowed,
    reason: text(descriptor.reason),
  };
}
function descriptorFromWire(wire: ProjectPrintJobCommandDescriptorWire): PrintJobCommandDescriptor {
  const reason = optionalText(wire.reason);
  return {
    command: command(wire.command),
    label: fromUnits(wire.label),
    destructive: wire.destructive,
    allowed: wire.allowed,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function answerPrintJobAvailability(
  request: ProjectPrintJobAvailabilityRequestWire,
): ProjectPrintJobCommandDescriptorWire[] {
  return printJobCommandAvailability(observed(request.observed)).map(printJobCommandDescriptorWire);
}

export function printJobCommandRefusalWire(error: unknown): ProjectPrintJobCommandRefusalWire {
  if (!(error instanceof PrintJobCommandError)) throw error;
  return { code: ERRORS[error.code], message: units(error.message) };
}

/** What sending a command would do, or why `executePrintJobCommand` refuses it. */
export async function answerPrintJobCommandCheck(
  request: ProjectPrintJobCommandCheckRequestWire,
): Promise<ProjectPrintJobCommandPlanWire> {
  let sent: { path: string; method: string; operation: string } | undefined;
  const expectedFilename = optionalText(request.expectedFilename);
  try {
    await executePrintJobCommand(
      {
        request: async <T>(path: string, options?: { readonly method?: string; readonly operation?: string }) => {
          sent = { path, method: options?.method ?? 'GET', operation: options?.operation ?? '' };
          return undefined as T;
        },
      },
      {
        command: command(request.command),
        observed: observed(request.observed),
        ...(expectedFilename === undefined ? {} : { expectedFilename }),
      },
    );
  } catch (error) {
    return { refused: printJobCommandRefusalWire(error) };
  }
  return { send: { path: units(sent!.path), method: units(sent!.method), operation: units(sent!.operation) } };
}

/** The sentence a send that failed in the transport (or was cancelled) reports. */
export async function answerPrintJobCommandFailure(
  request: ProjectPrintJobCommandFailureRequestWire,
): Promise<ProjectPrintJobCommandRefusalWire> {
  const target = command(request.command);
  // A reading that allows the command, so the send itself is what fails.
  const state = target === 'resume' ? 'paused' : 'printing';
  const abort = new AbortController();
  if (request.cancelled) abort.abort();
  try {
    await executePrintJobCommand(
      {
        request: async () => {
          throw 'value' in request.transportCode
            ? new MoonrakerTransportError(moonrakerCode(request.transportCode.value), 'print_command')
            : new Error('request failed');
        },
      },
      {
        command: target,
        observed: { state, klippyState: 'ready', updatedAtMs: 1 },
        signal: abort.signal,
      },
    );
  } catch (error) {
    return printJobCommandRefusalWire(error);
  }
  throw new Error('A failing transport cannot succeed');
}

export function answerPrinterStatus(request: ProjectPrinterStatusRequestWire): ProjectPrinterStatusSummaryWire {
  const summary = summarizePrinterStatus({
    snapshot: observed(request.snapshot),
    connection: 'value' in request.connection ? connection(request.connection.value) : null,
    nowMs: request.nowMs,
    configured: request.configured,
  });
  return {
    tone: summary.tone,
    headline: units(summary.headline),
    detail: units(summary.detail),
    progress: summary.progress === undefined ? absent : { value: summary.progress },
    progressLabel: text(summary.progressLabel),
    stale: summary.stale,
    ageLabel: text(summary.ageLabel),
    recovery: summary.recovery
      ? {
          value: {
            message: units(summary.recovery.message),
            actionLabel: units(summary.recovery.actionLabel),
            retryInS: summary.recovery.retryInS === undefined ? absent : { value: summary.recovery.retryInS },
            automatic: summary.recovery.automatic,
          },
        }
      : absent,
    facts: summary.facts.map((fact) => ({ label: units(fact.label), value: units(fact.value) })),
    present: summary.present,
  };
}

export function guardedActionWire(action: GuardedPrinterAction): ProjectGuardedPrinterActionWire {
  return {
    command: COMMANDS[action.command],
    label: units(action.label),
    enabled: action.enabled,
    reason: text(action.reason),
    holdMs: action.holdMs,
    confirmation: text(action.confirmation),
    destructive: action.destructive,
  };
}
export function guardedActionFromWire(wire: ProjectGuardedPrinterActionWire): GuardedPrinterAction {
  const reason = optionalText(wire.reason);
  const confirmation = optionalText(wire.confirmation);
  return {
    command: command(wire.command),
    label: fromUnits(wire.label),
    enabled: wire.enabled,
    ...(reason === undefined ? {} : { reason }),
    holdMs: wire.holdMs,
    ...(confirmation === undefined ? {} : { confirmation }),
    destructive: wire.destructive,
  };
}

export function answerGuardedPrinterActions(
  request: ProjectGuardedPrinterActionsRequestWire,
): ProjectGuardedPrinterActionWire[] {
  const staleReason = optionalText(request.staleReason);
  return guardedPrinterActions(request.descriptors.map(descriptorFromWire), {
    stale: request.stale,
    ...(staleReason === undefined ? {} : { staleReason }),
  }).map(guardedActionWire);
}

export function holdStateWire(state: HoldToConfirmState): ProjectHoldToConfirmStateWire {
  return {
    phase: state.phase,
    progress: state.progress,
    command: state.command ? { value: COMMANDS[state.command] } : absent,
  };
}
export function holdReleaseWire(release: {
  readonly command?: PrintJobCommand;
  readonly state: HoldToConfirmState;
}): ProjectHoldToConfirmReleaseWire {
  return {
    command: release.command ? { value: COMMANDS[release.command] } : absent,
    state: holdStateWire(release.state),
  };
}
