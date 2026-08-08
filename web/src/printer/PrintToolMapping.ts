import { normalizeFilamentMaterial, type MoonrakerFilamentSlot } from './MoonrakerFilamentSlots';

/**
 * Tool indices at or above this are slicer sentinels ("no tool"), not slots.
 * Orca emits `T255` when it parks the toolhead between objects.
 */
const MAX_REAL_TOOL_INDEX = 64;

export interface GcodeToolUsage {
  /** Sorted, unique tool indices the artifact actually selects. */
  readonly tools: readonly number[];
  readonly multiMaterial: boolean;
  /** Per-tool colour declared in the artifact's config block, when present. */
  readonly declaredColors: readonly string[];
  /** Per-tool material declared in the artifact's config block, when present. */
  readonly declaredMaterials: readonly string[];
}

export interface ToolMappingNotice {
  readonly code: 'missing-slot' | 'material-mismatch' | 'color-mismatch' | 'slots-unknown';
  readonly message: string;
  readonly toolIndex?: number;
}

export interface ToolMappingReport {
  /** Sending would print with the wrong or an absent filament. */
  readonly blockers: readonly ToolMappingNotice[];
  /** Worth confirming, but the printer can run the job. */
  readonly warnings: readonly ToolMappingNotice[];
}

/**
 * Read which tools a sliced artifact uses, plus the per-tool filament facts it
 * declares. Both Full-Spectrum and ordinary multi-material projects resolve to
 * physical tool changes by the time G-code exists, so the emitted `T` commands
 * are the authority on what the printer must have loaded.
 */
export function summarizeGcodeToolUsage(gcode: string): GcodeToolUsage {
  const tools = new Set<number>();
  const toolPattern = /^T(\d+)\b/gm;
  for (let match = toolPattern.exec(gcode); match !== null; match = toolPattern.exec(gcode)) {
    const index = Number.parseInt(match[1], 10);
    if (Number.isInteger(index) && index < MAX_REAL_TOOL_INDEX) tools.add(index);
  }

  const declaredColors = declaredList(gcode, 'filament_colour') ?? declaredList(gcode, 'filament_color') ?? [];
  const declaredMaterials = declaredList(gcode, 'filament_type') ?? [];

  return Object.freeze({
    tools: Object.freeze([...tools].sort((left, right) => left - right)),
    multiMaterial: tools.size > 1,
    declaredColors: Object.freeze(declaredColors),
    declaredMaterials: Object.freeze(declaredMaterials),
  });
}

/**
 * Compare an artifact's tool usage against what the printer reports as loaded.
 *
 * A tool with no corresponding loaded slot blocks the send outright: starting
 * that print would extrude from an empty position. Material and colour
 * differences are reported as warnings, because only the operator knows whether
 * the spool was swapped without the printer noticing.
 */
export function validateToolMapping(
  usage: GcodeToolUsage,
  slots: readonly MoonrakerFilamentSlot[] | undefined,
): ToolMappingReport {
  const blockers: ToolMappingNotice[] = [];
  const warnings: ToolMappingNotice[] = [];

  if (!slots || slots.length === 0) {
    if (usage.multiMaterial) {
      warnings.push({
        code: 'slots-unknown',
        message: `This artifact uses ${usage.tools.length} tools, but the printer did not report its loaded filaments; verify the slots yourself before printing.`,
      });
    }
    return freezeReport(blockers, warnings);
  }

  const bySlot = new Map(slots.map((slot) => [slot.slotIndex, slot]));
  for (const tool of usage.tools) {
    const slot = bySlot.get(tool);
    if (!slot) {
      blockers.push({
        code: 'missing-slot',
        toolIndex: tool,
        message: `The artifact prints with tool T${tool}, but the printer reports no filament loaded in slot ${tool + 1}.`,
      });
      continue;
    }
    const material = usage.declaredMaterials[tool];
    // Both sides collapse to a family first: a slot reported as "PLA" and an
    // artifact sliced for "PLA-CF" are compatible, and warning about that would
    // train the operator to click through real mismatches.
    if (material && slot.material && !sameFamily(material, slot.material)) {
      warnings.push({
        code: 'material-mismatch',
        toolIndex: tool,
        message: `T${tool} was sliced for ${material}, but slot ${tool + 1} holds ${slot.material}.`,
      });
    }
    const color = normalizeColor(usage.declaredColors[tool]);
    const slotColor = normalizeColor(slot.colorHex);
    if (color && slotColor && color !== slotColor) {
      warnings.push({
        code: 'color-mismatch',
        toolIndex: tool,
        message: `T${tool} was sliced as ${color}, but slot ${tool + 1} holds ${slotColor}.`,
      });
    }
  }

  return freezeReport(blockers, warnings);
}

function declaredList(gcode: string, key: string): string[] | null {
  // Orca writes its config block as `; key = a;b;c` at the end of the file.
  const pattern = new RegExp(`^;\\s*${key}\\s*=\\s*(.*)$`, 'm');
  const match = pattern.exec(gcode);
  if (!match) return null;
  return match[1]
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function sameFamily(left: string, right: string): boolean {
  return normalizeFilamentMaterial(left) === normalizeFilamentMaterial(right);
}

function normalizeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) return undefined;
  return `#${hex.slice(0, 6)}`;
}

function freezeReport(blockers: ToolMappingNotice[], warnings: ToolMappingNotice[]): ToolMappingReport {
  return Object.freeze({ blockers: Object.freeze(blockers), warnings: Object.freeze(warnings) });
}
