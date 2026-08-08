/**
 * The totals the engine itself wrote into a finished artifact.
 *
 * These are read, never recomputed: the slicer already accounted for every
 * extrusion, purge, and tool change, so re-deriving them from parsed toolpaths
 * would produce a second, subtly different set of numbers with no way to say
 * which is right. A value the artifact does not state stays absent — a missing
 * weight is not zero grams — and a zero the engine did state is kept as a real
 * zero.
 *
 * This is deliberately not the verified statistics sidecar (P7.6): it carries
 * no per-role breakdown, no cost unit, and no engine-identity binding. It is
 * what the artifact in hand can prove about itself.
 */

export interface GcodeArtifactToolUsage {
  /** 0-based tool index, matching the artifact's own filament order. */
  readonly toolIndex: number;
  readonly lengthMm?: number;
  readonly volumeCm3?: number;
  readonly weightG?: number;
  readonly colorHex?: string;
  readonly material?: string;
}

export interface GcodeArtifactSummary {
  readonly perTool: readonly GcodeArtifactToolUsage[];
  readonly totalWeightG?: number;
  /** The engine's own cost figure; its currency is a profile setting, not a fact of the file. */
  readonly totalCost?: number;
  readonly toolChanges?: number;
  readonly layerCount?: number;
  readonly estimatedSeconds?: number;
  readonly firstLayerSeconds?: number;
  /** True when the artifact stated no totals at all (an engine that omits them). */
  readonly empty: boolean;
}

const EMPTY: GcodeArtifactSummary = Object.freeze({ perTool: Object.freeze([]), empty: true });

/** Scan only the trailer: these totals are written after the toolpaths. */
const TRAILER_SCAN_BYTES = 64 * 1024;

export function summarizeGcodeArtifact(gcode: string): GcodeArtifactSummary {
  const trailer = gcode.length > TRAILER_SCAN_BYTES ? gcode.slice(gcode.length - TRAILER_SCAN_BYTES) : gcode;
  const lengths = numberList(trailer, /^; filament used \[mm\] = (.+)$/m);
  const volumes = numberList(trailer, /^; filament used \[cm3\] = (.+)$/m);
  const weights = numberList(trailer, /^; filament used \[g\] = (.+)$/m);
  const colors = textList(gcode, /^; filament_colour = (.+)$/m);
  const materials = textList(gcode, /^; filament_type = (.+)$/m);

  const toolCount = Math.max(lengths.length, volumes.length, weights.length);
  const perTool: GcodeArtifactToolUsage[] = [];
  for (let toolIndex = 0; toolIndex < toolCount; toolIndex += 1) {
    perTool.push(
      Object.freeze({
        toolIndex,
        ...optional('lengthMm', lengths[toolIndex]),
        ...optional('volumeCm3', volumes[toolIndex]),
        ...optional('weightG', weights[toolIndex]),
        ...optionalText('colorHex', colors[toolIndex]),
        ...optionalText('material', materials[toolIndex]),
      }),
    );
  }

  const summary = {
    perTool: Object.freeze(perTool),
    ...optional('totalWeightG', singleNumber(trailer, /^; total filament used \[g\] = (.+)$/m)),
    ...optional('totalCost', singleNumber(trailer, /^; total filament cost = (.+)$/m)),
    ...optional('toolChanges', singleInteger(trailer, /^; total filament change = (.+)$/m)),
    ...optional('layerCount', singleInteger(trailer, /^; total layers count = (.+)$/m)),
    ...optional('estimatedSeconds', duration(trailer, /^; estimated printing time \(normal mode\) = (.+)$/m)),
    ...optional(
      'firstLayerSeconds',
      duration(trailer, /^; estimated first layer printing time \(normal mode\) = (.+)$/m),
    ),
  };
  const empty = perTool.length === 0 && Object.keys(summary).length === 1;
  return empty ? EMPTY : Object.freeze({ ...summary, empty: false });
}

/** `1h 04m`, `12m 30s`, `45s`, or an em dash when the artifact stated nothing. */
export function formatArtifactDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

/**
 * Parse the engine's own duration wording (`2d 3h 4m 5s`). An unrecognised
 * shape yields nothing rather than a partial number that would read as fact.
 */
function duration(source: string, pattern: RegExp): number | undefined {
  const raw = pattern.exec(source)?.[1].trim();
  // Every token must be a number with a unit; anything else (an engine that
  // writes "unknown", or a shape this code has never seen) is not a duration.
  if (!raw || !/^\d+(?:\.\d+)?\s*[dhms](?:\s+\d+(?:\.\d+)?\s*[dhms])*$/.test(raw)) return undefined;
  const matches = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)];
  const scale: Readonly<Record<string, number>> = { d: 86_400, h: 3600, m: 60, s: 1 };
  let seconds = 0;
  for (const [, value, unit] of matches) seconds += Number(value) * scale[unit];
  return Number.isFinite(seconds) ? seconds : undefined;
}

function numberList(source: string, pattern: RegExp): readonly (number | undefined)[] {
  const raw = pattern.exec(source)?.[1];
  if (raw === undefined) return [];
  return raw.split(',').map((entry) => finite(entry));
}

function textList(source: string, pattern: RegExp): readonly (string | undefined)[] {
  const raw = pattern.exec(source)?.[1];
  if (raw === undefined) return [];
  return raw.split(';').map((entry) => {
    const value = entry.trim();
    return value.length > 0 ? value : undefined;
  });
}

function singleNumber(source: string, pattern: RegExp): number | undefined {
  return finite(pattern.exec(source)?.[1]);
}

function singleInteger(source: string, pattern: RegExp): number | undefined {
  const value = finite(pattern.exec(source)?.[1]);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function finite(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function optional<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, number>);
}

function optionalText<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, string>);
}
