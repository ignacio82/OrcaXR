/**
 * Print preparation and submission checks over the hosts' shared contract:
 * the capability lists a printer reports, the start options they support,
 * the preparation plan for chosen options and what each step posts
 * (`PrintStartOptions.ts`), readiness, upload names, stored-file identity and
 * how a transport failure reads (`PrintJobSubmission.ts`). Every answer comes
 * from the production functions; the Rust core answers the same requests
 * (`orcaxr_printer::preparation`).
 */
import type {
  ProjectOptionalTextListWire,
  ProjectPrintFileIdentityReplyWire,
  ProjectPrintPreparationPlanRequestWire,
  ProjectPrintPreparationPlanWire,
  ProjectPrintPreparationStepWire,
  ProjectPrintReadinessFailureWire,
  ProjectPrintReadinessWire,
  ProjectPrintStartOptionIdWire,
  ProjectPrintStartOptionWire,
  ProjectPrinterCapabilityReportWire,
  ProjectPrinterSendWire,
  ProjectTransportFailureWire,
} from '../../../contracts/generated/project-intents';
import { compareCanonicalText } from '../project/domain/canonical';
import { MoonrakerTransportError, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  describeTransportFailure,
  PrintSubmissionError,
  queryPrintReadiness,
  readPrintFileIdentity,
  sanitizeGcodeFilename,
  type PrintReadiness,
  type PrintSubmissionTransport,
} from './PrintJobSubmission';
import {
  assessPrintStartOptions,
  executePrintPreparationStep,
  parseGcodeCommands,
  parsePrinterObjects,
  parseServerComponents,
  planPrintPreparation,
  PrintStartOptionError,
  type PrintPreparationStep,
  type PrintStartOption,
  type PrintStartOptionId,
} from './PrintStartOptions';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);
const text = (value: string | undefined) => (value === undefined ? absent : { value: units(value) });
const optionalText = (value: { value: readonly number[] } | { absent: object }): string | undefined =>
  'value' in value ? fromUnits(value.value) : undefined;
const moonrakerCode = (wire: string): MoonrakerErrorCode =>
  wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) as MoonrakerErrorCode;

const IDS: Readonly<Record<PrintStartOptionId, ProjectPrintStartOptionIdWire>> = {
  'bed-leveling': 'bedLeveling',
  timelapse: 'timelapse',
};
const id = (wire: ProjectPrintStartOptionIdWire): PrintStartOptionId =>
  wire === 'bedLeveling' ? 'bed-leveling' : wire;

const list = (names: readonly string[] | undefined): ProjectOptionalTextListWire =>
  names === undefined ? absent : { value: names.map(units) };
const fromList = (wire: ProjectOptionalTextListWire): readonly string[] | undefined =>
  'value' in wire ? wire.value.map(fromUnits) : undefined;

/** `/printer/objects/list`, parsed from its reply. */
export function answerPrinterObjects(payload: unknown): ProjectOptionalTextListWire {
  return list(parsePrinterObjects(payload));
}
/** `/server/info`'s components, parsed from its reply. */
export function answerServerComponents(payload: unknown): ProjectOptionalTextListWire {
  return list(parseServerComponents(payload));
}
/** `/printer/gcode/help`'s command names, as a set in UTF-16 order. */
export function answerGcodeCommands(payload: unknown): ProjectOptionalTextListWire {
  const names = parseGcodeCommands(payload);
  return list(names === undefined ? undefined : [...names].sort(compareCanonicalText));
}

export function printStartOptionWire(option: PrintStartOption): ProjectPrintStartOptionWire {
  return {
    id: IDS[option.id],
    label: units(option.label),
    detail: units(option.detail),
    available: option.available,
    reason: units(option.reason),
    defaultEnabled: option.defaultEnabled,
    command: text(option.command),
  };
}
function optionFromWire(wire: ProjectPrintStartOptionWire): PrintStartOption {
  const command = optionalText(wire.command);
  return {
    id: id(wire.id),
    label: fromUnits(wire.label),
    detail: fromUnits(wire.detail),
    available: wire.available,
    reason: fromUnits(wire.reason),
    defaultEnabled: wire.defaultEnabled,
    ...(command === undefined ? {} : { command }),
  };
}

export function answerPrintStartOptions(report: ProjectPrinterCapabilityReportWire): ProjectPrintStartOptionWire[] {
  const objects = fromList(report.objects);
  const commands = fromList(report.commands);
  const components = fromList(report.components);
  return assessPrintStartOptions({
    ...(objects ? { objects } : {}),
    ...(commands ? { commands } : {}),
    ...(components ? { components } : {}),
  }).map(printStartOptionWire);
}

