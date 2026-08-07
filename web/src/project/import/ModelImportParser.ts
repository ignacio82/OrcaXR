import type { AssetPayload } from '../assets';
import { canonicalStringify, cloneProjectState } from '../domain/canonical';
import type { AssetId, IdSource } from '../domain/ids';
import { emptyFacetAnnotations, type ProjectObject, type ProjectVolume, type Transform } from '../domain/model';
import { encodeIndexedMeshAsset } from '../meshCodec';
import {
  MalformedModelSourceError,
  UnsupportedModelFormatError,
  decodeModelImport,
  type DecodedImportNotice,
  type DecodedModelImport,
  type DecodedObject,
  type ModelImportLimits,
} from './formats';
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

export interface ModelImportPlacement {
  /** Printable area in millimetres; imported objects are centred on it. */
  readonly bedSizeMm?: readonly [number, number];
  /** Rest each imported object on the bed instead of keeping its source Z. */
  readonly dropToBed?: boolean;
}

export interface ModelImportParserOptions {
  readonly idSource: IdSource;
  readonly clock?: () => string;
  readonly limits?: Partial<ModelImportLimits>;
  readonly placement?: ModelImportPlacement;
}

/**
 * Stages STL/OBJ/AMF/ZIP model sources as a canonical merge import. Geometry
 * becomes immutable deduplicated assets, source names/parts/instances survive,
 * units are converted explicitly, and every decoder observation is surfaced as
 * a repair, dropped field, or diagnostic so nothing is lost silently. The
 * transactional coordinator still owns preview, confirmation, and history.
 */
export class ModelImportParser implements ProjectImportParserPort {
  constructor(private readonly options: ModelImportParserOptions) {}

  async parse(request: ProjectImportParseRequest): Promise<ParsedProjectImport> {
    throwIfCancelled(request.cancellation);
    if (request.mode !== 'merge') {
      throw new Error('Model import adds objects to the open project and supports merge mode only');
    }
    const decoded = decodeModelImport(request.bytes, {
      filename: request.source.filename,
      limits: this.options.limits,
    });
    throwIfCancelled(request.cancellation);
    return this.stage(decoded, request);
  }

  private stage(decoded: DecodedModelImport, request: ProjectImportParseRequest): ParsedProjectImport {
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
    const usedNames = new Set(state.plates.flatMap((entry) => entry.objects.map((object) => object.name)));
    // The import is placed as one group so its authored relative layout survives.
    const bounds = importBounds(decoded);
    const importedAt = this.options.clock?.() ?? new Date().toISOString();
    let noticeIndex = 0;
    const nextId = (prefix: string): string => {
      noticeIndex += 1;
      return `model-import-${prefix}-${noticeIndex}`;
    };

    decoded.objects.forEach((object, objectIndex) => {
      throwIfCancelled(request.cancellation);
      const volumes: ProjectVolume[] = [];

      object.volumes.forEach((volume) => {
        const positions = scalePositions(volume.mesh.positions, decoded.unitScaleToMm);
        const staged = encodeIndexedMeshAsset({
          id: STAGING_ASSET_ID,
          positions,
          indices: volume.mesh.indices,
        });
        const existing = assets.find(
          (candidate) =>
            candidate.descriptor.kind === 'mesh' &&
            candidate.descriptor.digest === staged.descriptor.digest &&
            canonicalStringify(candidate.descriptor.mesh ?? null) ===
              canonicalStringify(staged.descriptor.mesh ?? null),
        );
        let asset = existing;
        if (asset) {
          repairs.push({
            id: nextId('dedup'),
            kind: 'asset-deduplication',
            path: `$.plates[${plate.id}].objects[${object.name}].volumes[${volume.name}]`,
            message: `Reused the identical mesh already stored as ${asset.descriptor.id}`,
            requiresConfirmation: false,
          });
        } else {
          asset = encodeIndexedMeshAsset({
            id: this.options.idSource.next('asset'),
            positions,
            indices: volume.mesh.indices,
            sourceFilename: decoded.filename,
            provenance: { source: 'import', importedAt },
          });
          assets.push(asset);
          state.sourceAssets.push(asset.descriptor);
          importedAssetIds.push(asset.descriptor.id as AssetId);
        }
        const triangleCount = asset.descriptor.mesh?.triangleCount;
        if (triangleCount === undefined) throw new Error('Staged mesh asset has no topology descriptor');
        volumes.push({
          id: this.options.idSource.next('volume'),
          name: volume.name,
          role: volume.role,
          source: { assetId: asset.descriptor.id as AssetId, topologyRevision: 0, triangleCount },
          transform: IDENTITY,
          config: {},
          annotations: emptyFacetAnnotations(),
          ...(volume.colorHex || volume.materialName
            ? {
                extensionData: {
                  'orcaxr:sourceMaterial': {
                    ...(volume.materialName ? { name: volume.materialName } : {}),
                    ...(volume.colorHex ? { color: volume.colorHex } : {}),
                    format: decoded.format,
                  },
                },
              }
            : {}),
        });
      });

      if (volumes.length === 0) return;
      const name = uniqueName(object.name, usedNames, objectIndex);
      if (name !== object.name) {
        repairs.push({
          id: nextId('rename'),
          kind: 'identifier-remap',
          path: `$.plates[${plate.id}].objects[${objectIndex}]`,
          message: `Renamed imported object "${object.name}" to "${name}" because that name is already used`,
          before: object.name,
          after: name,
          requiresConfirmation: false,
        });
      }
      usedNames.add(name);

      const staged: ProjectObject = {
        id: this.options.idSource.next('object'),
        name,
        config: {},
        volumes,
        instances: object.instances.map((instance, instanceIndex) => ({
          id: this.options.idSource.next('instance'),
          name: object.instances.length > 1 ? `${name} ${instanceIndex + 1}` : name,
          transform: this.placeInstance(instance.transform, bounds, decoded.unitScaleToMm),
          printable: true,
        })),
        layerRanges: [],
        extensionData: {
          'orcaxr:importSource': {
            filename: decoded.filename,
            format: decoded.format,
            unit: decoded.sourceUnit,
            importedAt,
          },
        },
      };
      plate.objects.push(staged);
    });

    if (plate.objects.length === 0) {
      throw new MalformedModelSourceError(
        `${decoded.filename} produced no importable objects`,
        'no-geometry',
        decoded.format,
      );
    }

    for (const notice of decoded.notices) {
      projectNotice(notice, nextId, repairs, droppedFields, diagnostics);
    }
    state.updatedAt = importedAt;

    return {
      state,
      assets,
      importedAssetIds,
      repairs,
      droppedFields,
      diagnostics,
    };
  }

