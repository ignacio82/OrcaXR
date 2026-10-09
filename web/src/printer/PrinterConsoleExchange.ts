/**
 * The printer console over the hosts' shared contract (`PrinterConsole.ts`):
 * a script's assessment, the request an operation sends or why it is
 * refused, the result an exchange that ended without a reply reads as, the
 * printer's macros read from its configuration, a macro invocation spelled
 * or refused, and transcript lines as the log keeps them. Every answer comes
 * from the production functions over a scripted transport; the Rust core
 * answers the same requests (`orcaxr_printer::console`).
 */
import type {
  ProjectConsoleFailureWire,
  ProjectConsoleFinishWire,
  ProjectConsoleLineRequestWire,
  ProjectConsoleLineWire,
  ProjectConsoleNotificationRequestWire,
  ProjectConsoleOperationWire,
  ProjectConsolePlanWire,
  ProjectConsoleRecentRequestWire,
  ProjectConsoleResultWire,
  ProjectGcodeAssessmentWire,
  ProjectGcodeAssessRequestWire,
  ProjectMacroInvocationRequestWire,
  ProjectMacroInvocationWire,
  ProjectOptionalConsoleLineWire,
  ProjectPrinterMacroWire,
  ProjectTextListWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  PrinterConsoleError,
  PrinterConsoleLog,
  assessGcodeCommand,
  buildMacroInvocation,
  listPrinterMacros,
  recentCommands,
  runGcodeScript,
  type PrinterConsoleEntry,
  type PrinterConsoleTransport,
  type PrinterMacro,
} from './PrinterConsole';
import type { PrintJobSnapshot } from './PrintJobStatus';
import { fromUnits, units } from './PrinterWire';

const absent = { absent: {} } as const;
const camel = (code: string): string => code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (code: string): string => code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function failureWire(error: PrinterConsoleError): ProjectConsoleFailureWire {
  return { code: camel(error.code) as ProjectConsoleFailureWire['code'], message: units(error.message) };
}

export function answerConsoleAssess(request: ProjectGcodeAssessRequestWire): ProjectGcodeAssessmentWire {
  // The assessment reads only the job's state.
  const job = 'value' in request.jobState ? ({ state: request.jobState.value } as PrintJobSnapshot) : undefined;
  const assessment = assessGcodeCommand(fromUnits(request.script), job);
  return {
    command: units(assessment.command),
    level: assessment.level,
    reasons: assessment.reasons.map(units),
    commands: assessment.commands.map(units),
  };
}

function run(
  operation: ProjectConsoleOperationWire,
  transport: PrinterConsoleTransport,
  signal?: AbortSignal,
): Promise<readonly PrinterMacro[] | void> {
  if ('macros' in operation) return listPrinterMacros(transport, signal);
  return runGcodeScript(transport, fromUnits(operation.send.text), signal);
}

function resultWire(value: readonly PrinterMacro[] | void): ProjectConsoleResultWire {
  return value === undefined ? { sent: {} } : { macros: value.map(macroWire) };
}

/** What [operation] sends, or why it is refused before anything leaves. */
export async function answerConsolePlan(operation: ProjectConsoleOperationWire): Promise<ProjectConsolePlanWire> {
  let sent: ProjectConsolePlanWire | undefined;
  const transport: PrinterConsoleTransport = {
    request: async (path, options) => {
      sent = {
        request: {
          path: units(path),
          method: units(options?.method ?? 'GET'),
          operation: units(options?.operation ?? ''),
          timeoutMs: absent,
        },
      };
      throw new Error('sent');
    },
  };
  try {
    await run(operation, transport);
  } catch (error) {
    if (sent) return sent;
    if (error instanceof PrinterConsoleError) return { refused: failureWire(error) };
    throw error;
  }
  throw new Error('The operation sent nothing');
}

/** The result an operation reads as once its exchange ended without a reply to read. */
export async function answerConsoleFinish(request: ProjectConsoleFinishWire): Promise<ProjectConsoleResultWire> {
  const { operation, outcome } = request;
  const abort = new AbortController();
  const transport: PrinterConsoleTransport = {
    request: async () => {
      if ('done' in outcome) return undefined as never;
      if ('cancelled' in outcome) {
        abort.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const failure = outcome.failed;
      if (!('value' in failure.code)) throw new Error('request failed');
      throw new MoonrakerTransportError(snake(failure.code.value) as MoonrakerErrorCode, 'console', {
        ...('value' in failure.httpStatus ? { httpStatus: failure.httpStatus.value } : {}),
        ...('value' in failure.detail ? { detail: fromUnits(failure.detail.value) } : {}),
      });
    },
  };
  try {
    return resultWire(await run(operation, transport, abort.signal));
  } catch (error) {
    if (error instanceof PrinterConsoleError) return { failed: failureWire(error) };
    throw error;
  }
}

/** A reply (Moonraker's `result`, as JSON) read as the shell reads it. */
export async function answerConsoleRead(
  operation: ProjectConsoleOperationWire,
  reply: string,
): Promise<ProjectConsoleResultWire> {
  const transport: PrinterConsoleTransport = { request: async () => JSON.parse(reply) };
  try {
    return resultWire(await run(operation, transport));
  } catch (error) {
    if (error instanceof PrinterConsoleError) return { failed: failureWire(error) };
    throw error;
  }
}

export function answerMacroInvocation(request: ProjectMacroInvocationRequestWire): ProjectMacroInvocationWire {
  const values = Object.fromEntries(request.values.map((entry) => [fromUnits(entry.key), fromUnits(entry.value)]));
  try {
    return { script: units(buildMacroInvocation(fromUnits(request.name), values)) };
  } catch (error) {
    if (error instanceof PrinterConsoleError) return { refused: failureWire(error) };
    throw error;
  }
}

export function answerConsoleLine(request: ProjectConsoleLineRequestWire): ProjectConsoleLineWire {
  const log = new PrinterConsoleLog(1, () => request.secrets.map(fromUnits));
  const entry = log.append(request.line.kind, fromUnits(request.line.text), 0);
  return { kind: entry.kind, text: units(entry.text) };
}

export function answerConsoleNotification(
  request: ProjectConsoleNotificationRequestWire,
  params: string,
): ProjectOptionalConsoleLineWire {
  const log = new PrinterConsoleLog(1, () => request.secrets.map(fromUnits));
  const entry = log.appendNotification(fromUnits(request.method), JSON.parse(params), 0);
  return entry === undefined ? absent : { value: { kind: entry.kind, text: units(entry.text) } };
}

export function answerConsoleRecent(request: ProjectConsoleRecentRequestWire): ProjectTextListWire {
  const entries: PrinterConsoleEntry[] = request.lines.map((line, index) => ({
    id: index + 1,
    atMs: 0,
    kind: line.kind,
    text: fromUnits(line.text),
  }));
  return recentCommands(entries, request.limit).map(units);
}

function macroWire(macro: PrinterMacro): ProjectPrinterMacroWire {
  return {
    name: units(macro.name),
    description: macro.description === undefined ? absent : { value: units(macro.description) },
    parameters: macro.parameters.map((parameter) => ({
      name: units(parameter.name),
      defaultValue: parameter.defaultValue === undefined ? absent : { value: units(parameter.defaultValue) },
      required: parameter.required,
    })),
    level: macro.level,
    reasons: macro.reasons.map(units),
  };
}
