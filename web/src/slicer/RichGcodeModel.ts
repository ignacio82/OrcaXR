/**
 * Bounded web adaptation of the G-code viewer semantics in SnapmakerOrca
 * `src/libslic3r/GCode/GCodeProcessor.cpp`, pinned in this repository at
 * 9fd12ffb2b1b80c9fb4c14564754d2ec1573a626.
 */
export const GCODE_RECORD_KIND = Object.freeze({
  NOOP: 0,
  RETRACT: 1,
  UNRETRACT: 2,
  TOOL_CHANGE: 4,
  COLOR_CHANGE: 5,
  PAUSE: 6,
  CUSTOM: 7,
  TRAVEL: 8,
  WIPE: 9,
  EXTRUDE: 10,
  LAYER_CHANGE: 11,
  WIPE_START: 12,
  WIPE_END: 13,
} as const);

export type GcodeRecordKind = (typeof GCODE_RECORD_KIND)[keyof typeof GCODE_RECORD_KIND];

/** Pinned `EMovePathType` subset retained by the bounded web model. */
export const GCODE_PATH_KIND = Object.freeze({
  /** Upstream's default `Noop` path: direct start-to-end rendering for non-arcs. */
  DIRECT: 0,
  ARC_CW: 2,
  ARC_CCW: 3,
} as const);

export type GcodePathKind = (typeof GCODE_PATH_KIND)[keyof typeof GCODE_PATH_KIND];

export const GCODE_RECORD_KIND_NAMES = Object.freeze([
  'noop',
  'retract',
  'unretract',
  'reserved-seam',
  'tool-change',
  'color-change',
  'pause',
  'custom',
  'travel',
  'wipe',
  'extrude',
  'layer-change',
  'wipe-start',
  'wipe-end',
] as const);

export const RICH_GCODE_HARD_CAPS = Object.freeze({
  inputCharacters: 64 * 1024 * 1024,
  lines: 4_000_000,
  records: 1_500_000,
  pathPoints: 4_000_000,
  warnings: 2_048,
  lineCharacters: 64 * 1024,
  roles: 512,
  filaments: 4_096,
});

export interface RichGcodeLimits {
  readonly inputCharacters: number;
  readonly lines: number;
  readonly records: number;
  readonly pathPoints: number;
  readonly warnings: number;
  readonly lineCharacters: number;
  readonly roles: number;
  readonly filaments: number;
}

export interface RichGcodeParseOptions {
  readonly filamentDiametersMm?: readonly number[];
  readonly filamentColors?: readonly string[];
  /** Requested values are clamped to the exported non-negotiable hard caps. */
  readonly limits?: Partial<RichGcodeLimits>;
}

export interface GcodeFilamentIdentity {
  readonly id: number;
  readonly tool: number;
  readonly source: 'tool' | 'color-change';
  readonly color?: string;
}

export interface GcodeParseWarning {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  /** One-based physical source line, or zero for a whole-input diagnostic. */
  readonly line: number;
  /** Half-open UTF-16 offsets into the exact input string. */
  readonly startOffset: number;
  readonly endOffset: number;
}

export type GcodeTerminationReason = 'input-cap' | 'line-cap' | 'record-cap' | 'path-point-cap' | 'numeric-cap';

/**
 * One row per classified move or source marker. Numeric data is stored in
 * contiguous typed columns so callers do not need to allocate an object per
 * G-code move.
 */
export interface RichGcodeColumns {
  readonly count: number;
  readonly kind: Uint8Array;
  readonly startX: Float32Array;
  readonly startY: Float32Array;
  readonly startZ: Float32Array;
  readonly endX: Float32Array;
  readonly endY: Float32Array;
  readonly endZ: Float32Array;
  readonly deltaE: Float32Array;
  readonly feedrateMmPerSecond: Float32Array;
  readonly widthMm: Float32Array;
  readonly heightMm: Float32Array;
  readonly mm3PerMm: Float32Array;
  readonly volumetricFlowMm3PerSecond: Float32Array;
  readonly fanPercent: Float32Array;
  readonly hotendTemperatureC: Float32Array;
  readonly layer: Uint32Array;
  readonly role: Uint16Array;
  readonly tool: Uint16Array;
  readonly filament: Uint16Array;
  readonly sourceLine: Uint32Array;
  readonly sourceStartOffset: Uint32Array;
  readonly sourceEndOffset: Uint32Array;
  /** Parsed N-word, or -1 when the source line has no numbered command. */
  readonly commandLineNumber: Int32Array;
  readonly pathKind: Uint8Array;
  /** Dense offset into `RichGcodeModel.pathPoints`; meaningful even when count is zero. */
  readonly pathPointOffset: Uint32Array;
  /** Pinned intermediate interpolation points; the final point may equal the record endpoint. */
  readonly pathPointCount: Uint32Array;
  /** Absolute printer-mm XY center for arcs; canonical zero for linear paths. */
  readonly arcCenterX: Float32Array;
  readonly arcCenterY: Float32Array;
}

export interface RichGcodePathPoints {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
}

export interface RichGcodeModel {
  readonly columns: RichGcodeColumns;
  readonly pathPoints: RichGcodePathPoints;
  readonly roles: readonly string[];
  readonly filaments: readonly GcodeFilamentIdentity[];
  readonly layerCount: number;
  readonly warnings: readonly GcodeParseWarning[];
  readonly sourceLength: number;
  readonly parsedCharacters: number;
  readonly parsedLines: number;
  readonly complete: boolean;
  readonly terminationReason?: GcodeTerminationReason;
  readonly limits: RichGcodeLimits;
}

interface SourceLocation {
  readonly line: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly commandLineNumber: number;
}

interface RecordValue {
  readonly kind: GcodeRecordKind;
  readonly startX: number;
  readonly startY: number;
  readonly startZ: number;
  readonly endX: number;
  readonly endY: number;
  readonly endZ: number;
  readonly deltaE: number;
  readonly feedrateMmPerSecond: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly mm3PerMm: number;
  readonly volumetricFlowMm3PerSecond: number;
  readonly fanPercent: number;
  readonly hotendTemperatureC: number;
  readonly layer: number;
  readonly role: number;
  readonly tool: number;
  readonly filament: number;
  readonly source: SourceLocation;
  readonly pathKind: GcodePathKind;
  readonly pathPoints?: ArcInterpolationPoints;
  readonly arcCenterX?: number;
  readonly arcCenterY?: number;
}

interface ArcInterpolationPoints {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
}

interface ParsedCommand {
  readonly letter: string;
  readonly code: number;
  readonly exactArcSpelling: boolean;
  readonly parameters: ReadonlyMap<string, number>;
  readonly invalidParameters: ReadonlySet<string>;
  readonly commandLineNumber: number;
}

interface NumberScan {
  readonly valid: boolean;
  /** The token was syntactically numeric but exceeded JavaScript's finite domain. */
  readonly outOfRange: boolean;
  readonly value: number;
  readonly end: number;
}

const DEFAULT_FILAMENT_DIAMETER_MM = 1.75;
const DEFAULT_TOOLPATH_WIDTH_MM = 0.4;
const DEFAULT_TOOLPATH_HEIGHT_MM = 0.2;
const WIPE_WIDTH_MM = 0.05;
const WIPE_HEIGHT_MM = 0.05;
const UPSTREAM_EPSILON = 1e-4;
const DRAW_ARC_TOLERANCE_MM = Math.fround(0.0125);
const FULL_CIRCLE_POSITION_EPSILON_MM = 1e-6;
const MM_PER_MINUTE_TO_MM_PER_SECOND = Math.fround(1 / 60);
const MAX_TOOL_IDENTITIES = 256;
const MAX_COMMAND_LINE_NUMBER = 0x7fffffff;
const DEFAULT_COLOR_CHANGES = ['#0B2C7A', '#1C8891', '#AAF200', '#F5CE0A', '#D16830', '#942616'] as const;

export function parseRichGcodeModel(gcode: string, options: RichGcodeParseOptions = {}): RichGcodeModel {
  return new RichGcodeParser(gcode, options).parse();
}

class RichGcodeParser {
  private readonly limits: RichGcodeLimits;
  private readonly warnings: WarningCollector;
  private readonly columns: RecordColumnsBuilder;
  private readonly filamentDiameters: readonly number[];
  private readonly filamentColors: readonly string[];
  private readonly roles = ['Undefined'];
  private readonly roleIndices = new Map<string, number>([['Undefined', 0]]);
  private readonly filaments: GcodeFilamentIdentity[] = [];
  private readonly toolFilaments = new Map<number, number>();
  private readonly hotendTemperatures = new Float64Array(256);

