import {
  captureProjectBatch,
  PROJECT_INTENT_MAX_NODES,
  captureProjectIntent,
  type ProjectCommandWire,
} from '../../../contracts/generated/project-intents';
import { InvalidProjectIntent } from '../../../contracts/runtime/project-intents';
import {
  AddPlateCommand,
  DeletePlateCommand,
  DuplicatePlateCommand,
  RenamePlateCommand,
  ReorderPlatesCommand,
  SetActivePlateCommand,
  SetPlatePrintableCommand,
  SetInstanceTransformCommand,
  MoveObjectToPlateCommand,
} from './commands';
import {
  RenameObjectCommand,
  RenameVolumeCommand,
  RenameInstanceCommand,
  SetInstancePrintableCommand,
  DeleteObjectCommand,
  DeletePlateObjectsCommand,
  DeleteInstanceCommand,
  DuplicateObjectCommand,
  ConvertInstanceToIndependentObjectCommand,
} from './objects/commands';
import { SetInstanceTransformsCommand } from './objects/transformCommands';
import {
  AddLayerRangeCommand,
  DeleteLayerRangeCommand,
  EditLayerRangeBoundsCommand,
  MergeLayerRangesCommand,
  SplitLayerRangeCommand,
} from './objects/layerRangeCommands';
import {
  AddLayerEventCommand,
  DeleteLayerEventCommand,
  EditLayerEventCommand,
  type LayerEventPatch,
} from './layerEventCommands';
import {
  AddBrimEarCommand,
  AddBrimEarsCommand,
  ClearBrimEarsCommand,
  RemoveBrimEarCommand,
} from './objects/brimEarCommands';
import {
  AdaptiveLayerHeightProfileCommand,
  AdjustLayerHeightProfileCommand,
  ResetLayerHeightProfileCommand,
  SmoothLayerHeightProfileCommand,
} from './objects/layerHeightCommands';
import type { LayerHeightLimits, LayerHeightSlicingParameters } from './objects/layerHeightProfile';
import {
  RemapFilamentsCommand,
  SetFilamentAssignmentsCommand,
  SetFilamentEnabledCommand,
  SetLayerRangeFilamentCommand,
  SetObjectFilamentCommand,
  SetVolumeFilamentCommand,
  SyncPhysicalFilamentsFromPrinterCommand,
  type FilamentAssignmentTarget,
} from './filaments/commands';
import {
  AddMixedFilamentCommand,
  DuplicateMixedFilamentCommand,
  EditMixedFilamentCommand,
  RemoveMixedFilamentCommand,
  SetMixedFilamentEnabledCommand,
  TombstoneMixedFilamentCommand,
  type EditMixedFilamentPatch,
} from './filaments/mixedCommands';
import { assertCanonicalSerializable } from './domain/canonical';
import { SetProjectSettingsOverridesCommand } from './settingsOverrides';
import { SetScopedOverridesCommand, type ScopedOverrideTarget } from './scopedOverrides';
import type {
  BrimEarPoint,
  ConfigMap,
  FullSpectrumRecipeState,
  JsonValue,
  LayerEventType,
  MixedComponent,
  MixedDistribution,
  MixedFilament,
  Transform,
} from './domain/model';
import type {
  ProjectScopedTargetWire,
  ProjectSettingsGuardWire,
  ProjectAssignmentTargetWire,
  ProjectFullSpectrumInputWire,
  ProjectMixedComponentInputWire,
  ProjectMixedDistributionInputWire,
  ProjectMixedFilamentInputWire,
  ProjectBrimEarWire,
  ProjectOptionalIdWire,
  ProjectLayerHeightLimitsWire,
  ProjectLayerHeightParametersWire,
  ProjectLayerEventTypeWire,
  ProjectTransformWire,
} from '../../../contracts/generated/project-intents';
import { entityId, isStableEntityId, type EntityId, type FilamentId, type IdSource } from './domain/ids';
import type { ProjectCommand } from './history/command';

/** UTF-16 code units, never code points or lossy UTF-8. */
export function intentText(value: string): number[] {
  return createIntentTextEncoder()(value);
}

/** One encoder per preparation bounds aggregate text allocation before a large
 * duplication/reorder request reaches the complete generated shape validator. */
