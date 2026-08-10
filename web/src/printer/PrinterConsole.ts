/**
 * Typing G-code at a machine that can hurt itself (P9.6).
 *
 * A console is the one printer surface with no guard rails of its own: whatever
 * is typed goes to the firmware. So the interesting work here is not sending
 * the command, it is knowing what the command does before it is sent.
 *
 * Three decisions shape this module:
 *
 * - **Unknown is not safe.** Anything the classifier does not recognise —
 *   including every user macro, which can contain arbitrary G-code — is
 *   `caution`, never `safe`. A console that stayed quiet about commands it had
 *   never heard of would be silent exactly where it matters.
 *
 * - **Context changes the answer.** `G1 Z10` is unremarkable on an idle machine
 *   and reckless mid-print. The running job is therefore part of the
 *   assessment, not something the caller is trusted to remember.
 *
 * - **Nothing about the printer's replies is trusted.** Responses are printer
 *   host content: they are redacted, length-bounded, and rendered as text, so a
 *   machine reporting a crafted string cannot reach into the page.
 *
 * Macro parameters come from the macro's own body — `params.SPEED|default(50)`
 * is read out of the gcode Moonraker reports — because Klipper has no schema to
 * ask for, and inventing one would describe a macro that does not exist.
 */

import { MoonrakerTransportError } from './MoonrakerTypes';
import type { PrintJobSnapshot } from './PrintJobStatus';
import { redactMoonrakerDiagnostic } from './SessionCredentials';

export interface PrinterConsoleTransport {
  request<T>(
    path: string,
    options?: { readonly signal?: AbortSignal; readonly operation?: string; readonly method?: string },
  ): Promise<T>;
}

export type GcodeRiskLevel = 'safe' | 'caution' | 'dangerous';

export interface GcodeCommandAssessment {
  /** Uppercased first token of the riskiest line, for display. */
  readonly command: string;
  readonly level: GcodeRiskLevel;
  /** Why this level, in the order the reasons were found. */
  readonly reasons: readonly string[];
  /** Every distinct command in the script, uppercased. */
  readonly commands: readonly string[];
}

/**
 * One thing a surface asks the shell to do with the console.
 *
 * A macro invocation carries its values rather than a pre-built string so the
 * shell — not the surface — decides how they are quoted, and the same builder
 * runs whether the request came from a panel, the palette, or automation.
 */
export type PrinterConsoleOperation =
  | { readonly kind: 'send'; readonly script: string }
  | { readonly kind: 'macro'; readonly name: string; readonly values?: Readonly<Record<string, string>> }
  | { readonly kind: 'refresh-macros' };

export class PrinterConsoleError extends Error {
  override readonly name = 'PrinterConsoleError';

  constructor(
    message: string,
    readonly code: 'empty-script' | 'too-long' | 'send-failed' | 'macros-unavailable' | 'cancelled',
  ) {
    super(message);
  }
}

/** Moonraker rejects an oversized query string long before Klipper sees it. */
const MAX_SCRIPT_LENGTH = 4096;

/**
 * Commands that can damage the machine, lose a print, or run heaters
 * unattended. Each entry states the consequence a confirmation must show.
 */
const DANGEROUS: Readonly<Record<string, string>> = Object.freeze({
  M112: 'Halts the printer immediately; Klipper then stays shut down until a firmware restart.',
  M999: 'Clears an error state and restarts, discarding whatever the printer was doing.',
  RESTART: 'Restarts the host; a running print is lost.',
  FIRMWARE_RESTART: 'Restarts the MCU connection; a running print is lost.',
  M84: 'Releases the steppers. An unbraked Z axis can drop under the weight of the gantry.',
  M18: 'Releases the steppers. An unbraked Z axis can drop under the weight of the gantry.',
  FORCE_MOVE: 'Moves an axis with the kinematics bypassed — past endstops and into the bed if asked.',
  SET_KINEMATIC_POSITION: 'Tells Klipper the toolhead is somewhere it is not; later moves act on that lie.',
  M303: 'Runs a PID tune, cycling a heater at temperature for several minutes unattended.',
  PID_CALIBRATE: 'Runs a PID tune, cycling a heater at temperature for several minutes unattended.',
  BED_MESH_CALIBRATE: 'Drives the probe toward the bed across the whole surface.',
  DELTA_CALIBRATE: 'Drives the probe toward the bed repeatedly.',
  PROBE: 'Drives the probe into the bed until it triggers.',
  PROBE_ACCURACY: 'Drives the probe into the bed repeatedly.',
  Z_ENDSTOP_CALIBRATE: 'Drives the toolhead toward the bed with the endstop under test.',
  SDCARD_RESET_FILE: 'Clears the loaded job on the printer.',
});

