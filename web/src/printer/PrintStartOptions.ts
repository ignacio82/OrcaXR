/**
 * What the printer can be asked to do *around* a print, and how to ask it.
 *
 * The desktop slicer offers a handful of choices at the moment you send a job —
 * level the plate first, record a timelapse — and OrcaXR offered none of them,
 * so the same send did less here than it does there.
 *
 * These are not options this app can simply declare. A build-plate probe and a
 * timelapse component are things a particular machine either has or has not,
 * and Klipper/Moonraker will say which: `/printer/objects/list` names the
 * configured objects, `/printer/gcode/help` names the macros, and
 * `/server/info` names the installed components. So an option is offered only
 * when the printer's own answer supports it, and refused with that answer as
 * the reason when it does not.
 *
 * The distinction this module is careful about — the same one
 * `assessCalibrationAutomation` makes — is between *absent* and *not asked*.
 * A machine that has not been queried is unknown, never "cannot"; claiming a
 * printer has no probe because nobody looked is exactly the kind of confident
 * wrongness that makes an operator distrust the whole panel.
 *
 * Nothing here edits the G-code. The published artifact is bound to the
 * semantic snapshot it was sliced from, so levelling runs as its own command
 * before the print starts rather than as an injected line that would leave the
 * file no longer the thing that was reviewed.
 */
import { MoonrakerTransportError } from './MoonrakerTypes';

export type PrintStartOptionId = 'bed-leveling' | 'timelapse';

/** The transport surface these queries and commands need. */
export interface PrintStartOptionsTransport {
  request<T>(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly operation?: string;
      readonly method?: string;
      readonly timeoutMs?: number | null;
    },
  ): Promise<T>;
}

/** Exactly what the printer reported about itself; each field may be unknown. */
export interface PrinterCapabilityReport {
  /** `/printer/objects/list`. */
  readonly objects?: readonly string[];
  /** Macro and command names from `/printer/gcode/help`. */
  readonly commands?: readonly string[];
  /** Moonraker components from `/server/info`. */
  readonly components?: readonly string[];
}

export interface PrintStartOption {
  readonly id: PrintStartOptionId;
  readonly label: string;
  /** What choosing it will actually make the machine do. */
  readonly detail: string;
  readonly available: boolean;
  /** Why it is offered, or the printer's own reason it is not. */
  readonly reason: string;
  /**
   * Whether it starts ticked. Both default to off: each one moves a real
   * machine or writes files to it, and a send should do what the operator
   * asked for and nothing else.
   */
  readonly defaultEnabled: boolean;
  /** The exact command this option will run, when it is a G-code option. */
  readonly command?: string;
}

/** Moonraker paths this module reads. Named so tests assert the real ones. */
export const PRINTER_OBJECTS_PATH = '/printer/objects/list';
export const PRINTER_GCODE_HELP_PATH = '/printer/gcode/help';
export const SERVER_INFO_PATH = '/server/info';
export const TIMELAPSE_SETTINGS_PATH = '/machine/timelapse/settings';

/**
 * Bed levelling, in the order Klipper prefers.
 *
 * `BED_MESH_CALIBRATE` probes a mesh and is what a machine with a `bed_mesh`
 * section is configured for; `G29` is the older single command some
 * configurations still expose. Whichever the printer actually reports is the
 * one that runs — this never sends a command the machine did not name.
 */
const LEVELING_COMMANDS = ['BED_MESH_CALIBRATE', 'G29'] as const;

/** A mesh probe legitimately takes minutes; it must not be cut off as a hang. */
const LEVELING_TIMEOUT_MS = 15 * 60 * 1000;

function normalize(names: readonly string[] | undefined): Set<string> | undefined {
  if (names === undefined) return undefined;
  // Klipper names objects like `bed_mesh` and `extruder stepper`; the first
  // word is the section, which is what identifies the capability.
  return new Set(names.map((name) => name.split(/\s+/, 1)[0].toLowerCase()));
}

/**
 * Decide which pre-print options this printer supports.
 *
 * Every field of `report` is optional because each query can fail on its own;
 * a printer that answered about its objects but not its components is still
 * worth offering levelling to.
 */
export function assessPrintStartOptions(report: PrinterCapabilityReport): readonly PrintStartOption[] {
  const objects = normalize(report.objects);
  const commands = normalize(report.commands);
  const components = normalize(report.components);

  const command = report.commands
    ? LEVELING_COMMANDS.find((candidate) => commands?.has(candidate.toLowerCase()))
    : undefined;
  const hasMesh = objects?.has('bed_mesh') ?? false;
  const levelingKnown = objects !== undefined || commands !== undefined;
  const levelingAvailable = command !== undefined || hasMesh;
  // A printer with a mesh section but no reported macro list still levels with
  // the standard command; naming it keeps the confirmation honest about what
  // will run.
  const levelingCommand = command ?? (hasMesh ? LEVELING_COMMANDS[0] : undefined);

  const timelapseKnown = components !== undefined;
  const timelapseAvailable = components?.has('timelapse') ?? false;

  return Object.freeze([
    Object.freeze({
      id: 'bed-leveling' as const,
      label: 'Calibrate the build plate first',
      detail: levelingCommand
        ? `Runs ${levelingCommand} on the printer and waits for it before the print starts.`
        : 'Probes the plate before the print starts.',
      available: levelingAvailable,
      defaultEnabled: false,
      ...(levelingCommand ? { command: levelingCommand } : {}),
      reason: !levelingKnown
        ? 'Connect the printer to find out whether it can probe its plate.'
        : levelingAvailable
          ? `The printer reports ${hasMesh ? 'a bed_mesh section' : `the ${levelingCommand} command`}.`
          : 'This printer reports no bed_mesh section and no levelling command, so it cannot probe its plate.',
    }),
    Object.freeze({
      id: 'timelapse' as const,
      label: 'Record a timelapse',
      detail: 'Asks Moonraker to record a frame per layer and assemble a video when the print finishes.',
      available: timelapseAvailable,
      defaultEnabled: false,
      reason: !timelapseKnown
        ? 'Connect the printer to find out whether it can record a timelapse.'
        : timelapseAvailable
          ? 'Moonraker reports the timelapse component.'
          : 'This Moonraker has no timelapse component installed, so it cannot record one.',
    }),
  ]);
}