export function createIntentTextEncoder(): (value: string) => number[] {
  let remaining = PROJECT_INTENT_MAX_NODES;
  return (value) => {
    if (value.length + 1 > remaining) throw new InvalidProjectIntent();
    remaining -= value.length + 1;
    return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
  };
}
function text(units: readonly number[]): string {
  let output = '';
  for (let offset = 0; offset < units.length; offset += 4096) {
    output += String.fromCharCode(...units.slice(offset, offset + 4096));
  }
  return output;
}
function id<K extends string>(units: readonly number[]): EntityId<K> {
  const value = text(units);
  // The public domain helper includes the imported value in its diagnostic;
  // transport validation must never expose it in an error.
  if (!isStableEntityId(value)) throw new InvalidProjectIntent();
  return entityId<K>(value);
}

/** A physical or mixed filament; the brand is only a compile-time kind. */
function filament(units: readonly number[]): FilamentId {
  return id<'physical-filament'>(units);
}

/** The TypeScript authority interprets prepared intents during migration.
 * Capture happens synchronously before queueing, and the existing bus owns all
 * graph validation, atomic rollback, selection and history semantics. */
export function prepareProjectIntent(value: unknown): ProjectCommand {
  return command(captureProjectIntent(value).command);
}
export function prepareProjectBatch(value: unknown): { label: string; commands: readonly ProjectCommand[] } {
  const captured = captureProjectBatch(value);
  const label = text(captured.label);
  if (!label.trim()) throw new InvalidProjectIntent();
  return { label, commands: captured.commands.map(command) };
}
function command(value: ProjectCommandWire): ProjectCommand {
  if ('deleteObject' in value) return new DeleteObjectCommand(id<'object'>(value.deleteObject.objectId));
  if ('deletePlateObjects' in value)
    return new DeletePlateObjectsCommand(id<'plate'>(value.deletePlateObjects.plateId));
  if ('deleteInstance' in value) return new DeleteInstanceCommand(id<'instance'>(value.deleteInstance.instanceId));
  if ('moveObjectToPlate' in value)
    return new MoveObjectToPlateCommand(
      id<'object'>(value.moveObjectToPlate.objectId),
      id<'plate'>(value.moveObjectToPlate.destinationPlateId),
    );
  if ('duplicateObject' in value) {
    const input = value.duplicateObject;
    return new DuplicateObjectCommand(
      id<'object'>(input.sourceObjectId),
      {
        objectId: id<'object'>(input.ids.objectId),
        volumeIds: input.ids.volumeIds.map(id<'volume'>),
        instanceIds: input.ids.instanceIds.map(id<'instance'>),
        layerRangeIds: input.ids.layerRangeIds.map(id<'layer-range'>),
      },
      {
        ...('value' in input.destinationPlateId
          ? { destinationPlateId: id<'plate'>(input.destinationPlateId.value) }
          : {}),
        ...('value' in input.name ? { name: text(input.name.value) } : {}),
      },
    );
  }
  if ('convertInstanceToObject' in value) {
    const input = value.convertInstanceToObject;
    return new ConvertInstanceToIndependentObjectCommand(
      id<'instance'>(input.instanceId),
      {
        objectId: id<'object'>(input.ids.objectId),
        volumeIds: input.ids.volumeIds.map(id<'volume'>),
        instanceId: id<'instance'>(input.ids.instanceId),
        layerRangeIds: input.ids.layerRangeIds.map(id<'layer-range'>),
      },
      'value' in input.name ? text(input.name.value) : undefined,
    );
  }
  // Layer ranges are created empty; settings and filament assignments use
  // their scoped commands.
  if ('addLayerRange' in value) {
    const input = value.addLayerRange;
    return new AddLayerRangeCommand(id<'object'>(input.objectId), {
      id: id<'layer-range'>(input.layerRangeId),
      minZMm: input.minZMm,
      maxZMm: input.maxZMm,
      config: {},
    });
  }
  if ('editLayerRangeBounds' in value) {
    const input = value.editLayerRangeBounds;
    return new EditLayerRangeBoundsCommand(id<'object'>(input.objectId), id<'layer-range'>(input.layerRangeId), {
      ...('value' in input.minZMm ? { minZMm: input.minZMm.value } : {}),
      ...('value' in input.maxZMm ? { maxZMm: input.maxZMm.value } : {}),
    });
  }
  if ('splitLayerRange' in value) {
    const input = value.splitLayerRange;
    return new SplitLayerRangeCommand(
      id<'object'>(input.objectId),
      id<'layer-range'>(input.layerRangeId),
      input.splitZMm,
      id<'layer-range'>(input.upperRangeId),
    );
  }
  if ('mergeLayerRanges' in value) {
    const input = value.mergeLayerRanges;
    return new MergeLayerRangesCommand(
      id<'object'>(input.objectId),
      id<'layer-range'>(input.firstRangeId),
      id<'layer-range'>(input.secondRangeId),
    );
  }
  if ('deleteLayerRange' in value)
    return new DeleteLayerRangeCommand(
      id<'object'>(value.deleteLayerRange.objectId),
      id<'layer-range'>(value.deleteLayerRange.layerRangeId),
    );
  if ('addLayerEvent' in value) {
    const input = value.addLayerEvent;
    return new AddLayerEventCommand({
      id: id<'custom-gcode'>(input.customGcodeId),
      plateId: id<'plate'>(input.plateId),
      type: LAYER_EVENT_TYPES[input.eventType],
      topZMm: input.topZMm,
      ...('value' in input.toolIndex ? { toolIndex: input.toolIndex.value } : {}),
      ...('value' in input.filamentId ? { filamentId: filament(input.filamentId.value) } : {}),
      ...('value' in input.color ? { color: text(input.color.value) } : {}),
      ...('value' in input.message ? { message: text(input.message.value) } : {}),
      ...('value' in input.code ? { code: text(input.code.value) } : {}),
    });
  }
  if ('editLayerEvent' in value) {
    const input = value.editLayerEvent;
    // `keep` leaves a field out of the patch; `clear` names it as undefined,
    // which the command reads as removal.
    const patch: { -readonly [K in keyof LayerEventPatch]: LayerEventPatch[K] } = {};
    if ('value' in input.eventType) patch.type = LAYER_EVENT_TYPES[input.eventType.value];
    if ('value' in input.topZMm) patch.topZMm = input.topZMm.value;
    if (!('keep' in input.toolIndex)) patch.toolIndex = 'value' in input.toolIndex ? input.toolIndex.value : undefined;
    if (!('keep' in input.filamentId))
      patch.filamentId = 'value' in input.filamentId ? filament(input.filamentId.value) : undefined;
    if (!('keep' in input.color)) patch.color = 'value' in input.color ? text(input.color.value) : undefined;
    if (!('keep' in input.message)) patch.message = 'value' in input.message ? text(input.message.value) : undefined;
    if ('value' in input.code) patch.code = text(input.code.value);
    return new EditLayerEventCommand(id<'custom-gcode'>(input.customGcodeId), patch);
  }
  if ('deleteLayerEvent' in value)
    return new DeleteLayerEventCommand(id<'custom-gcode'>(value.deleteLayerEvent.customGcodeId));
  if ('setProjectSettingsOverrides' in value) {
    const input = value.setProjectSettingsOverrides;
    return new SetProjectSettingsOverridesCommand(settingsGuard(input.guard), {
      inheritedConfig: jsonObject(input.inheritedConfigJson),
      overrides: jsonObject(input.overridesJson),
    });
  }
  if ('setScopedOverrides' in value) {
    const input = value.setScopedOverrides;
    return new SetScopedOverridesCommand(
      settingsGuard(input.guard),
      scopedTarget(input.target),
      jsonObject(input.overridesJson),
    );
  }
  if ('addMixedFilament' in value) return new AddMixedFilamentCommand(mixedFilament(value.addMixedFilament.filament));
  if ('editMixedFilament' in value) {
    const input = value.editMixedFilament;
    const patch: { -readonly [K in keyof EditMixedFilamentPatch]: EditMixedFilamentPatch[K] } = {};
    if ('value' in input.name) patch.name = text(input.name.value);
    if ('value' in input.displayColor) patch.displayColor = text(input.displayColor.value);
    if ('value' in input.components) patch.components = input.components.value.map(mixedComponent);
    if ('value' in input.distribution) patch.distribution = mixedDistribution(input.distribution.value);
    if ('value' in input.fullSpectrum) patch.fullSpectrum = fullSpectrum(input.fullSpectrum.value);
    if ('value' in input.configJson) patch.config = jsonObject(input.configJson.value);
    return new EditMixedFilamentCommand(id<'mixed-filament'>(input.mixedFilamentId), patch);
  }
  if ('duplicateMixedFilament' in value) {
    const input = value.duplicateMixedFilament;
    return new DuplicateMixedFilamentCommand(
      id<'mixed-filament'>(input.sourceId),
      id<'mixed-filament'>(input.duplicateId),
      'value' in input.name ? text(input.name.value) : undefined,
    );
  }
  if ('setMixedFilamentEnabled' in value) {
    const input = value.setMixedFilamentEnabled;
    return new SetMixedFilamentEnabledCommand(
      id<'mixed-filament'>(input.mixedFilamentId),
      input.enabled,
      'value' in input.reason ? text(input.reason.value) : undefined,
    );
  }
  if ('tombstoneMixedFilament' in value) {
    const input = value.tombstoneMixedFilament;
    return new TombstoneMixedFilamentCommand(
      id<'mixed-filament'>(input.mixedFilamentId),
      'value' in input.reason ? text(input.reason.value) : undefined,
    );
  }
  if ('removeMixedFilament' in value)
    return new RemoveMixedFilamentCommand(id<'mixed-filament'>(value.removeMixedFilament.mixedFilamentId));
  if ('setFilamentAssignments' in value)
    return new SetFilamentAssignmentsCommand(
      value.setFilamentAssignments.assignments.map((assignment) => ({
        target: assignmentTarget(assignment.target),
        filamentId: optionalFilament(assignment.filamentId),
      })),
    );
  if ('setObjectFilament' in value)
    return new SetObjectFilamentCommand(
      id<'object'>(value.setObjectFilament.objectId),
      optionalFilament(value.setObjectFilament.filamentId),
    );
  if ('setVolumeFilament' in value) {
    const input = value.setVolumeFilament;
    return new SetVolumeFilamentCommand(
      id<'object'>(input.objectId),
      id<'volume'>(input.volumeId),
      optionalFilament(input.filamentId),
    );
  }
  if ('setLayerRangeFilament' in value) {
    const input = value.setLayerRangeFilament;
    return new SetLayerRangeFilamentCommand(
      id<'object'>(input.objectId),
      id<'layer-range'>(input.layerRangeId),
      optionalFilament(input.filamentId),
    );
  }
  if ('remapFilaments' in value)
    return new RemapFilamentsCommand(
      value.remapFilaments.sourceIds.map(filament),
      filament(value.remapFilaments.destinationId),
    );
  if ('setFilamentEnabled' in value) {
    const input = value.setFilamentEnabled;
    return new SetFilamentEnabledCommand(
      filament(input.filamentId),
      input.enabled,
      'value' in input.reason ? text(input.reason.value) : undefined,
    );
  }
  if ('syncPhysicalFilaments' in value) {
    const input = value.syncPhysicalFilaments;
    const slots = input.slots.map((slot) => ({
      toolId: slot.toolId,
      color: text(slot.color),
      material: text(slot.material),
      ...('value' in slot.subType ? { subType: text(slot.subType.value) } : {}),
      ...('value' in slot.vendor ? { vendor: text(slot.vendor.value) } : {}),
    }));
    return new SyncPhysicalFilamentsFromPrinterCommand(
      slots,
      'value' in input.newFilamentIds ? listedIds(input.newFilamentIds.value.map(id<'physical-filament'>)) : undefined,
    );
  }
  if ('adjustLayerHeightProfile' in value) {
    const input = value.adjustLayerHeightProfile;
    return new AdjustLayerHeightProfileCommand(id<'object'>(input.objectId), layerHeightParameters(input.parameters), {
      zMm: input.zMm,
      thicknessDeltaMm: input.thicknessDeltaMm,
      bandWidthMm: input.bandWidthMm,
      action: input.action,
    });
  }
  if ('smoothLayerHeightProfile' in value) {
    const input = value.smoothLayerHeightProfile;
    return new SmoothLayerHeightProfileCommand(id<'object'>(input.objectId), layerHeightParameters(input.parameters), {
      radius: input.radius,
      keepMin: input.keepMin,
    });
  }
  if ('adaptiveLayerHeightProfile' in value) {
    const input = value.adaptiveLayerHeightProfile;
    return new AdaptiveLayerHeightProfileCommand(
      id<'object'>(input.objectId),
      layerHeightLimits(input.limits),
      input.qualityFactor,
    );
  }
  if ('resetLayerHeightProfile' in value)
    return new ResetLayerHeightProfileCommand(id<'object'>(value.resetLayerHeightProfile.objectId));
  if ('addBrimEar' in value)
    return new AddBrimEarCommand(id<'object'>(value.addBrimEar.objectId), brimEar(value.addBrimEar.ear));
  if ('addBrimEars' in value)
    return new AddBrimEarsCommand(id<'object'>(value.addBrimEars.objectId), value.addBrimEars.ears.map(brimEar));
  if ('removeBrimEar' in value)
    return new RemoveBrimEarCommand(id<'object'>(value.removeBrimEar.objectId), value.removeBrimEar.index);
  if ('clearBrimEars' in value) return new ClearBrimEarsCommand(id<'object'>(value.clearBrimEars.objectId));
  if ('renameObject' in value)
    return new RenameObjectCommand(id<'object'>(value.renameObject.objectId), text(value.renameObject.name));
  if ('renameVolume' in value)
    return new RenameVolumeCommand(id<'volume'>(value.renameVolume.volumeId), text(value.renameVolume.name));
  if ('renameInstance' in value)
    return new RenameInstanceCommand(id<'instance'>(value.renameInstance.instanceId), text(value.renameInstance.name));
  if ('setInstancePrintable' in value)
    return new SetInstancePrintableCommand(
      id<'instance'>(value.setInstancePrintable.instanceId),
      value.setInstancePrintable.printable,
    );
  if ('setInstanceTransform' in value)
    return new SetInstanceTransformCommand(
      id<'instance'>(value.setInstanceTransform.instanceId),
      transform(value.setInstanceTransform.transform),
      text(value.setInstanceTransform.gestureId),
    );
  if ('setInstanceTransforms' in value)
    return new SetInstanceTransformsCommand(
      value.setInstanceTransforms.changes.map((c) => ({
        instanceId: id<'instance'>(c.instanceId),
        transform: transform(c.transform),
      })),
      text(value.setInstanceTransforms.gestureId),
    );
  if ('addPlate' in value) {
    const input = value.addPlate;
    return new AddPlateCommand(
      {
        id: id<'plate'>(input.plateId),
        name: text(input.name),
        order: input.order,
        printable: true,
        config: {},
        objects: [],
      },
      input.activate,
    );
  }
  if ('duplicatePlate' in value) {
    const input = value.duplicatePlate;
    return new DuplicatePlateCommand(id<'plate'>(input.sourcePlateId), {
      plateId: id<'plate'>(input.plateId),
      objects: input.objects.map((object) => ({
        objectId: id<'object'>(object.objectId),
        volumeIds: object.volumeIds.map(id<'volume'>),
        instanceIds: object.instanceIds.map(id<'instance'>),
        layerRangeIds: object.layerRangeIds.map(id<'layer-range'>),
      })),
      customGcodeIds: input.customGcodeIds.map(id<'custom-gcode'>),
      thumbnailIds: input.thumbnailIds.map(id<'thumbnail'>),
    });
  }
  if ('deletePlate' in value) return new DeletePlateCommand(id<'plate'>(value.deletePlate.plateId));
  if ('activatePlate' in value) return new SetActivePlateCommand(id<'plate'>(value.activatePlate.plateId));
  if ('renamePlate' in value)
    return new RenamePlateCommand(id<'plate'>(value.renamePlate.plateId), text(value.renamePlate.name));
  if ('reorderPlates' in value) return new ReorderPlatesCommand(value.reorderPlates.plateIds.map(id<'plate'>));
  return new SetPlatePrintableCommand(id<'plate'>(value.setPlatePrintable.plateId), value.setPlatePrintable.printable);
}
const LAYER_EVENT_TYPES: Readonly<Record<ProjectLayerEventTypeWire, LayerEventType>> = Object.freeze({
  colorChange: 'color-change',
  pause: 'pause',
  toolChange: 'tool-change',
  template: 'template',
  custom: 'custom',
});
/**
 * Nesting limit for free-form JSON text. A map lands up to seven levels deep in
 * the project state (a volume's config), and the whole state must stay inside
 * the native canonical parser's limit of 64, so the text gets far less.
 */