function stepWire(step: PrintPreparationStep): ProjectPrintPreparationStepWire {
  return {
    id: IDS[step.id],
    label: units(step.label),
    kind: step.kind,
    command: step.kind === 'leveling' ? { value: units(step.command) } : absent,
  };
}
function stepFromWire(wire: ProjectPrintPreparationStepWire): PrintPreparationStep {
  return wire.kind === 'leveling'
    ? {
        id: id(wire.id) as 'bed-leveling',
        label: fromUnits(wire.label),
        kind: 'leveling',
        command: optionalText(wire.command)!,
      }
    : { id: id(wire.id) as 'timelapse', label: fromUnits(wire.label), kind: 'timelapse' };
}

export function answerPrintPreparationPlan(
  request: ProjectPrintPreparationPlanRequestWire,
): ProjectPrintPreparationPlanWire {
  try {
    return { steps: planPrintPreparation(request.options.map(optionFromWire), request.enabled.map(id)).map(stepWire) };
  } catch (error) {
    if (!(error instanceof PrintStartOptionError)) throw error;
    return { refused: { optionId: IDS[error.optionId], message: units(error.message) } };
  }
}

/** What `executePrintPreparationStep` posts for one step. */
export async function answerPrintPreparationSend(
  step: ProjectPrintPreparationStepWire,
): Promise<ProjectPrinterSendWire> {
  let sent: ProjectPrinterSendWire | undefined;
  await executePrintPreparationStep(
    {
      request: async <T>(
        path: string,
        options?: { readonly method?: string; readonly operation?: string; readonly timeoutMs?: number | null },
      ) => {
        sent = {
          path: units(path),
          method: units(options?.method ?? 'GET'),
          operation: units(options?.operation ?? ''),
          timeoutMs: typeof options?.timeoutMs === 'number' ? { value: options.timeoutMs } : absent,
        };
        return undefined as T;
      },
    },
    stepFromWire(step),
    { validate: async () => {} },
  );
  return sent!;
}

function readinessWire(readiness: PrintReadiness): ProjectPrintReadinessWire {
  const codes = {
    'klippy-not-ready': 'klippyNotReady',
    'printer-busy': 'printerBusy',
    'state-unavailable': 'stateUnavailable',
    'file-root-unavailable': 'fileRootUnavailable',
  } as const;
  return {
    known: readiness.known,
    ready: readiness.ready,
    blockers: readiness.blockers.map((b) => ({ code: codes[b.code], message: units(b.message) })),
    klippyState: text(readiness.klippyState),
    printState: text(readiness.printState),
    currentFilename: text(readiness.currentFilename),
    virtualSdActive: readiness.virtualSdActive === undefined ? absent : { value: readiness.virtualSdActive },
  };
}
const replying = (reply: () => unknown): PrintSubmissionTransport => ({
  request: async <T>() => reply() as T,
  upload: async () => {
    throw new Error('No upload in a check');
  },
});

/** Readiness from the query's reply. */
export async function answerPrintReadiness(payload: unknown): Promise<ProjectPrintReadinessWire> {
  return readinessWire(await queryPrintReadiness(replying(() => payload)));
}
/** Readiness when the query itself failed. */
export async function answerPrintReadinessFailure(
  request: ProjectPrintReadinessFailureWire,
): Promise<ProjectPrintReadinessWire> {
  return readinessWire(
    await queryPrintReadiness(
      replying(() => {
        throw 'value' in request.transportCode
          ? new MoonrakerTransportError(moonrakerCode(request.transportCode.value), 'print_readiness')
          : new Error('request failed');
      }),
    ),
  );
}

export function answerSanitizeFilename(filename: readonly number[]): number[] {
  return units(sanitizeGcodeFilename(fromUnits(filename)));
}

export function answerTransportFailure(request: ProjectTransportFailureWire): number[] {
  const detail = optionalText(request.detail);
  return units(
    describeTransportFailure(
      'value' in request.code
        ? new MoonrakerTransportError(moonrakerCode(request.code.value), 'print_command', {
            ...('value' in request.httpStatus ? { httpStatus: request.httpStatus.value } : {}),
            ...(detail === undefined ? {} : { detail }),
          })
        : new Error('request failed'),
    ),
  );
}

/** A stored file's identity from its metadata reply. */
export async function answerFileIdentity(
  payload: unknown,
  filename: readonly number[],
): Promise<ProjectPrintFileIdentityReplyWire> {
  try {
    const identity = await readPrintFileIdentity(
      replying(() => payload),
      fromUnits(filename),
    );
    return { identity: { filename: units(identity.filename), size: identity.size, modified: identity.modified } };
  } catch (error) {
    if (!(error instanceof PrintSubmissionError) || error.code !== 'verification-failed') throw error;
    return { unreliable: { text: units(error.message) } };
  }
}