  private x = 0;
  private y = 0;
  private z = 0;
  private e = 0;
  private originX = 0;
  private originY = 0;
  private originZ = 0;
  private originE = 0;
  private unitsToMm = 1;
  private globalRelative = false;
  private extruderRelative = false;
  private feedrateMmPerSecond = 0;
  private fanPercent = 0;
  private forcedWidthMm = 0;
  private forcedHeightMm = 0;
  private currentWidthMm = 0;
  private currentHeightMm = 0;
  private extrudedLastZ = 0;
  private role = 0;
  private tool = 0;
  private filament = 0;
  private layerCount = 0;
  private wiping = false;
  private parsedLines = 0;
  private parsedCharacters = 0;
  private defaultColorIndex = 0;
  private terminationReason: GcodeTerminationReason | undefined;

  constructor(
    private readonly gcode: string,
    options: RichGcodeParseOptions,
  ) {
    this.limits = resolveLimits(options.limits);
    this.warnings = new WarningCollector(this.limits.warnings);
    this.columns = new RecordColumnsBuilder(this.limits.records, this.limits.pathPoints);
    this.filamentDiameters = normalizeFilamentDiameters(options.filamentDiametersMm);
    this.filamentColors = normalizeFilamentColors(options.filamentColors);
    this.filament = this.ensureToolFilament(0, wholeInputLocation());
  }

  parse(): RichGcodeModel {
    const parseEnd = Math.min(this.gcode.length, this.limits.inputCharacters);
    if (parseEnd < this.gcode.length) {
      this.terminationReason = 'input-cap';
      this.warn(
        'input-character-cap',
        `G-code input exceeds the hard parse budget of ${this.limits.inputCharacters} characters; only a bounded prefix was inspected`,
        {
          line: 0,
          startOffset: parseEnd,
          endOffset: this.gcode.length,
          commandLineNumber: -1,
        },
      );
    }

    let start = 0;
    let line = 1;
    while (start < parseEnd && !this.shouldStopImmediately()) {
      if (this.parsedLines >= this.limits.lines) {
        this.stop(
          'line-cap',
          'source-line-cap',
          `G-code exceeds the hard parse budget of ${this.limits.lines} source lines`,
          {
            line,
            startOffset: start,
            endOffset: parseEnd,
            commandLineNumber: -1,
          },
        );
        break;
      }

      let newline = this.gcode.indexOf('\n', start);
      if (newline < 0 || newline > parseEnd) newline = parseEnd;
      const rawEnd = newline;
      const contentEnd = rawEnd > start && this.gcode.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
      const location: SourceLocation = {
        line,
        startOffset: start,
        endOffset: rawEnd,
        commandLineNumber: -1,
      };

      this.parsedLines += 1;
      this.parsedCharacters = rawEnd;
      const cutByInputCap =
        parseEnd < this.gcode.length &&
        rawEnd === parseEnd &&
        parseEnd > 0 &&
        this.gcode.charCodeAt(parseEnd - 1) !== 10;
      if (cutByInputCap) {
        this.warn(
          'truncated-source-line',
          'The input character cap cuts through this source line; it was not parsed',
          location,
        );
      } else if (contentEnd - start > this.limits.lineCharacters) {
        this.warn(
          'source-line-too-long',
          `Source line exceeds the hard limit of ${this.limits.lineCharacters} characters and was skipped`,
          location,
        );
      } else {
        this.processLine(this.gcode.slice(start, contentEnd), location);
      }

      if (newline >= parseEnd) {
        this.parsedCharacters = parseEnd;
        break;
      }
      start = newline + 1;
      this.parsedCharacters = start;
      line += 1;
    }

    const built = this.columns.finish();
    return {
      columns: built.columns,
      pathPoints: built.pathPoints,
      roles: Object.freeze([...this.roles]),
      filaments: Object.freeze(this.filaments.map((filament) => Object.freeze({ ...filament }))),
      layerCount: this.layerCount,
      warnings: this.warnings.finish(),
      sourceLength: this.gcode.length,
      parsedCharacters: this.parsedCharacters,
      parsedLines: this.parsedLines,
      complete: this.terminationReason === undefined,
      ...(this.terminationReason ? { terminationReason: this.terminationReason } : {}),
      limits: this.limits,
    };
  }

  private processLine(line: string, location: SourceLocation): void {
    let contentStart = skipWhitespace(line, 0, line.length);
    if (location.line === 1 && line.charCodeAt(contentStart) === 0xfeff) {
      contentStart = skipWhitespace(line, contentStart + 1, line.length);
    }
    if (line[contentStart] === ';') {
      this.processTag(line.slice(contentStart + 1), location);
      return;
    }
    const command = parseCommand(line, location, (code, message) => this.warn(code, message, location));
    if (!command) return;
    const source = { ...location, commandLineNumber: command.commandLineNumber };
    const parameter = (letter: string): number | undefined => command.parameters.get(letter);

    if (command.letter === 'G') {
      switch (command.code) {
        case 0:
        case 1:
          this.processLinearMove(command.parameters, source);
          return;
        case 2:
        case 3:
          if (!command.exactArcSpelling) return;
          this.processArcMove(command.parameters, command.invalidParameters, source, command.code === 3);
          return;
        case 20:
          this.unitsToMm = 25.4;
          return;
        case 21:
          this.unitsToMm = 1;
          return;
        case 22:
          this.emitMarker(GCODE_RECORD_KIND.RETRACT, source);
          return;
        case 23:
          this.emitMarker(GCODE_RECORD_KIND.UNRETRACT, source);
          return;
        case 90:
          this.globalRelative = false;
          return;
        case 91:
          this.globalRelative = true;
          return;
        case 92:
          this.processSetPosition(command.parameters);
          return;
        default:
          return;
      }
    }

    if (command.letter === 'M') {
      switch (command.code) {
        case 82:
          this.extruderRelative = false;
          return;
        case 83:
          this.extruderRelative = true;
          return;
        case 104: {
          const value = parameter('S');
          if (value !== undefined) this.hotendTemperatures[this.tool] = value;
          return;
        }
        case 106: {
          const fan = parameter('P');
          if (fan === undefined || fan === 1) {
            const value = parameter('S');
            this.fanPercent = value === undefined ? 100 : (100 / 255) * value;
          }
          return;
        }
        case 107:
          this.fanPercent = 0;
          return;
        case 109: {
          const value = parameter('R') ?? parameter('S');
          if (value === undefined) return;
          const requestedTool = parameter('R') !== undefined ? parameter('T') : undefined;
          if (requestedTool === undefined) {
            this.hotendTemperatures[this.tool] = value;
          } else if (Number.isInteger(requestedTool) && requestedTool >= 0 && requestedTool <= 255) {
            this.hotendTemperatures[requestedTool] = value;
          } else {
            this.warn(
              'invalid-temperature-tool',
              `M109 target T${requestedTool} is outside the supported range`,
              source,
            );
          }
          return;
        }
        default:
          return;
      }
    }

    if (command.letter === 'T') this.changeTool(command.code, source);
  }

