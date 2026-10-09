/**
 * The browser's printer types read from and written to the hosts' shared
 * contract: what the exchanges record and the shared-core hosts read back.
 */
import type {
  ProjectOptionalTextWire,
  ProjectPrintJobCommandDescriptorWire,
  ProjectPrintJobCommandErrorCodeWire,
  ProjectPrintJobCommandWire,
  ProjectPrintJobSnapshotWire,
} from '../../../contracts/generated/project-intents';
import type { PrintJobCommand, PrintJobCommandDescriptor, PrintJobCommandErrorCode } from './PrintJobControl';
import type { PrintJobSnapshot } from './PrintJobStatus';

const absent = { absent: {} } as const;
export const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
/** Text from UTF-16 units, in slices a call's argument list can hold. */
export function fromUnits(value: readonly number[]): string {
  let out = '';
  for (let i = 0; i < value.length; i += 8192) out += String.fromCharCode(...value.slice(i, i + 8192));
  return out;
}
export const optionalTextWire = (value: string | undefined): ProjectOptionalTextWire =>
  value === undefined ? absent : { value: units(value) };
export const optionalTextFromWire = (value: ProjectOptionalTextWire): string | undefined =>
  'value' in value ? fromUnits(value.value) : undefined;

const COMMANDS: Readonly<Record<PrintJobCommand, ProjectPrintJobCommandWire>> = {
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel',
  'emergency-stop': 'emergencyStop',
  'firmware-restart': 'firmwareRestart',
};
export const printJobCommandWire = (value: PrintJobCommand): ProjectPrintJobCommandWire => COMMANDS[value];
export const printJobCommandFromWire = (wire: ProjectPrintJobCommandWire): PrintJobCommand =>
  (Object.keys(COMMANDS) as PrintJobCommand[]).find((key) => COMMANDS[key] === wire)!;

export const PRINT_JOB_COMMAND_ERRORS: Readonly<Record<PrintJobCommandErrorCode, ProjectPrintJobCommandErrorCodeWire>> =
  {
    'not-allowed': 'notAllowed',
    'job-changed': 'jobChanged',
    'request-failed': 'requestFailed',
    cancelled: 'cancelled',
    'session-changed': 'sessionChanged',
    'confirmation-required': 'confirmationRequired',
    busy: 'busy',
    'identity-unavailable': 'identityUnavailable',
  };
export const printJobCommandErrorFromWire = (wire: ProjectPrintJobCommandErrorCodeWire): PrintJobCommandErrorCode =>
  (Object.keys(PRINT_JOB_COMMAND_ERRORS) as PrintJobCommandErrorCode[]).find(
    (key) => PRINT_JOB_COMMAND_ERRORS[key] === wire,
  )!;

/** The browser snapshot a wire snapshot stands for. */
export function printJobSnapshotFromWire(wire: ProjectPrintJobSnapshotWire): PrintJobSnapshot {
  const snapshot: Record<string, unknown> = { state: wire.state, updatedAtMs: wire.updatedAtMs };
  const put = (key: string, value: unknown) => {
    if (value !== undefined) snapshot[key] = value;
  };
  put('klippyState', optionalTextFromWire(wire.klippyState));
  put('filename', optionalTextFromWire(wire.filename));
  put('virtualSdActive', 'value' in wire.virtualSdActive ? wire.virtualSdActive.value : undefined);
  put('message', optionalTextFromWire(wire.message));
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

export function printJobCommandDescriptorWire(
  descriptor: PrintJobCommandDescriptor,
): ProjectPrintJobCommandDescriptorWire {
  return {
    command: COMMANDS[descriptor.command],
    label: units(descriptor.label),
    destructive: descriptor.destructive,
    allowed: descriptor.allowed,
    reason: optionalTextWire(descriptor.reason),
  };
}
export function printJobCommandDescriptorFromWire(
  wire: ProjectPrintJobCommandDescriptorWire,
): PrintJobCommandDescriptor {
  const reason = optionalTextFromWire(wire.reason);
  return {
    command: printJobCommandFromWire(wire.command),
    label: fromUnits(wire.label),
    destructive: wire.destructive,
    allowed: wire.allowed,
    ...(reason === undefined ? {} : { reason }),
  };
}
