/**
 * Borrowing a real machine preamble from a real slice (P8.2).
 *
 * A generated calibration program needs the printer's own start and end
 * G-code, and those are templates: the Snapmaker U1's start alone is 5,623
 * characters with 44 tokens covering bed mesh calibration, nozzle cleaning,
 * per-extruder auto-feed, bed-type Z-offset branches and expressions like
 * `{nozzle_temperature[initial_extruder] - 90}`. Writing a substitute by hand
 * would produce a file that looks complete and skips bed levelling on a real
 * machine.
 *
 * But the templates do not need to be evaluated here, because the slicer
 * already evaluates them every time it slices. So the preamble is taken from
 * the engine's own output for an ordinary project: it is the machine's real
 * start sequence, produced by the same code that would have produced it for a
 * normal print, with the same profile and the same filament.
 *
 * What this module guards is that the borrowed envelope is actually an
 * envelope. It refuses one whose start does not home and level, or whose end
 * does not finish the print — because the whole point is that an operator's
 * machine goes through its normal preparation, and a preamble that quietly
 * lost `G28` is more dangerous than no program at all.
 */

/** Where a sliced program stops being preamble and starts being the print. */
const FIRST_LAYER_MARKER = ';LAYER_CHANGE';
/** Orca labels the machine end G-code block with its own custom type. */
const CUSTOM_BLOCK_MARKER = ';TYPE:Custom';
const EXECUTABLE_END_MARKER = 'EXECUTABLE_BLOCK_END';

export interface MachineEnvelope {
  /** Everything the printer runs before the first layer, already evaluated. */
  readonly head: string;
  /** Everything it runs after the last one. */
  readonly tail: string;
}

export class MachineEnvelopeError extends Error {
  constructor(
    message: string,
    readonly code: 'no-layers' | 'no-end-block' | 'unsafe-start' | 'unsafe-end',
  ) {
    super(message);
    this.name = 'MachineEnvelopeError';
  }
}

/**
 * Split a sliced program into the machine's preamble and epilogue.
 *
 * The donor must be an ordinary slice from the profile the calibration will
 * print with. Its layers are discarded; only the machine's own preparation and
 * shutdown are kept.
 */
export function extractMachineEnvelope(gcode: string): MachineEnvelope {
  const lines = gcode.split('\n');
  const firstLayer = lines.findIndex((line) => line.startsWith(FIRST_LAYER_MARKER));
  if (firstLayer < 0) {
    throw new MachineEnvelopeError(
      'The donor program has no layers, so it cannot show where the preamble ends',
      'no-layers',
    );
  }

  // The end block is the *last* custom-type block: earlier ones are per-layer
  // or per-object custom G-code, and taking the first would splice the print's
  // middle onto the end of the calibration.
  const executableEnd = lines.findIndex((line) => line.includes(EXECUTABLE_END_MARKER));
  const searchLimit = executableEnd < 0 ? lines.length : executableEnd;
  let endBlock = -1;
  for (let index = searchLimit - 1; index > firstLayer; index -= 1) {
    if (lines[index].startsWith(CUSTOM_BLOCK_MARKER)) {
      endBlock = index;
      break;
    }
  }
  if (endBlock < 0) {
    throw new MachineEnvelopeError('The donor program has no machine end block to borrow', 'no-end-block');
  }

  const head = lines.slice(0, firstLayer).join('\n');
  const tail = lines.slice(endBlock).join('\n');
  assertEnvelopeIsSafe(head, tail);
  return Object.freeze({ head: `${head}\n`, tail: `${tail}\n` });
}

/**
 * Refuse an envelope that would skip the machine's preparation.
 *
 * These are not stylistic checks. A program that reaches an operator without
 * homing will drive a toolhead through whatever is on the bed, and one that
 * never heats will drag a cold nozzle across it. A borrowed preamble missing
 * them means the donor slice was not what this assumed, and continuing would
 * hide that behind a file that looks finished.
 */
function assertEnvelopeIsSafe(head: string, tail: string): void {
  const homes = /^\s*G28\b/m.test(head);
  const heats = /^\s*M1(09|04|90|40)\b/m.test(head) || /_PREHEAT|PRINT_START/.test(head);
  if (!homes) {
    throw new MachineEnvelopeError(
      'The borrowed preamble never homes; refusing to build a program from it',
      'unsafe-start',
    );
  }
  if (!heats) {
    throw new MachineEnvelopeError(
      'The borrowed preamble never heats the nozzle or bed; refusing to build a program from it',
      'unsafe-start',
    );
  }
  if (!/PRINT_END|^\s*M104\s+S0|^\s*M84\b|^\s*M140\s+S0/m.test(tail)) {
    throw new MachineEnvelopeError(
      'The borrowed epilogue never ends the print; refusing to build a program that leaves a machine hot',
      'unsafe-end',
    );
  }
}

/**
 * Wrap a generated calibration body in a real machine envelope.
 *
 * The body is placed exactly where the donor's layers were, so the printer runs
 * its usual preparation, then the calibration, then its usual shutdown.
 */
export function wrapInMachineEnvelope(body: string, envelope: MachineEnvelope): string {
  return `${envelope.head}${body}${envelope.tail}`;
}