  private processTag(comment: string, source: SourceLocation): void {
    const roleValue = prefixedValue(comment, ['TYPE:', ' FEATURE: ']);
    if (roleValue !== undefined) {
      const role = roleValue.trim();
      if (!role) {
        this.warn('empty-role-tag', 'Extrusion role tag has no value', source);
      } else {
        this.role = this.roleIndex(role, source);
      }
      return;
    }

    const heightValue = prefixedValue(comment, ['HEIGHT:', ' LAYER_HEIGHT: ']);
    if (heightValue !== undefined) {
      const parsed = strictFiniteNumber(heightValue);
      if (parsed === undefined) {
        this.warn('invalid-height-tag', `Invalid layer height tag "${heightValue.trim()}"`, source);
      } else {
        const normalized = Math.fround(parsed);
        if (Number.isFinite(normalized)) {
          this.forcedHeightMm = normalized;
        } else {
          this.warn('invalid-height-tag', `Layer height tag "${heightValue.trim()}" exceeds Float32`, source);
        }
      }
      return;
    }

    const widthValue = prefixedValue(comment, ['WIDTH:', ' LINE_WIDTH: ']);
    if (widthValue !== undefined) {
      const parsed = strictFiniteNumber(widthValue);
      if (parsed === undefined) {
        this.warn('invalid-width-tag', `Invalid line width tag "${widthValue.trim()}"`, source);
      } else {
        const normalized = Math.fround(parsed);
        if (Number.isFinite(normalized)) {
          this.forcedWidthMm = normalized;
        } else {
          this.warn('invalid-width-tag', `Line width tag "${widthValue.trim()}" exceeds Float32`, source);
        }
      }
      return;
    }

    const exactComment = comment.trimEnd();
    if (exactComment === 'LAYER_CHANGE' || exactComment === ' CHANGE_LAYER') {
      this.layerCount += 1;
      this.emitMarker(GCODE_RECORD_KIND.LAYER_CHANGE, source);
      return;
    }

    if (comment.startsWith('WIPE_START') || comment.startsWith(' WIPE_START')) {
      this.wiping = true;
      this.emitMarker(GCODE_RECORD_KIND.WIPE_START, source);
      return;
    }
    if (comment.startsWith('WIPE_END') || comment.startsWith(' WIPE_END')) {
      this.wiping = false;
      this.emitMarker(GCODE_RECORD_KIND.WIPE_END, source);
      return;
    }

    const colorPrefix = comment.startsWith('COLOR_CHANGE')
      ? 'COLOR_CHANGE'
      : comment.startsWith(' COLOR_CHANGE')
        ? ' COLOR_CHANGE'
        : undefined;
    if (colorPrefix) {
      this.processColorChange(comment.slice(colorPrefix.length), source);
      return;
    }

    if (exactComment === 'PAUSE_PRINT' || exactComment === ' PAUSE_PRINTING') {
      this.emitMarker(GCODE_RECORD_KIND.PAUSE, source);
      return;
    }
    if (exactComment === 'CUSTOM_GCODE' || exactComment === ' CUSTOM_GCODE') {
      this.emitMarker(GCODE_RECORD_KIND.CUSTOM, source);
      return;
    }

    const manualToolPrefix = ' MANUAL_TOOL_CHANGE ';
    if (comment.startsWith(manualToolPrefix)) {
      const command = comment.slice(manualToolPrefix.length).trim();
      const match = /^T(\d+)$/i.exec(command);
      if (!match) {
        this.warn('invalid-manual-tool-change', `Invalid manual tool change marker "${command}"`, source);
      } else {
        this.changeTool(Number(match[1]), source);
      }
    }
  }

  private processLinearMove(parameters: ReadonlyMap<string, number>, source: SourceLocation): void {
    const startX = this.x;
    const startY = this.y;
    const startZ = this.z;
    const startE = this.e;
    const endX = this.axisPosition('X', parameters, this.x, this.originX, false);
    const endY = this.axisPosition('Y', parameters, this.y, this.originY, false);
    let endZ = this.axisPosition('Z', parameters, this.z, this.originZ, false);
    const endE = this.axisPosition('E', parameters, this.e, this.originE, true);
    const feed = parameters.get('F');
    if (feed !== undefined) {
      // The pinned processor converts positional axes in G20 mode, but keeps
      // feedrate words in mm/min before converting them to mm/s.
      const converted = Math.fround(feed * MM_PER_MINUTE_TO_MM_PER_SECOND);
      if (converted < 0) {
        this.warn('negative-feedrate', `Negative feedrate ${feed} was ignored`, source);
      } else {
        this.feedrateMmPerSecond = converted;
      }
    }

    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const deltaZ = endZ - startZ;
    const deltaE = endE - startE;
    if (deltaX === 0 && deltaY === 0 && deltaZ === 0 && deltaE === 0) {
      return;
    }

    const kind = classifyMove(this.wiping, deltaX, deltaY, deltaZ, deltaE);
    let widthMm = 0;
    let heightMm = 0;
    let mm3PerMm = 0;
    let volumetricFlow = 0;
    if (kind === GCODE_RECORD_KIND.EXTRUDE) {
      const distance = Math.hypot(deltaX, deltaY, deltaZ);
      const filamentDiameter = this.filamentDiameter(this.tool);
      const filamentArea = Math.PI * (filamentDiameter * 0.5) ** 2;
      mm3PerMm = distance > 0 ? (filamentArea * deltaE) / distance : 0;
      volumetricFlow = mm3PerMm * this.feedrateMmPerSecond;

      const previousExtrudedLastZ = Math.fround(this.extrudedLastZ);
      this.currentHeightMm = Math.fround(this.currentHeightMm);
      if (this.forcedHeightMm > 0) {
        this.currentHeightMm = Math.fround(this.forcedHeightMm);
      } else if (endZ > previousExtrudedLastZ + UPSTREAM_EPSILON) {
        this.currentHeightMm = Math.fround(endZ - previousExtrudedLastZ);
      }
      if (this.currentHeightMm === 0) this.currentHeightMm = Math.fround(DEFAULT_TOOLPATH_HEIGHT_MM);
      if (endZ === 0) endZ = this.currentHeightMm;
      this.extrudedLastZ = Math.fround(endZ);

      if (this.forcedWidthMm > 0) {
        this.currentWidthMm = Math.fround(this.forcedWidthMm);
      } else {
        this.currentWidthMm = Math.fround(
          estimateWidth(this.roles[this.role], filamentDiameter, deltaE, distance, this.currentHeightMm),
        );
      }
      widthMm = this.currentWidthMm;
      heightMm = this.currentHeightMm;
    } else if (kind === GCODE_RECORD_KIND.WIPE) {
      widthMm = WIPE_WIDTH_MM;
      heightMm = WIPE_HEIGHT_MM;
    }

    const emitted = this.emit({
      kind,
      startX,
      startY,
      startZ,
      endX,
      endY,
      endZ,
      deltaE,
      feedrateMmPerSecond: this.feedrateMmPerSecond,
      widthMm,
      heightMm,
      mm3PerMm,
      volumetricFlowMm3PerSecond: volumetricFlow,
      fanPercent: this.fanPercent,
      hotendTemperatureC: this.hotendTemperatures[this.tool],
      layer: this.layerCount,
      role: this.role,
      tool: this.tool,
      filament: this.filament,
      source,
      pathKind: GCODE_PATH_KIND.DIRECT,
    });
    if (!emitted) return;
    this.x = endX;
    this.y = endY;
    this.z = endZ;
    this.e = endE;
  }