/** Commands that move or heat the machine: real, but ordinary, consequences. */
const CAUTION: Readonly<Record<string, string>> = Object.freeze({
  G0: 'Moves the toolhead.',
  G1: 'Moves the toolhead.',
  G2: 'Moves the toolhead along an arc.',
  G3: 'Moves the toolhead along an arc.',
  G28: 'Homes the axes, moving each to its endstop.',
  G29: 'Runs bed levelling, moving the toolhead across the bed.',
  M104: 'Starts heating the nozzle and returns immediately.',
  M109: 'Heats the nozzle and waits for the target.',
  M140: 'Starts heating the bed and returns immediately.',
  M190: 'Heats the bed and waits for the target.',
  SET_HEATER_TEMPERATURE: 'Changes a heater target.',
  M106: 'Changes a fan speed.',
  M204: 'Changes the acceleration limit for later moves.',
  SET_VELOCITY_LIMIT: 'Changes the motion limits for later moves.',
  M24: 'Starts or resumes the loaded job.',
  M25: 'Pauses the loaded job.',
  PAUSE: 'Pauses the running job.',
  RESUME: 'Resumes the paused job.',
  CANCEL_PRINT: 'Ends the running job; it cannot be resumed.',
  SET_GCODE_OFFSET: 'Shifts where later moves are executed.',
});

/** Commands that only report. Everything absent from this set is `caution`. */
const SAFE = Object.freeze(
  new Set([
    'M105',
    'M114',
    'M115',
    'M119',
    'M31',
    'STATUS',
    'HELP',
    'GET_POSITION',
    'QUERY_ENDSTOPS',
    'QUERY_PROBE',
    'DUMP_TMC',
    'BED_MESH_OUTPUT',
    'SHOW',
  ]),
);

const RANK: Readonly<Record<GcodeRiskLevel, number>> = Object.freeze({ safe: 0, caution: 1, dangerous: 2 });

/** Strip Klipper's `;` comments and surrounding whitespace from one line. */
function stripComment(line: string): string {
  const semicolon = line.indexOf(';');
  return (semicolon === -1 ? line : line.slice(0, semicolon)).trim();
}

export function gcodeCommandName(line: string): string {
  const cleaned = stripComment(line);
  const token = cleaned.split(/[\s=]/, 1)[0] ?? '';
  return token.toUpperCase();
}

/**
 * What sending `script` at this machine, right now, would do.
 *
 * A multi-line script takes the level of its riskiest line, because a person
 * confirming a batch is confirming all of it.
 */
export function assessGcodeCommand(script: string, job?: PrintJobSnapshot | null): GcodeCommandAssessment {
  const lines = script
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.length > 0);
  const commands = lines.map((line) => gcodeCommandName(line)).filter((name) => name.length > 0);
  if (commands.length === 0) {
    return Object.freeze({
      command: '',
      level: 'safe' as const,
      reasons: Object.freeze([]),
      commands: Object.freeze([]),
    });
  }

  let level: GcodeRiskLevel = 'safe';
  let command = commands[0];
  const reasons: string[] = [];
  for (const name of commands) {
    const dangerous = DANGEROUS[name];
    const caution = CAUTION[name];
    const found: GcodeRiskLevel = dangerous ? 'dangerous' : caution || !SAFE.has(name) ? 'caution' : 'safe';
    if (RANK[found] > RANK[level]) {
      level = found;
      command = name;
    }
    const reason =
      dangerous ??
      caution ??
      (SAFE.has(name)
        ? undefined
        : // A macro is whatever its author wrote; the console cannot know.
          `${name} is not a command this console recognises, so what it does is unknown.`);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }

  // A machine mid-job interleaves anything sent here with the print itself.
  const state = job?.state;
  if ((state === 'printing' || state === 'paused') && level !== 'safe') {
    reasons.push(`The printer is ${state}; this runs alongside the job and can ruin it.`);
    level = 'dangerous';
  }

  return Object.freeze({
    command,
    level,
    reasons: Object.freeze(reasons),
    commands: Object.freeze([...new Set(commands)]),
  });
}

