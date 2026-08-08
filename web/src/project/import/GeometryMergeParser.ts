import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import type { AssetId, IdSource } from '../domain/ids';
import type { ProjectObject, ProjectState, SourceAssetDescriptor, Transform } from '../domain/model';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import {
  ImportCancelledError,
  type ImportDiagnostic,
  type ImportDroppedFieldNotice,
  type ImportRepairNotice,
  type ParsedProjectImport,
  type ProjectImportParseRequest,
  type ProjectImportParserPort,
} from './types';
import type { CancellationToken } from '../ports';

export interface GeometryMergeParserOptions {
  readonly idSource: IdSource;
  readonly clock?: () => string;
  readonly serializer?: Bbs3mfProjectSerializer;
  /** Printable area used to centre the merged objects; omit to keep source XY. */
  readonly bedSizeMm?: readonly [number, number];
}

/**
 * "Import geometry only" for a 3MF project.
 *
 * The archive is parsed with the same canonical BBS reader as Open Project,
 * but only its objects and their meshes join the open project: plates, project
 * settings, custom G-code, thumbnails, and the foreign filament library are
 * deliberately left behind and reported as dropped fields, so the user sees
 * exactly what "geometry only" discarded. Every merged entity receives fresh
 * stable IDs, so importing the same file twice cannot collide.
 */
export class GeometryMergeParser implements ProjectImportParserPort {
  private readonly serializer: Bbs3mfProjectSerializer;

  constructor(private readonly options: GeometryMergeParserOptions) {
    this.serializer = options.serializer ?? new Bbs3mfProjectSerializer();
  }