  /**
   * Port of the pinned `GCodeProcessor::process_G2_G3` XY-plane arc model.
   * I/J are always offsets from the current position, P supports one complete
   * turn only, and a single semantic move owns a bounded interpolation slice.
   */
  private processArcMove(
    parameters: ReadonlyMap<string, number>,
    invalidParameters: ReadonlySet<string>,
    source: SourceLocation,
    isCounterClockwise: boolean,
  ): void {
    const startX = this.x;
    const startY = this.y;
    const startZ = this.z;
    const startE = this.e;
    const endX = this.axisPosition('X', parameters, startX, this.originX, false);
    const endY = this.axisPosition('Y', parameters, startY, this.originY, false);
    const rawEndZ = this.axisPosition('Z', parameters, startZ, this.originZ, false);
    const endE = this.axisPosition('E', parameters, startE, this.originE, true);

    if (![startX, startY, startZ, startE, endX, endY, rawEndZ, endE].every(isFiniteFloat32)) {
      this.rejectUnsafeArc('arc-coordinate-range', 'Arc coordinates are outside the finite Float32 domain', source);
      return;
    }

    // The pinned processor advances endpoint state before rejecting malformed
    // I/J/P forms. Preserve that observable modal behavior while emitting no
    // record or sidecar points for the invalid command.
    const advanceRejectedEndpoint = (): void => {
      this.x = endX;
      this.y = endY;
      this.z = rawEndZ;
      this.e = endE;
    };

    if (['X', 'Y', 'Z', 'E', 'I', 'J', 'P', 'F'].some((parameter) => invalidParameters.has(parameter))) {
      this.rejectUnsafeArc('arc-parameter-range', 'Arc parameters are outside the finite Float32 domain', source);
      return;
    }

    if (!parameters.has('I') && !parameters.has('J')) {
      this.warn('missing-arc-center', 'G2/G3 requires at least one I/J center offset', source, 'error');
      advanceRejectedEndpoint();
      return;
    }
    const turns = parameters.get('P');
    const pinnedTurns = turns === undefined ? undefined : Math.fround(turns);
    if (
      pinnedTurns !== undefined &&
      (!Number.isFinite(pinnedTurns) || Math.trunc(pinnedTurns) !== 1 || startX !== endX || startY !== endY)
    ) {
      this.warn(
        'invalid-arc-turns',
        'G2/G3 P mode requires a Float32 turn value whose truncated integer is 1 and an endpoint whose X/Y exactly matches the start',
        source,
        'error',
      );
      advanceRejectedEndpoint();
      return;
    }

    const centerX = startX + this.scaledAxisWord(parameters.get('I') ?? 0);
    const centerY = startY + this.scaledAxisWord(parameters.get('J') ?? 0);
    if (![centerX, centerY].every(isFiniteFloat32)) {
      this.rejectUnsafeArc('arc-center-range', 'Arc center coordinates are outside the finite Float32 domain', source);
      return;
    }

    // Arc geometry enters the pinned implementation through Vec3f even though
    // its modal endpoint state is double. Retain each float assignment so
    // floor(angle/chordStep) agrees at interpolation-count boundaries.
    const arcStartX = Math.fround(startX);
    const arcStartY = Math.fround(startY);
    const arcStartZ = Math.fround(startZ);
    const arcEndX = Math.fround(endX);
    const arcEndY = Math.fround(endY);
    const arcEndZ = Math.fround(rawEndZ);
    const arcCenterX = Math.fround(centerX);
    const arcCenterY = Math.fround(centerY);
    const radius = float32VectorLength(Math.fround(arcStartX - arcCenterX), Math.fround(arcStartY - arcCenterY));
    const angle = calculateArcRadians(
      arcStartX,
      arcStartY,
      arcEndX,
      arcEndY,
      arcCenterX,
      arcCenterY,
      isCounterClockwise,
    );
    const arcLength =
      pinnedTurns === undefined
        ? Math.fround(radius * angle)
        : Math.fround(Math.trunc(pinnedTurns) * 2 * Math.PI * radius);
    const deltaZ = rawEndZ - startZ;
    const arcDeltaZ = Math.fround(arcEndZ - arcStartZ);
    const deltaE = endE - startE;
    const distance = Math.fround(Math.sqrt(Math.fround(arcLength * arcLength) + deltaZ * deltaZ));
    if (![radius, angle, arcLength, deltaZ, arcDeltaZ, deltaE, distance].every(isFiniteFloat32)) {
      this.rejectUnsafeArc('arc-metric-range', 'Arc geometry exceeds the finite Float32 metric domain', source);
      return;
    }

    let nextFeedrate = this.feedrateMmPerSecond;
    const feed = parameters.get('F');
    if (feed !== undefined) {
      const converted = Math.fround(feed * MM_PER_MINUTE_TO_MM_PER_SECOND);
      if (converted < 0) {
        this.warn('negative-feedrate', `Negative feedrate ${feed} was ignored`, source);
      } else {
        nextFeedrate = converted;
      }
    }
    if (!isFiniteFloat32(nextFeedrate)) {
      this.rejectUnsafeArc('arc-feedrate-range', 'Arc feedrate is outside the finite Float32 domain', source);
      return;
    }

    if (arcLength === 0 && deltaZ === 0) {
      this.x = endX;
      this.y = endY;
      this.z = rawEndZ;
      this.e = endE;
      this.feedrateMmPerSecond = nextFeedrate;
      return;
    }

    // Record capacity is cheaper and more fundamental than interpolation
    // capacity. Resolve it before planning or allocating an arc sidecar.
    if (this.columns.remainingRecords === 0) {
      this.stop(
        'record-cap',
        'record-cap',
        `Classified record count reached the hard limit of ${this.limits.records}`,
        source,
      );
      return;
    }

    const interpolation = planArcInterpolation(radius, angle, arcDeltaZ);
    if (interpolation === undefined) {
      this.rejectUnsafeArc(
        'arc-interpolation-range',
        'Arc interpolation step or point count is outside the bounded numeric domain',
        source,
      );
      return;
    }
    if (interpolation.count > this.columns.remainingPathPoints) {
      this.stop(
        'path-point-cap',
        'arc-path-point-cap',
        `Arc interpolation exceeds the remaining bounded path-point budget of ${this.columns.remainingPathPoints}`,
        source,
        'error',
      );
      return;
    }
    const pathPoints = buildArcInterpolationPoints(
      interpolation,
      arcStartX,
      arcStartY,
      arcStartZ,
      arcCenterX,
      arcCenterY,
      isCounterClockwise,
    );
    if (!pathPoints) {
      this.rejectUnsafeArc(
        'arc-interpolation-range',
        'Arc interpolation produced a point outside the finite Float32 domain',
        source,
      );
      return;
    }

    // Pinned arc classification intentionally differs from G0/G1: any nonzero
    // E delta (including a retracting arc) is an extrusion, and WIPE tags do
    // not override it. Retain that source behavior; numeric guards still keep
    // negative-volume width calculations finite.
    const kind = deltaE === 0 ? GCODE_RECORD_KIND.TRAVEL : GCODE_RECORD_KIND.EXTRUDE;
    let endZ = rawEndZ;
    let nextHeight = Math.fround(this.currentHeightMm);
    let nextWidth = Math.fround(this.currentWidthMm);
    let nextExtrudedLastZ = Math.fround(this.extrudedLastZ);
    let widthMm = 0;
    let heightMm = 0;
    let mm3PerMm = 0;
    let volumetricFlow = 0;
    if (kind === GCODE_RECORD_KIND.EXTRUDE) {
      const filamentDiameter = Math.fround(this.filamentDiameter(this.tool));
      const filamentRadius = Math.fround(0.5 * filamentDiameter);
      const filamentArea = Math.fround(Math.fround(Math.PI) * Math.fround(filamentRadius * filamentRadius));
      const volume = Math.fround(filamentArea * deltaE);
      mm3PerMm = distance > 0 ? Math.fround(volume / distance) : 0;
      volumetricFlow = Math.fround(mm3PerMm * nextFeedrate);

      if (this.forcedHeightMm > 0) {
        nextHeight = this.forcedHeightMm;
      } else if (endZ > nextExtrudedLastZ + UPSTREAM_EPSILON) {
        nextHeight = Math.fround(endZ - nextExtrudedLastZ);
      }
      if (nextHeight === 0) nextHeight = Math.fround(DEFAULT_TOOLPATH_HEIGHT_MM);
      if (endZ === 0) endZ = nextHeight;
      nextExtrudedLastZ = Math.fround(endZ);
      nextWidth = estimateArcWidth(
        this.roles[this.role],
        filamentDiameter,
        filamentRadius,
        deltaE,
        distance,
        nextHeight,
        this.forcedWidthMm,
      );
      widthMm = nextWidth;
      heightMm = nextHeight;
    }

    const record: RecordValue = {
      kind,
      startX,
      startY,
      startZ,
      endX,
      endY,
      endZ,
      deltaE,
      feedrateMmPerSecond: nextFeedrate,
      widthMm,
      heightMm,
      mm3PerMm,
      volumetricFlowMm3PerSecond: volumetricFlow,
      fanPercent: this.fanPercent,
      hotendTemperatureC: this.hotendTemperatures[this.tool],
      layer: this.layerCount,
      role: this.role,
      tool: this.tool,
      filament: this.filament,
      source,
      pathKind: isCounterClockwise ? GCODE_PATH_KIND.ARC_CCW : GCODE_PATH_KIND.ARC_CW,
      pathPoints,
      arcCenterX,
      arcCenterY,
    };
    if (!recordHasFiniteFloat32Values(record)) {
      this.rejectUnsafeArc('arc-record-range', 'Arc record metadata is outside the finite Float32 domain', source);
      return;
    }
    if (!this.emit(record)) return;

    this.x = endX;
    this.y = endY;
    this.z = endZ;
    this.e = endE;
    this.feedrateMmPerSecond = nextFeedrate;
    this.currentHeightMm = nextHeight;
    this.currentWidthMm = nextWidth;
    this.extrudedLastZ = nextExtrudedLastZ;
  }

  private rejectUnsafeArc(code: string, message: string, source: SourceLocation): void {
    this.stop('numeric-cap', code, message, source, 'error');
  }

  private processSetPosition(parameters: ReadonlyMap<string, number>): void {
    let found = false;
    const x = parameters.get('X');
    if (x !== undefined) {
      this.originX = this.x - this.scaledAxisWord(x);
      found = true;
    }
    const y = parameters.get('Y');
    if (y !== undefined) {
      this.originY = this.y - this.scaledAxisWord(y);
      found = true;
    }
    const z = parameters.get('Z');
    if (z !== undefined) {
      this.originZ = this.z - this.scaledAxisWord(z);
      found = true;
    }
    const e = parameters.get('E');
    if (e !== undefined) {
      this.e = this.scaledAxisWord(e);
      found = true;
    }
    const hasUnknownAxis = [...parameters.keys()].some(
      (axis) =>
        axis !== 'X' &&
        axis !== 'Y' &&
        axis !== 'Z' &&
        axis !== 'E' &&
        axis !== 'F' &&
        axis !== 'I' &&
        axis !== 'J' &&
        axis !== 'P',
    );
    if (!found && !hasUnknownAxis) {
      this.originX = this.x;
      this.originY = this.y;
      this.originZ = this.z;
      this.originE = this.e;
    }
  }