/** Send one script to the printer. The caller owns any confirmation. */
export async function runGcodeScript(
  transport: PrinterConsoleTransport,
  script: string,
  signal?: AbortSignal,
): Promise<void> {
  const trimmed = script.trim();
  if (trimmed.length === 0) throw new PrinterConsoleError('Type a command first.', 'empty-script');
  if (trimmed.length > MAX_SCRIPT_LENGTH) {
    throw new PrinterConsoleError(
      `That script is ${trimmed.length} characters; the printer accepts at most ${MAX_SCRIPT_LENGTH}.`,
      'too-long',
    );
  }
  try {
    await transport.request<unknown>(`/printer/gcode/script?script=${encodeURIComponent(trimmed)}`, {
      method: 'POST',
      operation: 'gcode_script',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')) {
      throw new PrinterConsoleError('The command was cancelled before it was sent.', 'cancelled');
    }
    throw new PrinterConsoleError(
      `The printer refused ${gcodeCommandName(trimmed) || 'the command'} (${
        error instanceof MoonrakerTransportError ? error.code : 'request failed'
      }).`,
      'send-failed',
    );
  }
}

export interface PrinterMacroParameter {
  readonly name: string;
  /** Default from `|default(...)` in the macro body, when it declares one. */
  readonly defaultValue?: string;
  /** True when the body reads it with no default, so it must be supplied. */
  readonly required: boolean;
}

export interface PrinterMacro {
  /** Name as it is typed, uppercased the way Klipper matches it. */
  readonly name: string;
  readonly description?: string;
  readonly parameters: readonly PrinterMacroParameter[];
  /** The macro's own body assessed as a script, so its risk is its content's. */
  readonly level: GcodeRiskLevel;
  readonly reasons: readonly string[];
}

const MACRO_SECTION = /^gcode_macro\s+(.+)$/i;
/** `params.NAME`, `params['NAME']`, and `params.NAME|default(value)`. */
const PARAM_PATTERN = /params(?:\.([A-Za-z_][\w]*)|\[\s*['"]([^'"]+)['"]\s*\])(\s*\|\s*default\(([^)]*)\))?/g;

/**
 * Read the printer's macros out of its own configuration.
 *
 * `configfile.settings` is used rather than `/printer/gcode/help` because the
 * help text alone cannot say what a macro takes; the body can, and the body is
 * what will actually run.
 */
export async function listPrinterMacros(
  transport: PrinterConsoleTransport,
  signal?: AbortSignal,
): Promise<readonly PrinterMacro[]> {
  let payload: unknown;
  try {
    payload = await transport.request<unknown>('/printer/objects/query?configfile', {
      operation: 'list_macros',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')) {
      throw new PrinterConsoleError('Reading the printer configuration was cancelled.', 'cancelled');
    }
    throw new PrinterConsoleError(
      `The printer did not report its configuration (${
        error instanceof MoonrakerTransportError ? error.code : 'request failed'
      }).`,
      'macros-unavailable',
    );
  }

  const status = isRecord(payload) && isRecord(payload.status) ? payload.status : undefined;
  const configfile = status && isRecord(status.configfile) ? status.configfile : undefined;
  const settings = configfile && isRecord(configfile.settings) ? configfile.settings : undefined;
  if (!settings) {
    throw new PrinterConsoleError('The printer reported no configuration to read macros from.', 'macros-unavailable');
  }

  const macros: PrinterMacro[] = [];
  for (const [section, value] of Object.entries(settings)) {
    const match = MACRO_SECTION.exec(section);
    if (!match || !isRecord(value)) continue;
    const name = match[1].trim().toUpperCase();
    const body = typeof value.gcode === 'string' ? value.gcode : '';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    const assessment = assessGcodeCommand(body);
    macros.push(
      Object.freeze({
        name,
        ...(description && description.toLowerCase() !== 'g-code macro' ? { description } : {}),
        parameters: extractMacroParameters(body),
        // A macro whose body says nothing recognisable is still unknown, never safe.
        level: assessment.level === 'safe' && body.trim().length === 0 ? 'caution' : assessment.level,
        reasons: assessment.reasons,
      }),
    );
  }
  return Object.freeze(macros.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)));
}

