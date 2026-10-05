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
} from './commands';
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