const JSON_TEXT_MAX_DEPTH = 16;
/**
 * A free-form JSON object carried as canonical JSON text. Refusals match the
 * native side exactly: ill-formed UTF-16, invalid or non-finite JSON, nesting
 * deeper than the limit, and a non-object root are invalid intents.
 */
function jsonObject(units: readonly number[]): ConfigMap {
  if (!wellFormed(units)) throw new InvalidProjectIntent();
  const source = text(units);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
    assertCanonicalSerializable(parsed);
  } catch {
    throw new InvalidProjectIntent();
  }
  if (jsonDepth(parsed) > JSON_TEXT_MAX_DEPTH) throw new InvalidProjectIntent();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidProjectIntent();
  return parsed as ConfigMap;
}
/** The revision and semantic hash of the snapshot the caller read. */
function settingsGuard(value: ProjectSettingsGuardWire): { sourceRevision: number; sourceHash: string } {
  return { sourceRevision: value.sourceRevision, sourceHash: text(value.sourceHash) };
}
function scopedTarget(value: ProjectScopedTargetWire): Exclude<ScopedOverrideTarget, { scope: 'project' }> {
  if ('plate' in value) return { scope: 'plate', plateId: id<'plate'>(value.plate.plateId) };
  if ('object' in value) return { scope: 'object', objectId: id<'object'>(value.object.objectId) };
  if ('part' in value) return { scope: 'part', volumeId: id<'volume'>(value.part.volumeId) };
  return { scope: 'layerRange', layerRangeId: id<'layer-range'>(value.layerRange.layerRangeId) };
}
/** Every surrogate is paired: the native side parses UTF-8, which cannot carry a lone one. */
function wellFormed(units: readonly number[]): boolean {
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1];
      if (next === undefined || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
/** Depth of the deepest value, the root being 0. */
function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, JsonValue>);
  let deepest = 0;
  for (const child of children) deepest = Math.max(deepest, 1 + jsonDepth(child));
  return deepest;
}
function mixedComponent(value: ProjectMixedComponentInputWire): MixedComponent {
  return { filamentId: id<'physical-filament'>(value.filamentId), weight: value.weight };
}
function mixedDistribution(value: ProjectMixedDistributionInputWire): MixedDistribution {
  if ('ratio' in value) return { mode: 'ratio' };
  if ('cycle' in value)
    return {
      mode: 'cycle',
      ...('value' in value.cycle.cycleLengthMm ? { cycleLengthMm: value.cycle.cycleLengthMm.value } : {}),
    };
  if ('match' in value) return { mode: 'match', targetColor: text(value.match.targetColor) };
  const gradient = value.gradient;
  return {
    mode: 'gradient',
    ...('value' in gradient.startZMm ? { startZMm: gradient.startZMm.value } : {}),
    ...('value' in gradient.endZMm ? { endZMm: gradient.endZMm.value } : {}),
    startWeights: [...gradient.startWeights],
    endWeights: [...gradient.endWeights],
  };
}
const FULL_SPECTRUM_UI_MODES = { legacy: -1, ui0: 0, ui1: 1, ui2: 2, ui3: 3 } as const;
const FULL_SPECTRUM_DISTRIBUTION_MODES = { m0: 0, m2: 2 } as const;
function fullSpectrum(value: ProjectFullSpectrumInputWire): FullSpectrumRecipeState {
  return {
    schemaVersion: 1,
    upstreamStableId: text(value.upstreamStableId),
    uiMode: FULL_SPECTRUM_UI_MODES[value.uiMode],
    componentAId: id<'physical-filament'>(value.componentAId),
    componentBId: id<'physical-filament'>(value.componentBId),
    ratioA: value.ratioA,
    ratioB: value.ratioB,
    mixBPercent: value.mixBPercent,
    manualPatternGroups: value.manualPatternGroups.map((group) => group.map(id<'physical-filament'>)),
    gradientComponentIds: value.gradientComponentIds.map(id<'physical-filament'>),
    gradientComponentWeights: [...value.gradientComponentWeights],
    // Compiled out of the pinned engine, so never authored.
    pointillismAllFilaments: false,
    distributionMode: FULL_SPECTRUM_DISTRIBUTION_MODES[value.distributionMode],
    localZMaxSublayers: value.localZMaxSublayers,
    gradientEnabled: value.gradientEnabled,
    gradientStart: value.gradientStart,
    gradientEnd: value.gradientEnd,
    componentASurfaceOffsetMm: value.componentASurfaceOffsetMm,
    componentBSurfaceOffsetMm: value.componentBSurfaceOffsetMm,
    deleted: value.deleted,
    custom: value.custom,
    originAuto: value.originAuto,
  };
}
function mixedFilament(value: ProjectMixedFilamentInputWire): MixedFilament {
  return {
    id: id<'mixed-filament'>(value.mixedFilamentId),
    name: text(value.name),
    displayColor: text(value.displayColor),
    components: value.components.map(mixedComponent),
    distribution: mixedDistribution(value.distribution),
    ...('value' in value.fullSpectrum ? { fullSpectrum: fullSpectrum(value.fullSpectrum.value) } : {}),
    config: jsonObject(value.configJson),
    enabled: value.enabled,
    ...('value' in value.extensionDataJson ? { extensionData: jsonObject(value.extensionDataJson.value) } : {}),
  };
}
function assignmentTarget(value: ProjectAssignmentTargetWire): FilamentAssignmentTarget {
  if ('object' in value) return { kind: 'object', objectId: id<'object'>(value.object.objectId) };
  if ('volume' in value)
    return { kind: 'volume', objectId: id<'object'>(value.volume.objectId), volumeId: id<'volume'>(value.volume.volumeId) };
  return {
    kind: 'layer-range',
    objectId: id<'object'>(value.layerRange.objectId),
    layerRangeId: id<'layer-range'>(value.layerRange.layerRangeId),
  };
}
/** `absent` clears the local value so child scopes inherit. */
function optionalFilament(value: ProjectOptionalIdWire): FilamentId | null {
  return 'value' in value ? filament(value.value) : null;
}
/** Hands out caller-chosen IDs in order; running out is a refusal, not a guess. */
function listedIds(ids: readonly EntityId<'physical-filament'>[]): IdSource {
  let next = 0;
  return {
    next<Kind extends string>(): EntityId<Kind> {
      if (next >= ids.length) throw new Error('Printer sync needs more new filament IDs');
      return ids[next++] as unknown as EntityId<Kind>;
    },
  };
}
function layerHeightLimits(value: ProjectLayerHeightLimitsWire): LayerHeightLimits {
  return {
    layerHeightMm: value.layerHeightMm,
    minLayerHeightMm: value.minLayerHeightMm,
    maxLayerHeightMm: value.maxLayerHeightMm,
    firstObjectLayerHeightMm: value.firstObjectLayerHeightMm,
    firstObjectLayerHeightFixed: value.firstObjectLayerHeightFixed,
  };
}
function layerHeightParameters(value: ProjectLayerHeightParametersWire): LayerHeightSlicingParameters {
  return { ...layerHeightLimits(value.limits), objectHeightMm: value.objectHeightMm };
}
function brimEar(value: ProjectBrimEarWire): BrimEarPoint {
  return {
    positionMm: [value.positionMm[0], value.positionMm[1], value.positionMm[2]],
    headFrontRadiusMm: value.headFrontRadiusMm,
  };
}
function transform(value: ProjectTransformWire): Transform {
  // Tuple lengths and finite numeric values were checked by captureProjectIntent.
  return {
    translationMm: [value.translationMm[0], value.translationMm[1], value.translationMm[2]],
    rotation: [value.rotation[0], value.rotation[1], value.rotation[2], value.rotation[3]],
    scale: [value.scale[0], value.scale[1], value.scale[2]],
  };
}