/** Read `/printer/objects/list`. Anything malformed is unknown, not empty. */
export function parsePrinterObjects(payload: unknown): readonly string[] | undefined {
  return readStringArray(payload, 'objects');
}

/** Read `/server/info`'s component list. */
export function parseServerComponents(payload: unknown): readonly string[] | undefined {
  return readStringArray(payload, 'components');
}

/**
 * Read `/printer/gcode/help`, which answers with an object of
 * `{ COMMAND: "description" }` rather than a list.
 */
export function parseGcodeCommands(payload: unknown): readonly string[] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const result = (payload as { result?: unknown }).result ?? payload;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const names = Object.keys(result as Record<string, unknown>);
  return Object.freeze(names.filter((name) => typeof name === 'string'));
}

function readStringArray(payload: unknown, key: string): readonly string[] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const result = (payload as { result?: unknown }).result ?? payload;
  if (result === null || typeof result !== 'object') return undefined;
  const value = (result as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  return Object.freeze(value.filter((entry): entry is string => typeof entry === 'string'));
}

/**
 * Ask the printer what it supports.
 *
 * Each query is independent and a failure in one is not a failure of the
 * others: the report simply leaves that field unknown, and
 * {@link assessPrintStartOptions} says so rather than guessing.
 */
export async function queryPrintStartOptions(
  transport: PrintStartOptionsTransport,
  signal?: AbortSignal,
): Promise<readonly PrintStartOption[]> {
  const ask = async <T>(path: string, operation: string, parse: (payload: unknown) => T): Promise<T | undefined> => {
    try {
      return parse(await transport.request<unknown>(path, { operation, ...(signal ? { signal } : {}) }));
    } catch {
      // An endpoint this Moonraker does not serve, or a link that dropped: the
      // capability is unknown, which is a different answer from "no".
      return undefined;
    }
  };
  const [objects, commands, components] = await Promise.all([
    ask(PRINTER_OBJECTS_PATH, 'printer_objects', parsePrinterObjects),
    ask(PRINTER_GCODE_HELP_PATH, 'gcode_help', parseGcodeCommands),
    ask(SERVER_INFO_PATH, 'server_info', parseServerComponents),
  ]);
  return assessPrintStartOptions({
    ...(objects ? { objects } : {}),
    ...(commands ? { commands } : {}),
    ...(components ? { components } : {}),
  });
}

export type PrintStartOptionPhase = 'timelapse' | 'leveling';

export interface ApplyPrintStartOptionsRequest {
  /** The assessed options; only these can be applied. */
  readonly options: readonly PrintStartOption[];
  /** Ids the operator chose. An id that is not available is refused. */
  readonly enabled: readonly PrintStartOptionId[];
  readonly signal?: AbortSignal;
  onPhase?(phase: PrintStartOptionPhase): void;
}

export class PrintStartOptionError extends Error {
  constructor(
    message: string,
    readonly optionId: PrintStartOptionId,
  ) {
    super(message);
    this.name = 'PrintStartOptionError';
  }
}

/**
 * Carry out the chosen options, in the order that makes sense on the machine.
 *
 * Timelapse is a setting and costs nothing, so it is written first. Levelling
 * physically moves the toolhead and can take minutes, so it runs last, right
 * before the print — and it is awaited, because a print that starts on top of a
 * running probe is worse than no levelling at all.
 *
 * An option the printer did not offer is refused rather than attempted: the
 * selection reaching this function is a claim about a machine, and it is
 * checked against what that machine said.
 */
export async function applyPrintStartOptions(
  transport: PrintStartOptionsTransport,
  request: ApplyPrintStartOptionsRequest,
): Promise<void> {
  const chosen = new Set(request.enabled);
  const byId = new Map(request.options.map((option) => [option.id, option]));
  for (const id of chosen) {
    const option = byId.get(id);
    if (!option) throw new PrintStartOptionError(`No print option named ${id} was offered.`, id);
    if (!option.available) throw new PrintStartOptionError(option.reason, id);
  }

  if (chosen.has('timelapse')) {
    request.onPhase?.('timelapse');
    try {
      await transport.request<unknown>(`${TIMELAPSE_SETTINGS_PATH}?enabled=true`, {
        method: 'POST',
        operation: 'timelapse_enable',
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      throw new PrintStartOptionError(describe(error, 'The printer refused to enable the timelapse.'), 'timelapse');
    }
  }

  if (chosen.has('bed-leveling')) {
    const option = byId.get('bed-leveling');
    const command = option?.command;
    if (!command) {
      throw new PrintStartOptionError('The printer never named a levelling command.', 'bed-leveling');
    }
    request.onPhase?.('leveling');
    try {
      await transport.request<unknown>(`/printer/gcode/script?script=${encodeURIComponent(command)}`, {
        method: 'POST',
        operation: 'bed_leveling',
        timeoutMs: LEVELING_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      throw new PrintStartOptionError(describe(error, `The printer refused ${command}.`), 'bed-leveling');
    }
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof MoonrakerTransportError) return `${fallback} (${error.code})`;
  return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback;
}
