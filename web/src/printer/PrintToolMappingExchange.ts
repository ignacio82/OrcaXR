/**
 * Tool usage, filament slots and tool mapping over the hosts' shared contract
 * (`PrintToolMapping.ts`, `MoonrakerFilamentSlots.ts`). Every answer comes
 * from the production functions; the Rust core answers the same requests
 * (`orcaxr_printer::tools`), scanning an artifact's bytes as they arrive.
 */
import type {
  ProjectFilamentSlotsReplyWire,
  ProjectGcodeToolUsageWire,
  ProjectMoonrakerFilamentSlotWire,
  ProjectToolMappingNoticeWire,
  ProjectToolMappingReportWire,
  ProjectToolMappingRequestWire,
} from '../../../contracts/generated/project-intents';
import { parseMoonrakerFilamentSlots, type MoonrakerFilamentSlot } from './MoonrakerFilamentSlots';
import { MoonrakerTransportError } from './MoonrakerTypes';
import {
  summarizeGcodeToolUsage,
  validateToolMapping,
  type GcodeToolUsage,
  type ToolMappingNotice,
} from './PrintToolMapping';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const fromUnits = (value: readonly number[]): string => String.fromCharCode(...value);

const NOTICES = {
  'missing-slot': 'missingSlot',
  'material-mismatch': 'materialMismatch',
  'color-mismatch': 'colorMismatch',
  'slots-unknown': 'slotsUnknown',
} as const satisfies Record<ToolMappingNotice['code'], string>;

export function toolUsageWire(usage: GcodeToolUsage): ProjectGcodeToolUsageWire {
  return {
    tools: [...usage.tools],
    multiMaterial: usage.multiMaterial,
    declaredColors: usage.declaredColors.map(units),
    declaredMaterials: usage.declaredMaterials.map(units),
  };
}
function toolUsageFromWire(wire: ProjectGcodeToolUsageWire): GcodeToolUsage {
  return {
    tools: [...wire.tools],
    multiMaterial: wire.multiMaterial,
    declaredColors: wire.declaredColors.map(fromUnits),
    declaredMaterials: wire.declaredMaterials.map(fromUnits),
  };
}
function slotWire(slot: MoonrakerFilamentSlot): ProjectMoonrakerFilamentSlotWire {
  return {
    slotIndex: slot.slotIndex,
    colorHex: units(slot.colorHex),
    material: units(slot.material),
    subType: slot.subType === undefined ? absent : { value: units(slot.subType) },
    vendor: units(slot.vendor),
  };
}
function slotFromWire(wire: ProjectMoonrakerFilamentSlotWire): MoonrakerFilamentSlot {
  return {
    slotIndex: wire.slotIndex,
    colorHex: fromUnits(wire.colorHex),
    material: fromUnits(wire.material),
    ...('value' in wire.subType ? { subType: fromUnits(wire.subType.value) } : {}),
    vendor: fromUnits(wire.vendor),
  };
}
function noticeWire(notice: ToolMappingNotice): ProjectToolMappingNoticeWire {
  return {
    code: NOTICES[notice.code],
    message: units(notice.message),
    toolIndex: notice.toolIndex === undefined ? absent : { value: notice.toolIndex },
  };
}

/** The usage of an artifact's text, decoded as the browser decodes it. */
export function answerToolUsage(gcode: string): ProjectGcodeToolUsageWire {
  return toolUsageWire(summarizeGcodeToolUsage(gcode));
}

/** The loaded slots a Snapmaker query reply reports, or that it is unusable. */
export function answerFilamentSlots(reply: unknown): ProjectFilamentSlotsReplyWire {
  try {
    return { slots: parseMoonrakerFilamentSlots(reply).map(slotWire) };
  } catch (error) {
    if (error instanceof MoonrakerTransportError && error.code === 'invalid_response') return { invalidResponse: {} };
    throw error;
  }
}

export function answerToolMapping(request: ProjectToolMappingRequestWire): ProjectToolMappingReportWire {
  const report = validateToolMapping(
    toolUsageFromWire(request.usage),
    'value' in request.slots ? request.slots.value.map(slotFromWire) : undefined,
  );
  return { blockers: report.blockers.map(noticeWire), warnings: report.warnings.map(noticeWire) };
}