  private placeInstance(transform: Transform, bounds: ObjectBounds, unitScaleToMm: number): Transform {
    const placement = this.options.placement;
    const translation: [number, number, number] = [
      transform.translationMm[0] * unitScaleToMm,
      transform.translationMm[1] * unitScaleToMm,
      transform.translationMm[2] * unitScaleToMm,
    ];
    if (placement?.bedSizeMm) {
      translation[0] += placement.bedSizeMm[0] / 2 - (bounds.minX + bounds.maxX) / 2;
      translation[1] += placement.bedSizeMm[1] / 2 - (bounds.minY + bounds.maxY) / 2;
    }
    if (placement?.dropToBed) translation[2] -= bounds.minZ;
    return {
      translationMm: translation,
      rotation: [...transform.rotation] as unknown as Transform['rotation'],
      scale: [...transform.scale] as unknown as Transform['scale'],
    };
  }
}

interface ObjectBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
}

const IDENTITY: Transform = Object.freeze({
  translationMm: [0, 0, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  scale: [1, 1, 1] as const,
});

const STAGING_ASSET_ID = 'import:staging:mesh' as AssetId;

/** Bounds of every decoded object, including its instance offsets, in mm. */
function importBounds(decoded: DecodedModelImport): ObjectBounds {
  let bounds: ObjectBounds | undefined;
  for (const object of decoded.objects) {
    const local = objectBounds(object, decoded.unitScaleToMm);
    for (const instance of object.instances) {
      const [x, y, z] = [
        instance.transform.translationMm[0] * decoded.unitScaleToMm,
        instance.transform.translationMm[1] * decoded.unitScaleToMm,
        instance.transform.translationMm[2] * decoded.unitScaleToMm,
      ];
      const shifted: ObjectBounds = {
        minX: local.minX + x,
        maxX: local.maxX + x,
        minY: local.minY + y,
        maxY: local.maxY + y,
        minZ: local.minZ + z,
      };
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, shifted.minX),
            maxX: Math.max(bounds.maxX, shifted.maxX),
            minY: Math.min(bounds.minY, shifted.minY),
            maxY: Math.max(bounds.maxY, shifted.maxY),
            minZ: Math.min(bounds.minZ, shifted.minZ),
          }
        : shifted;
    }
  }
  return bounds ?? { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0 };
}

function objectBounds(object: DecodedObject, scale: number): ObjectBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  for (const volume of object.volumes) {
    const positions = volume.mesh.positions;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      const x = positions[index] * scale;
      const y = positions[index + 1] * scale;
      const z = positions[index + 2] * scale;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0 };
  return { minX, maxX, minY, maxY, minZ };
}

function scalePositions(positions: Float32Array, scale: number): Float32Array {
  if (scale === 1) return positions;
  return Float32Array.from(positions, (value) => value * scale);
}

function uniqueName(name: string, used: ReadonlySet<string>, index: number): string {
  if (!used.has(name)) return name;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${name} (${attempt})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${name} (${index + 1}-${used.size + 1})`;
}

function projectNotice(
  notice: DecodedImportNotice,
  nextId: (prefix: string) => string,
  repairs: ImportRepairNotice[],
  droppedFields: ImportDroppedFieldNotice[],
  diagnostics: ImportDiagnostic[],
): void {
  switch (notice.kind) {
    case 'unit-conversion':
      repairs.push({
        id: nextId('unit'),
        kind: 'unit-conversion',
        path: notice.path,
        message: notice.message,
      });
      return;
    case 'geometry-repair':
      repairs.push({
        id: nextId('geometry'),
        kind: 'geometry-repair',
        path: notice.path,
        message: notice.message,
      });
      return;
    case 'dropped-field':
      droppedFields.push({
        id: nextId('dropped'),
        path: notice.path,
        field: notice.code,
        message: notice.message,
      });
      return;
    default:
      diagnostics.push({
        id: nextId('info'),
        severity: 'info',
        code: notice.code,
        path: notice.path,
        message: notice.message,
      });
  }
}

function throwIfCancelled(cancellation?: CancellationToken): void {
  if (cancellation?.aborted) throw new ImportCancelledError(cancellation.reason);
}

export { MalformedModelSourceError, UnsupportedModelFormatError };