export function extractMacroParameters(body: string): readonly PrinterMacroParameter[] {
  const found = new Map<string, PrinterMacroParameter>();
  for (const match of body.matchAll(PARAM_PATTERN)) {
    const name = (match[1] ?? match[2] ?? '').toUpperCase();
    if (!name) continue;
    const declared = match[4]?.trim();
    const defaultValue = declared === undefined ? undefined : unquote(declared);
    const existing = found.get(name);
    // One read with a default is enough to make the parameter optional.
    if (existing && (existing.defaultValue !== undefined || defaultValue === undefined)) continue;
    found.set(name, {
      name,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      required: defaultValue === undefined,
    });
  }
  return Object.freeze([...found.values()].sort((left, right) => (left.name < right.name ? -1 : 1)));
}

/** `MACRO NAME=value` with values quoted only when they need it. */
export function buildMacroInvocation(name: string, values: Readonly<Record<string, string>>): string {
  const parts = [name.toUpperCase()];
  for (const key of Object.keys(values).sort()) {
    const value = values[key].trim();
    if (value.length === 0) continue;
    parts.push(`${key.toUpperCase()}=${/[\s"']/.test(value) ? JSON.stringify(value) : value}`);
  }
  return parts.join(' ');
}

export type ConsoleEntryKind = 'sent' | 'received' | 'error';

export interface PrinterConsoleEntry {
  readonly id: number;
  readonly atMs: number;
  readonly kind: ConsoleEntryKind;
  readonly text: string;
}

/**
 * A bounded transcript of what was sent and what came back.
 *
 * Every line is redacted on the way in rather than on the way out: the log is
 * copied into diagnostics and support bundles, and a secret that is only hidden
 * at render time is a secret that leaks the first time someone reads the array.
 */
export class PrinterConsoleLog {
  #entries: PrinterConsoleEntry[] = [];
  #nextId = 1;

  constructor(
    private readonly limit = 200,
    private readonly secrets: () => readonly string[] = () => [],
  ) {}

  append(kind: ConsoleEntryKind, text: string, atMs = Date.now()): PrinterConsoleEntry {
    const redacted = String(redactMoonrakerDiagnostic(text, this.secrets()));
    const entry = Object.freeze({ id: this.#nextId++, atMs, kind, text: redacted });
    this.#entries = [...this.#entries, entry].slice(-this.limit);
    return entry;
  }

  /** Accept one `notify_gcode_response` payload; ignores anything else. */
  appendNotification(method: string, params: unknown, atMs = Date.now()): PrinterConsoleEntry | undefined {
    if (method !== 'notify_gcode_response') return undefined;
    const line = Array.isArray(params) ? params[0] : params;
    if (typeof line !== 'string' || line.trim().length === 0) return undefined;
    return this.append(/^(?:!!|Error)/i.test(line.trim()) ? 'error' : 'received', line.trim(), atMs);
  }

  get entries(): readonly PrinterConsoleEntry[] {
    return this.#entries;
  }

  clear(): void {
    this.#entries = [];
  }
}

/**
 * Recently sent commands, newest first and without repeats.
 *
 * Kept separate from the transcript because it is for retyping, and a history
 * that lists the same `M105` forty times is not one anybody scrolls.
 */
export function recentCommands(entries: readonly PrinterConsoleEntry[], limit = 20): readonly string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (let index = entries.length - 1; index >= 0 && commands.length < limit; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'sent' || seen.has(entry.text)) continue;
    seen.add(entry.text);
    commands.push(entry.text);
  }
  return Object.freeze(commands);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^["'].*["']$/.test(trimmed) && trimmed[0] === trimmed.at(-1)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