  private processColorChange(value: string, source: SourceLocation): void {
    const tokens = value.split(',').map((token) => token.trim());
    let targetTool = 0;
    if (tokens[1]) {
      const match = /^T(\d+)$/.exec(tokens[1]);
      if (!match || Number(match[1]) > 255) {
        this.warn('invalid-color-change-tool', `Invalid color-change tool "${tokens[1]}"`, source);
        return;
      }
      targetTool = Number(match[1]);
    }

    let color: string;
    if (tokens[2] && /^#[0-9a-fA-F]{6}$/.test(tokens[2])) {
      color = tokens[2].toUpperCase();
    } else {
      if (tokens[2]) this.warn('invalid-color-change-color', `Invalid color-change value "${tokens[2]}"`, source);
      color = DEFAULT_COLOR_CHANGES[this.defaultColorIndex];
      this.defaultColorIndex = (this.defaultColorIndex + 1) % DEFAULT_COLOR_CHANGES.length;
    }

    const filament = this.createFilament(targetTool, 'color-change', color, source);
    this.toolFilaments.set(targetTool, filament);
    if (targetTool === this.tool) {
      this.filament = filament;
      this.emitMarker(GCODE_RECORD_KIND.COLOR_CHANGE, source);
    }
  }

  private changeTool(nextTool: number, source: SourceLocation): void {
    if (!Number.isInteger(nextTool) || nextTool < 0 || nextTool > 254) {
      if (nextTool !== 255 && nextTool !== 1000 && nextTool !== 1100) {
        this.warn('invalid-tool-command', `Tool T${nextTool} is outside the supported 0..254 range`, source);
      }
      return;
    }
    if (nextTool === this.tool) return;
    this.tool = nextTool;
    this.filament = this.ensureToolFilament(nextTool, source);
    this.emitMarker(GCODE_RECORD_KIND.TOOL_CHANGE, source);
  }

  private emitMarker(kind: GcodeRecordKind, source: SourceLocation): boolean {
    return this.emit({
      kind,
      startX: this.x,
      startY: this.y,
      startZ: this.z,
      endX: this.x,
      endY: this.y,
      endZ: this.z,
      deltaE: 0,
      feedrateMmPerSecond: this.feedrateMmPerSecond,
      widthMm: kind === GCODE_RECORD_KIND.WIPE ? WIPE_WIDTH_MM : 0,
      heightMm: kind === GCODE_RECORD_KIND.WIPE ? WIPE_HEIGHT_MM : 0,
      mm3PerMm: 0,
      volumetricFlowMm3PerSecond: 0,
      fanPercent: this.fanPercent,
      hotendTemperatureC: this.hotendTemperatures[this.tool],
      layer: this.layerCount,
      role: this.role,
      tool: this.tool,
      filament: this.filament,
      source,
      pathKind: GCODE_PATH_KIND.DIRECT,
    });
  }

  private emit(record: RecordValue): boolean {
    const result = this.columns.append(record);
    if (result === 'record-cap') {
      this.stop(
        'record-cap',
        'record-cap',
        `Classified record count reached the hard limit of ${this.limits.records}`,
        record.source,
      );
      return false;
    }
    if (result === 'path-point-cap') {
      this.stop(
        'path-point-cap',
        'arc-path-point-cap',
        `Arc interpolation would exceed the hard limit of ${this.limits.pathPoints} path points`,
        record.source,
        'error',
      );
      return false;
    }
    return true;
  }

  private axisPosition(
    letter: 'X' | 'Y' | 'Z' | 'E',
    parameters: ReadonlyMap<string, number>,
    current: number,
    origin: number,
    extrusion: boolean,
  ): number {
    const value = parameters.get(letter);
    if (value === undefined) return current;
    const converted = this.scaledAxisWord(value);
    const relative = this.globalRelative || (extrusion && this.extruderRelative);
    return relative ? current + converted : origin + converted;
  }

  private scaledAxisWord(value: number): number {
    return this.unitsToMm === 1 ? value : Math.fround(value * Math.fround(this.unitsToMm));
  }

  private roleIndex(role: string, source: SourceLocation): number {
    const existing = this.roleIndices.get(role);
    if (existing !== undefined) return existing;
    if (this.roles.length >= this.limits.roles) {
      this.warn(
        'role-table-cap',
        `Role table reached the hard limit of ${this.limits.roles}; "${role}" maps to Undefined`,
        source,
      );
      return 0;
    }
    const index = this.roles.length;
    this.roles.push(role);
    this.roleIndices.set(role, index);
    return index;
  }

  private ensureToolFilament(tool: number, source: SourceLocation): number {
    const existing = this.toolFilaments.get(tool);
    if (existing !== undefined) return existing;
    const filament = this.createFilament(tool, 'tool', this.filamentColors[tool], source);
    this.toolFilaments.set(tool, filament);
    return filament;
  }

  private createFilament(
    tool: number,
    sourceType: GcodeFilamentIdentity['source'],
    color: string | undefined,
    source: SourceLocation,
  ): number {
    if (this.filaments.length >= this.limits.filaments) {
      this.warn(
        'filament-table-cap',
        `Filament identity table reached the hard limit of ${this.limits.filaments}`,
        source,
      );
      return this.toolFilaments.get(tool) ?? 0;
    }
    const id = this.filaments.length;
    this.filaments.push({
      id,
      tool,
      source: sourceType,
      ...(color ? { color } : {}),
    });
    return id;
  }

  private filamentDiameter(tool: number): number {
    return this.filamentDiameters[tool] ?? this.filamentDiameters.at(-1) ?? DEFAULT_FILAMENT_DIAMETER_MM;
  }

  private warn(
    code: string,
    message: string,
    source: SourceLocation,
    severity: GcodeParseWarning['severity'] = 'warning',
  ): void {
    this.warnings.add({
      severity,
      code,
      message,
      line: source.line,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
    });
  }

  private stop(
    reason: GcodeTerminationReason,
    code: string,
    message: string,
    source: SourceLocation,
    severity: GcodeParseWarning['severity'] = 'warning',
  ): void {
    if (this.terminationReason === undefined || this.terminationReason === 'input-cap') {
      this.terminationReason = reason;
    }
    this.warn(code, message, source, severity);
  }

  private shouldStopImmediately(): boolean {
    return (
      this.terminationReason === 'line-cap' ||
      this.terminationReason === 'record-cap' ||
      this.terminationReason === 'path-point-cap' ||
      this.terminationReason === 'numeric-cap'
    );
  }
}

interface ArcInterpolationPlan {
  readonly count: number;
  readonly radianStep: number;
  readonly zStep: number;
}

/** Exact branch structure from pinned `ArcSegment::calc_arc_radian`. */
function calculateArcRadians(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  centerX: number,
  centerY: number,
  isCounterClockwise: boolean,
): number {
  const startDeltaX = Math.fround(centerX - startX);
  const startDeltaY = Math.fround(centerY - startY);
  const endDeltaX = Math.fround(centerX - endX);
  const endDeltaY = Math.fround(centerY - endY);
  if (
    float32VectorLength(Math.fround(startDeltaX - endDeltaX), Math.fround(startDeltaY - endDeltaY)) <
    FULL_CIRCLE_POSITION_EPSILON_MM
  ) {
    return Math.fround(2 * Math.PI);
  }
  // Eigen computes the dot in float before widening it; the pinned cross
  // explicitly widens each float operand to double before multiplication.
  const dot = Math.fround(Math.fround(startDeltaX * endDeltaX) + Math.fround(startDeltaY * endDeltaY));
  const cross = startDeltaX * endDeltaY - startDeltaY * endDeltaX;
  const radians = Math.fround(Math.atan2(cross, dot));
  if (isCounterClockwise) return Math.fround(radians < 0 ? 2 * Math.PI + radians : radians);
  return Math.fround(radians < 0 ? Math.abs(radians) : 2 * Math.PI - radians);
}

/**
 * Pinned interpolation uses `floor(angle / chordStep)` and deliberately may
 * include the exact endpoint in its intermediate vector.
 */