  async parse(request: ProjectImportParseRequest): Promise<ParsedProjectImport> {
    throwIfCancelled(request.cancellation);
    if (request.mode !== 'merge') {
      throw new Error('Geometry-only 3MF import adds objects to the open project and supports merge mode only');
    }
    const parsed = await this.serializer.deserialize(request.bytes.slice(), request.cancellation);
    throwIfCancelled(request.cancellation);

    const state = cloneProjectState(request.base.state);
    const plate = state.plates.find((candidate) => candidate.id === state.activePlateId) ?? state.plates[0];
    if (!plate) throw new Error('The open project has no plate to import into');

    const assets: AssetPayload[] = request.base.assets.map((asset) => ({
      descriptor: asset.descriptor,
      bytes: asset.bytes,
    }));
    const importedAssetIds: AssetId[] = [];
    const repairs: ImportRepairNotice[] = [];
    const droppedFields: ImportDroppedFieldNotice[] = [];
    const diagnostics: ImportDiagnostic[] = [];
    const importedAt = this.options.clock?.() ?? new Date().toISOString();
    const usedNames = new Set(state.plates.flatMap((entry) => entry.objects.map((object) => object.name)));
    let noticeIndex = 0;
    const nextId = (prefix: string): string => {
      noticeIndex += 1;
      return `geometry-import-${prefix}-${noticeIndex}`;
    };

    const assetMap = new Map<AssetId, AssetId>();
    const sourceAssets = new Map(parsed.state.sourceAssets.map((descriptor) => [descriptor.id, descriptor]));
    const merged: ProjectObject[] = [];
    for (const sourcePlate of parsed.state.plates) {
      for (const object of sourcePlate.objects) {
        throwIfCancelled(request.cancellation);
        const volumes = object.volumes.map((volume) => {
          const payload = parsed.assets.find((candidate) => candidate.descriptor.id === volume.source.assetId);
          const descriptor = sourceAssets.get(volume.source.assetId);
          if (!payload || !descriptor) throw new Error(`Imported volume ${volume.id} has no mesh asset`);
          let assetId = assetMap.get(volume.source.assetId);
          if (!assetId) {
            const existing = assets.find(
              (candidate) =>
                candidate.descriptor.kind === 'mesh' &&
                candidate.descriptor.digest === descriptor.digest &&
                canonicalStringify(candidate.descriptor.mesh ?? null) === canonicalStringify(descriptor.mesh ?? null),
            );
            if (existing) {
              assetId = existing.descriptor.id as AssetId;
              repairs.push({
                id: nextId('dedup'),
                kind: 'asset-deduplication',
                path: `$.objects[${object.name}].volumes[${volume.name}]`,
                message: `Reused the identical mesh already stored as ${assetId}`,
                requiresConfirmation: false,
              });
            } else {
              assetId = this.options.idSource.next('asset');
              const nextDescriptor: SourceAssetDescriptor = {
                ...cloneJson(descriptor),
                id: assetId,
                provenance: { source: 'import', importedAt },
              };
              assets.push({ descriptor: nextDescriptor, bytes: payload.bytes.slice() });
              state.sourceAssets.push(nextDescriptor);
              importedAssetIds.push(assetId);
            }
            assetMap.set(volume.source.assetId, assetId);
          }
          return {
            ...cloneJson(volume),
            id: this.options.idSource.next('volume'),
            source: { ...volume.source, assetId },
            // Foreign filament identities do not exist in this project.
            filamentId: undefined,
          };
        });
        if (volumes.length === 0) continue;
        const name = uniqueName(object.name, usedNames);
        if (name !== object.name) {
          repairs.push({
            id: nextId('rename'),
            kind: 'identifier-remap',
            path: `$.objects[${object.name}]`,
            message: `Renamed imported object "${object.name}" to "${name}" because that name is already used`,
            before: object.name,
            after: name,
            requiresConfirmation: false,
          });
        }
        usedNames.add(name);
        merged.push({
          id: this.options.idSource.next('object'),
          name,
          config: {},
          volumes: volumes.map((volume) => {
            const { filamentId: _dropped, ...rest } = volume;
            return rest;
          }),
          instances: object.instances.map((instance) => ({
            id: this.options.idSource.next('instance'),
            ...(instance.name !== undefined ? { name: instance.name } : {}),
            transform: cloneJson(instance.transform) as Transform,
            printable: instance.printable,
          })),
          layerRanges: [],
          extensionData: {
            'orcaxr:importSource': {
              filename: request.source.filename,
              format: 'project-3mf',
              mode: 'geometry-only',
              importedAt,
            },
          },
        });
      }
    }

    if (merged.length === 0) throw new Error(`${request.source.filename} contains no importable geometry`);
    plate.objects.push(...merged);
    if (this.options.bedSizeMm) centerMerged(merged, this.options.bedSizeMm, parsed.state, assets);
    state.updatedAt = importedAt;

    // Everything geometry-only leaves behind is reported, never silent.
    const discarded: [number, string, string][] = [
      [
        parsed.state.plates.length - 1,
        'plates',
        'Extra plates were not imported; every object joined the active plate',
      ],
      [
        parsed.state.filaments.physical.length + parsed.state.filaments.mixed.length,
        'filaments',
        'The source filament library and its per-part assignments were not imported',
      ],
      [Object.keys(parsed.state.config ?? {}).length, 'project-settings', 'Source project settings were not imported'],
      [parsed.state.customGcode.length, 'custom-gcode', 'Source custom G-code was not imported'],
      [parsed.state.thumbnails.length, 'thumbnails', 'Source thumbnails were not imported'],
    ];
    for (const [count, field, message] of discarded) {
      if (count > 0) {
        droppedFields.push({
          id: nextId(field),
          path: request.source.filename,
          field,
          message: `${message} (${count}).`,
        });
      }
    }
    for (const warning of new Set(parsed.warnings)) {
      diagnostics.push({
        id: nextId('warning'),
        severity: 'info',
        code: 'bbs-import-warning',
        path: request.source.filename,
        message: warning,
      });
    }

    return { state, assets, importedAssetIds, repairs, droppedFields, diagnostics };
  }
}

/** Shift merged objects as one group so they land on the target plate. */
function centerMerged(
  merged: readonly ProjectObject[],
  bedSizeMm: readonly [number, number],
  _sourceState: ProjectState,
  _assets: readonly AssetPayload[],
): void {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const object of merged) {
    for (const instance of object.instances) {
      minX = Math.min(minX, instance.transform.translationMm[0]);
      maxX = Math.max(maxX, instance.transform.translationMm[0]);
      minY = Math.min(minY, instance.transform.translationMm[1]);
      maxY = Math.max(maxY, instance.transform.translationMm[1]);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
  const deltaX = bedSizeMm[0] / 2 - (minX + maxX) / 2;
  const deltaY = bedSizeMm[1] / 2 - (minY + maxY) / 2;
  for (const object of merged) {
    for (const instance of object.instances) {
      instance.transform = {
        ...instance.transform,
        translationMm: [
          instance.transform.translationMm[0] + deltaX,
          instance.transform.translationMm[1] + deltaY,
          instance.transform.translationMm[2],
        ] as unknown as Transform['translationMm'],
      };
    }
  }
}

function uniqueName(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) return name;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${name} (${attempt})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${name} (${used.size + 1})`;
}

function throwIfCancelled(cancellation?: CancellationToken): void {
  if (cancellation?.aborted) throw new ImportCancelledError(cancellation.reason);
}
