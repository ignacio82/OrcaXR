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
import type { Transform } from './domain/model';
import type { ProjectTransformWire } from '../../../contracts/generated/project-intents';
import { entityId, isStableEntityId, type EntityId } from './domain/ids';
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
function transform(value: ProjectTransformWire): Transform {
  // Tuple lengths and finite numeric values were checked by captureProjectIntent.
  return {
    translationMm: [value.translationMm[0], value.translationMm[1], value.translationMm[2]],
    rotation: [value.rotation[0], value.rotation[1], value.rotation[2], value.rotation[3]],
    scale: [value.scale[0], value.scale[1], value.scale[2]],
  };
}