function planArcInterpolation(radius: number, angle: number, deltaZ: number): ArcInterpolationPlan | undefined {
  if (radius <= DRAW_ARC_TOLERANCE_MM) return { count: 0, radianStep: 0, zStep: deltaZ };
  const chordRatio = Math.fround(Math.fround(radius - DRAW_ARC_TOLERANCE_MM) / radius);
  const radianStep = Math.fround(2 * Math.fround(Math.acos(chordRatio)));
  if (!Number.isFinite(radianStep) || radianStep <= 0) return undefined;
  const interpolationRatio = Math.fround(angle / radianStep);
  if (!Number.isFinite(interpolationRatio) || interpolationRatio < 0) return undefined;
  const count = Math.floor(interpolationRatio);
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  const zStep = Math.fround(interpolationRatio < 1 ? deltaZ : Math.fround(deltaZ / interpolationRatio));
  if (!Number.isFinite(zStep)) return undefined;
  return { count, radianStep, zStep };
}

function buildArcInterpolationPoints(
  plan: ArcInterpolationPlan,
  startX: number,
  startY: number,
  startZ: number,
  centerX: number,
  centerY: number,
  isCounterClockwise: boolean,
): ArcInterpolationPoints | undefined {
  const x = new Float32Array(plan.count);
  const y = new Float32Array(plan.count);
  const z = new Float32Array(plan.count);
  const deltaX = Math.fround(startX - centerX);
  const deltaY = Math.fround(startY - centerY);
  const signedStep = Math.fround(isCounterClockwise ? plan.radianStep : -plan.radianStep);
  for (let index = 0; index < plan.count; index += 1) {
    const radians = Math.fround((index + 1) * signedStep);
    const cosine = Math.fround(Math.cos(radians));
    const sine = Math.fround(Math.sin(radians));
    const pointX = Math.fround(Math.fround(centerX + Math.fround(deltaX * cosine)) - Math.fround(deltaY * sine));
    const pointY = Math.fround(Math.fround(centerY + Math.fround(deltaX * sine)) + Math.fround(deltaY * cosine));
    const pointZ = Math.fround(startZ + Math.fround((index + 1) * plan.zStep));
    if (![pointX, pointY, pointZ].every(isFiniteFloat32)) return undefined;
    x[index] = pointX;
    y[index] = pointY;
    z[index] = pointZ;
  }
  return { count: plan.count, x, y, z };
}

function float32VectorLength(x: number, y: number): number {
  return Math.fround(Math.sqrt(Math.fround(Math.fround(x * x) + Math.fround(y * y))));
}

function isFiniteFloat32(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function recordHasFiniteFloat32Values(record: RecordValue): boolean {
  return [
    record.startX,
    record.startY,
    record.startZ,
    record.endX,
    record.endY,
    record.endZ,
    record.deltaE,
    record.feedrateMmPerSecond,
    record.widthMm,
    record.heightMm,
    record.mm3PerMm,
    record.volumetricFlowMm3PerSecond,
    record.fanPercent,
    record.hotendTemperatureC,
    record.arcCenterX ?? 0,
    record.arcCenterY ?? 0,
  ].every(isFiniteFloat32);
}

function classifyMove(wiping: boolean, dx: number, dy: number, dz: number, de: number): GcodeRecordKind {
  if (wiping) return GCODE_RECORD_KIND.WIPE;
  const spatial = dx !== 0 || dy !== 0 || dz !== 0;
  if (de < 0) return spatial ? GCODE_RECORD_KIND.TRAVEL : GCODE_RECORD_KIND.RETRACT;
  if (de > 0) {
    if (dx === 0 && dy === 0) return dz === 0 ? GCODE_RECORD_KIND.UNRETRACT : GCODE_RECORD_KIND.TRAVEL;
    return GCODE_RECORD_KIND.EXTRUDE;
  }
  return spatial ? GCODE_RECORD_KIND.TRAVEL : GCODE_RECORD_KIND.NOOP;
}

function estimateWidth(
  role: string,
  filamentDiameter: number,
  deltaE: number,
  distance: number,
  height: number,
): number {
  if (distance <= 0 || deltaE <= 0 || height <= 0) return DEFAULT_TOOLPATH_WIDTH_MM;
  const radius = filamentDiameter * 0.5;
  let width: number;
  if (role === 'Outer wall') {
    width = (deltaE * Math.PI * (1.05 * radius) ** 2) / (distance * height);
  } else if (role === 'Bridge' || role === 'Internal Bridge' || role === 'Undefined') {
    width = filamentDiameter * Math.sqrt(deltaE / distance);
  } else {
    width = (deltaE * Math.PI * radius ** 2) / (distance * height) + (1 - 0.25 * Math.PI) * height;
  }
  if (!Number.isFinite(width) || width === 0) width = DEFAULT_TOOLPATH_WIDTH_MM;
  return Math.min(width, Math.max(2, 4 * height));
}

/** Float-assignment order from pinned G2/G3 width calculation. */
function estimateArcWidth(
  role: string,
  filamentDiameter: number,
  filamentRadius: number,
  deltaE: number,
  distance: number,
  height: number,
  forcedWidth: number,
): number {
  let width: number;
  if (forcedWidth > 0) {
    width = forcedWidth;
  } else if (deltaE <= 0 || distance <= 0 || height <= 0) {
    // Upstream classifies any nonzero arc E as extrusion, but its negative-E
    // bridge formula can become NaN. The bounded web model keeps the semantic
    // kind while using the same finite fallback as a zero-width result.
    width = Math.fround(DEFAULT_TOOLPATH_WIDTH_MM);
  } else if (role === 'Outer wall') {
    const scaledRadius = Math.fround(Math.fround(1.05) * filamentRadius);
    const crossSection = Math.fround(Math.PI * Math.fround(scaledRadius * scaledRadius));
    const denominator = Math.fround(distance * height);
    width = Math.fround((deltaE * crossSection) / denominator);
  } else if (role === 'Bridge' || role === 'Internal Bridge' || role === 'Undefined') {
    width = Math.fround(filamentDiameter * Math.sqrt(deltaE / distance));
  } else {
    const crossSection = Math.fround(Math.PI * Math.fround(filamentRadius * filamentRadius));
    const denominator = Math.fround(distance * height);
    const rectangularWidth = (deltaE * crossSection) / denominator;
    const semicircleWidth = Math.fround(Math.fround(1 - 0.25 * Math.PI) * height);
    width = Math.fround(rectangularWidth + semicircleWidth);
  }

  if (Number.isNaN(width) || width === 0) width = Math.fround(DEFAULT_TOOLPATH_WIDTH_MM);
  const maximum = Math.max(Math.fround(2), Math.fround(4 * height));
  return Math.fround(Math.min(width, maximum));
}

function prefixedValue(comment: string, prefixes: readonly string[]): string | undefined {
  for (const prefix of prefixes) {
    if (comment.startsWith(prefix)) return comment.slice(prefix.length);
  }
  return undefined;
}

function strictFiniteNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCommand(
  line: string,
  source: SourceLocation,
  warn: (code: string, message: string) => void,
): ParsedCommand | undefined {
  const commentStart = line.indexOf(';');
  const parenthesisStart = line.indexOf('(');
  let end = line.length;
  if (commentStart >= 0) end = Math.min(end, commentStart);
  if (parenthesisStart >= 0) end = Math.min(end, parenthesisStart);
  let cursor = skipWhitespace(line, 0, end);
  if (cursor >= end) return undefined;
  if (source.line === 1 && line.charCodeAt(cursor) === 0xfeff) cursor = skipWhitespace(line, cursor + 1, end);

  let commandLineNumber = -1;
  if (line[cursor]?.toUpperCase() === 'N') {
    const numbered = scanNumber(line, cursor + 1, end);
    if (
      !numbered.valid ||
      !Number.isSafeInteger(numbered.value) ||
      numbered.value < 0 ||
      numbered.value > MAX_COMMAND_LINE_NUMBER
    ) {
      warn('invalid-command-line-number', 'Invalid N-word source line number');
      return undefined;
    }
    commandLineNumber = numbered.value;
    cursor = skipWhitespace(line, numbered.end, end);
  }

  const letter = line[cursor]?.toUpperCase();
  if (!letter || letter < 'A' || letter > 'Z') {
    warn('invalid-command', 'Source line does not begin with a valid G-code command');
    return undefined;
  }
  const commandNumber = scanNumber(line, cursor + 1, end);
  if (!commandNumber.valid || !Number.isSafeInteger(commandNumber.value) || commandNumber.value < 0) {
    warn('invalid-command', `Command ${letter} has an invalid numeric code`);
    return undefined;
  }
  const commandToken = line.slice(cursor, commandNumber.end).toUpperCase();
  const commandDelimiter = line.charCodeAt(commandNumber.end);
  const exactArcSpelling =
    letter === 'G' &&
    (commandToken === 'G2' || commandToken === 'G3') &&
    (commandNumber.end >= end || commandDelimiter === 32 || commandDelimiter === 9);
  cursor = commandNumber.end;

  const parameters = new Map<string, number>();
  const invalidParameters = new Set<string>();
  while (cursor < end) {
    cursor = skipWhitespace(line, cursor, end);
    if (cursor >= end || line[cursor] === '*') break;
    const parameter = line[cursor].toUpperCase();
    if (parameter < 'A' || parameter > 'Z') {
      warn('malformed-token', `Unexpected token "${line[cursor]}" in ${letter}${commandNumber.value}`);
      cursor += 1;
      continue;
    }
    const number = scanNumber(line, cursor + 1, end);
    if (!number.valid) {
      if (number.outOfRange) {
        invalidParameters.add(parameter);
        parameters.delete(parameter);
        warn(
          'invalid-parameter',
          `Parameter ${parameter} in ${letter}${commandNumber.value} is outside the finite numeric domain`,
        );
        cursor = number.end;
        continue;
      }
      warn(
        'invalid-parameter',
        `Parameter ${parameter} in ${letter}${commandNumber.value} has no finite numeric value`,
      );
      cursor = skipMalformedWord(line, cursor + 1, end);
      continue;
    }
    if (parameters.has(parameter)) {
      warn('duplicate-parameter', `Parameter ${parameter} is duplicated; the final value is used`);
    }
    const value = Math.fround(number.value);
    if (!Number.isFinite(value)) {
      invalidParameters.add(parameter);
      parameters.delete(parameter);
      warn(
        'invalid-parameter',
        `Parameter ${parameter} in ${letter}${commandNumber.value} is outside the finite Float32 domain`,
      );
      cursor = number.end;
      continue;
    }
    invalidParameters.delete(parameter);
    parameters.set(parameter, value);
    cursor = number.end;
  }
  return { letter, code: commandNumber.value, exactArcSpelling, parameters, invalidParameters, commandLineNumber };
}

function scanNumber(line: string, start: number, end: number): NumberScan {
  let cursor = start;
  if (cursor < end && (line[cursor] === '+' || line[cursor] === '-')) cursor += 1;
  let digits = 0;
  while (cursor < end && isDigit(line.charCodeAt(cursor))) {
    cursor += 1;
    digits += 1;
  }
  if (cursor < end && line[cursor] === '.') {
    cursor += 1;
    while (cursor < end && isDigit(line.charCodeAt(cursor))) {
      cursor += 1;
      digits += 1;
    }
  }
  if (digits > 0 && cursor + 1 < end && (line[cursor] === 'e' || line[cursor] === 'E')) {
    let exponentEnd = cursor + 1;
    if (line[exponentEnd] === '+' || line[exponentEnd] === '-') exponentEnd += 1;
    let exponentDigits = 0;
    while (exponentEnd < end && isDigit(line.charCodeAt(exponentEnd))) {
      exponentEnd += 1;
      exponentDigits += 1;
    }
    if (exponentDigits > 0) cursor = exponentEnd;
  }
  if (digits === 0) return { valid: false, outOfRange: false, value: Number.NaN, end: start };
  const value = Number(line.slice(start, cursor));
  const valid = Number.isFinite(value);
  return { valid, outOfRange: !valid, value, end: cursor };
}

function skipWhitespace(line: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    const code = line.charCodeAt(cursor);
    if (code !== 32 && code !== 9) break;
    cursor += 1;
  }
  return cursor;
}

