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
  ProjectPrintJobCommandFailureRequestWire,
  ProjectPrintJobCommandPlanWire,
  ProjectPrintJobCommandRefusalWire,
  ProjectPrinterStatusRequestWire,
  ProjectPrinterStatusSummaryWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerConnectionState, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  executePrintJobCommand,
  PrintJobCommandError,
  printJobCommandAvailability,
  type PrintJobCommand,
} from './PrintJobControl';
import type { PrintJobSnapshot } from './PrintJobStatus';
import {
  PRINT_JOB_COMMAND_ERRORS,
  printJobCommandDescriptorFromWire,
  printJobCommandDescriptorWire,
  printJobCommandFromWire,
  printJobCommandWire,
  printJobSnapshotFromWire,
} from './PrinterWire';
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

const command = printJobCommandFromWire;
export { printJobCommandDescriptorWire, printJobCommandFromWire, printJobCommandWire, printJobSnapshotFromWire };
const moonrakerCode = (wire: ProjectMoonrakerErrorCodeWire): MoonrakerErrorCode =>
  wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) as MoonrakerErrorCode;

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

export function answerPrintJobAvailability(
  request: ProjectPrintJobAvailabilityRequestWire,
): ProjectPrintJobCommandDescriptorWire[] {
  return printJobCommandAvailability(observed(request.observed)).map(printJobCommandDescriptorWire);
}

export function printJobCommandRefusalWire(error: unknown): ProjectPrintJobCommandRefusalWire {
  if (!(error instanceof PrintJobCommandError)) throw error;
  return { code: PRINT_JOB_COMMAND_ERRORS[error.code], message: units(error.message) };
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
    command: printJobCommandWire(action.command),
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
  return guardedPrinterActions(request.descriptors.map(printJobCommandDescriptorFromWire), {
    stale: request.stale,
    ...(staleReason === undefined ? {} : { staleReason }),
  }).map(guardedActionWire);
}

export function holdStateWire(state: HoldToConfirmState): ProjectHoldToConfirmStateWire {
  return {
    phase: state.phase,
    progress: state.progress,
    command: state.command ? { value: printJobCommandWire(state.command) } : absent,
  };
}
export function holdReleaseWire(release: {
  readonly command?: PrintJobCommand;
  readonly state: HoldToConfirmState;
}): ProjectHoldToConfirmReleaseWire {
  return {
    command: release.command ? { value: printJobCommandWire(release.command) } : absent,
    state: holdStateWire(release.state),
  };
}