function skipMalformedWord(line: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    const code = line.charCodeAt(cursor);
    if (code === 32 || code === 9 || line[cursor] === '*' || line[cursor] === ';' || line[cursor] === '(') break;
    cursor += 1;
  }
  return cursor;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function normalizeFilamentDiameters(values: readonly number[] | undefined): readonly number[] {
  if (!values || values.length === 0) return [DEFAULT_FILAMENT_DIAMETER_MM];
  if (values.length > MAX_TOOL_IDENTITIES) {
    throw new RangeError(`At most ${MAX_TOOL_IDENTITIES} filament diameters may be supplied`);
  }
  return values.map((value, index) => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Filament diameter ${index} must be a finite positive number`);
    }
    return value;
  });
}

function normalizeFilamentColors(values: readonly string[] | undefined): readonly string[] {
  if (!values) return [];
  if (values.length > MAX_TOOL_IDENTITIES) {
    throw new RangeError(`At most ${MAX_TOOL_IDENTITIES} filament colors may be supplied`);
  }
  return [...values];
}

function resolveLimits(requested: Partial<RichGcodeLimits> | undefined): RichGcodeLimits {
  const limit = (key: keyof RichGcodeLimits): number => {
    const value = requested?.[key] ?? RICH_GCODE_HARD_CAPS[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`G-code ${key} limit must be a positive safe integer`);
    }
    return Math.min(value, RICH_GCODE_HARD_CAPS[key]);
  };
  return Object.freeze({
    inputCharacters: limit('inputCharacters'),
    lines: limit('lines'),
    records: limit('records'),
    pathPoints: limit('pathPoints'),
    warnings: limit('warnings'),
    lineCharacters: limit('lineCharacters'),
    roles: limit('roles'),
    filaments: limit('filaments'),
  });
}

function wholeInputLocation(): SourceLocation {
  return {
    line: 0,
    startOffset: 0,
    endOffset: 0,
    commandLineNumber: -1,
  };
}

class WarningCollector {
  private readonly warnings: GcodeParseWarning[] = [];
  private suppressed = false;

  constructor(private readonly limit: number) {}

  add(warning: GcodeParseWarning): void {
    if (this.suppressed) return;
    if (this.warnings.length < this.limit) {
      this.warnings.push(Object.freeze({ ...warning }));
      return;
    }
    this.suppressed = true;
    this.warnings[this.limit - 1] = Object.freeze({
      severity: 'warning',
      code: 'warning-cap',
      message: `Additional parser warnings were suppressed after reaching the hard limit of ${this.limit}`,
      line: warning.line,
      startOffset: warning.startOffset,
      endOffset: warning.endOffset,
    });
  }

  finish(): readonly GcodeParseWarning[] {
    return Object.freeze([...this.warnings]);
  }
}

class RecordColumnsBuilder {
  private capacity: number;
  private length = 0;
  private kind: Uint8Array;
  private startX: Float32Array;
  private startY: Float32Array;
  private startZ: Float32Array;
  private endX: Float32Array;
  private endY: Float32Array;
  private endZ: Float32Array;
  private deltaE: Float32Array;
  private feedrate: Float32Array;
  private width: Float32Array;
  private height: Float32Array;
  private mm3PerMm: Float32Array;
  private volumetricFlow: Float32Array;
  private fan: Float32Array;
  private temperature: Float32Array;
  private layer: Uint32Array;
  private role: Uint16Array;
  private tool: Uint16Array;
  private filament: Uint16Array;
  private sourceLine: Uint32Array;
  private sourceStart: Uint32Array;
  private sourceEnd: Uint32Array;
  private commandLine: Int32Array;
  private pathKind: Uint8Array;
  private pathPointOffset: Uint32Array;
  private pathPointCount: Uint32Array;
  private arcCenterX: Float32Array;
  private arcCenterY: Float32Array;
  private readonly pathPoints: PathPointsBuilder;

  constructor(
    private readonly maximum: number,
    maximumPathPoints: number,
  ) {
    this.capacity = Math.min(1_024, maximum);
    this.kind = new Uint8Array(this.capacity);
    this.startX = new Float32Array(this.capacity);
    this.startY = new Float32Array(this.capacity);
    this.startZ = new Float32Array(this.capacity);
    this.endX = new Float32Array(this.capacity);
    this.endY = new Float32Array(this.capacity);
    this.endZ = new Float32Array(this.capacity);
    this.deltaE = new Float32Array(this.capacity);
    this.feedrate = new Float32Array(this.capacity);
    this.width = new Float32Array(this.capacity);
    this.height = new Float32Array(this.capacity);
    this.mm3PerMm = new Float32Array(this.capacity);
    this.volumetricFlow = new Float32Array(this.capacity);
    this.fan = new Float32Array(this.capacity);
    this.temperature = new Float32Array(this.capacity);
    this.layer = new Uint32Array(this.capacity);
    this.role = new Uint16Array(this.capacity);
    this.tool = new Uint16Array(this.capacity);
    this.filament = new Uint16Array(this.capacity);
    this.sourceLine = new Uint32Array(this.capacity);
    this.sourceStart = new Uint32Array(this.capacity);
    this.sourceEnd = new Uint32Array(this.capacity);
    this.commandLine = new Int32Array(this.capacity);
    this.commandLine.fill(-1);
    this.pathKind = new Uint8Array(this.capacity);
    this.pathPointOffset = new Uint32Array(this.capacity);
    this.pathPointCount = new Uint32Array(this.capacity);
    this.arcCenterX = new Float32Array(this.capacity);
    this.arcCenterY = new Float32Array(this.capacity);
    this.pathPoints = new PathPointsBuilder(maximumPathPoints);
  }

  get count(): number {
    return this.length;
  }

  get remainingRecords(): number {
    return this.maximum - this.length;
  }

  get remainingPathPoints(): number {
    return this.pathPoints.remaining;
  }

  append(value: RecordValue): 'ok' | 'record-cap' | 'path-point-cap' {
    if (this.length >= this.maximum) return 'record-cap';
    const pathCount = value.pathPoints?.count ?? 0;
    if (pathCount > this.pathPoints.remaining) return 'path-point-cap';
    if (value.pathKind === GCODE_PATH_KIND.DIRECT && pathCount !== 0) {
      throw new Error('A direct G-code record cannot own arc interpolation points');
    }
    if (
      value.pathPoints &&
      (value.pathPoints.x.length !== pathCount ||
        value.pathPoints.y.length !== pathCount ||
        value.pathPoints.z.length !== pathCount)
    ) {
      throw new Error('Arc interpolation point columns must have equal declared lengths');
    }
    if (this.length === this.capacity) this.grow();
    const index = this.length;
    const pathOffset = this.pathPoints.count;
    if (value.pathPoints) this.pathPoints.append(value.pathPoints);
    this.kind[index] = value.kind;
    this.startX[index] = value.startX;
    this.startY[index] = value.startY;
    this.startZ[index] = value.startZ;
    this.endX[index] = value.endX;
    this.endY[index] = value.endY;
    this.endZ[index] = value.endZ;
    this.deltaE[index] = value.deltaE;
    this.feedrate[index] = value.feedrateMmPerSecond;
    this.width[index] = value.widthMm;
    this.height[index] = value.heightMm;
    this.mm3PerMm[index] = value.mm3PerMm;
    this.volumetricFlow[index] = value.volumetricFlowMm3PerSecond;
    this.fan[index] = value.fanPercent;
    this.temperature[index] = value.hotendTemperatureC;
    this.layer[index] = value.layer;
    this.role[index] = value.role;
    this.tool[index] = value.tool;
    this.filament[index] = value.filament;
    this.sourceLine[index] = value.source.line;
    this.sourceStart[index] = value.source.startOffset;
    this.sourceEnd[index] = value.source.endOffset;
    this.commandLine[index] = value.source.commandLineNumber;
    this.pathKind[index] = value.pathKind;
    this.pathPointOffset[index] = pathOffset;
    this.pathPointCount[index] = pathCount;
    this.arcCenterX[index] = value.arcCenterX ?? 0;
    this.arcCenterY[index] = value.arcCenterY ?? 0;
    this.length += 1;
    return 'ok';
  }

  finish(): { readonly columns: RichGcodeColumns; readonly pathPoints: RichGcodePathPoints } {
    const length = this.length;
    return {
      columns: {
        count: length,
        kind: this.kind.subarray(0, length),
        startX: this.startX.subarray(0, length),
        startY: this.startY.subarray(0, length),
        startZ: this.startZ.subarray(0, length),
        endX: this.endX.subarray(0, length),
        endY: this.endY.subarray(0, length),
        endZ: this.endZ.subarray(0, length),
        deltaE: this.deltaE.subarray(0, length),
        feedrateMmPerSecond: this.feedrate.subarray(0, length),
        widthMm: this.width.subarray(0, length),
        heightMm: this.height.subarray(0, length),
        mm3PerMm: this.mm3PerMm.subarray(0, length),
        volumetricFlowMm3PerSecond: this.volumetricFlow.subarray(0, length),
        fanPercent: this.fan.subarray(0, length),
        hotendTemperatureC: this.temperature.subarray(0, length),
        layer: this.layer.subarray(0, length),
        role: this.role.subarray(0, length),
        tool: this.tool.subarray(0, length),
        filament: this.filament.subarray(0, length),
        sourceLine: this.sourceLine.subarray(0, length),
        sourceStartOffset: this.sourceStart.subarray(0, length),
        sourceEndOffset: this.sourceEnd.subarray(0, length),
        commandLineNumber: this.commandLine.subarray(0, length),
        pathKind: this.pathKind.subarray(0, length),
        pathPointOffset: this.pathPointOffset.subarray(0, length),
        pathPointCount: this.pathPointCount.subarray(0, length),
        arcCenterX: this.arcCenterX.subarray(0, length),
        arcCenterY: this.arcCenterY.subarray(0, length),
      },
      pathPoints: this.pathPoints.finish(),
    };
  }

  private grow(): void {
    const next = Math.min(this.maximum, Math.max(this.capacity + 1, this.capacity * 2));
    this.kind = growTyped(this.kind, next);
    this.startX = growTyped(this.startX, next);
    this.startY = growTyped(this.startY, next);
    this.startZ = growTyped(this.startZ, next);
    this.endX = growTyped(this.endX, next);
    this.endY = growTyped(this.endY, next);
    this.endZ = growTyped(this.endZ, next);
    this.deltaE = growTyped(this.deltaE, next);
    this.feedrate = growTyped(this.feedrate, next);
    this.width = growTyped(this.width, next);
    this.height = growTyped(this.height, next);
    this.mm3PerMm = growTyped(this.mm3PerMm, next);
    this.volumetricFlow = growTyped(this.volumetricFlow, next);
    this.fan = growTyped(this.fan, next);
    this.temperature = growTyped(this.temperature, next);
    this.layer = growTyped(this.layer, next);
    this.role = growTyped(this.role, next);
    this.tool = growTyped(this.tool, next);
    this.filament = growTyped(this.filament, next);
    this.sourceLine = growTyped(this.sourceLine, next);
    this.sourceStart = growTyped(this.sourceStart, next);
    this.sourceEnd = growTyped(this.sourceEnd, next);
    this.pathKind = growTyped(this.pathKind, next);
    this.pathPointOffset = growTyped(this.pathPointOffset, next);
    this.pathPointCount = growTyped(this.pathPointCount, next);
    this.arcCenterX = growTyped(this.arcCenterX, next);
    this.arcCenterY = growTyped(this.arcCenterY, next);
    const commandLine = new Int32Array(next);
    commandLine.fill(-1);
    commandLine.set(this.commandLine);
    this.commandLine = commandLine;
    this.capacity = next;
  }
}

class PathPointsBuilder {
  private capacity: number;
  private length = 0;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;

  constructor(private readonly maximum: number) {
    this.capacity = Math.min(1_024, maximum);
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.z = new Float32Array(this.capacity);
  }

  get count(): number {
    return this.length;
  }

  get remaining(): number {
    return this.maximum - this.length;
  }

  append(points: ArcInterpolationPoints): void {
    const nextLength = this.length + points.count;
    if (nextLength > this.maximum) throw new Error('Arc interpolation points exceed their preflighted limit');
    this.ensureCapacity(nextLength);
    this.x.set(points.x, this.length);
    this.y.set(points.y, this.length);
    this.z.set(points.z, this.length);
    this.length = nextLength;
  }

  finish(): RichGcodePathPoints {
    return {
      count: this.length,
      x: this.x.subarray(0, this.length),
      y: this.y.subarray(0, this.length),
      z: this.z.subarray(0, this.length),
    };
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    let next = this.capacity;
    while (next < required) next = Math.min(this.maximum, Math.max(next + 1, next * 2));
    this.x = growTyped(this.x, next);
    this.y = growTyped(this.y, next);
    this.z = growTyped(this.z, next);
    this.capacity = next;
  }
}

type GrowableTypedArray = Uint8Array | Uint16Array | Uint32Array | Float32Array;

function growTyped<T extends GrowableTypedArray>(current: T, length: number): T {
  const Constructor = current.constructor as { new (length: number): T };
  const grown = new Constructor(length);
  grown.set(current);
  return grown;
}
