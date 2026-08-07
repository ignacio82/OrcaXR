import { TriangleMeshBuilder, boundedName } from './mesh';
import { defaultObjectName } from './stl';
import { scanXml, type XmlElement } from './xml';
import {
  IDENTITY_TRANSFORM,
  MalformedModelSourceError,
  UNIT_SCALE_TO_MM,
  type DecodedImportNotice,
  type DecodedInstance,
  type DecodedModelImport,
  type DecodedObject,
  type DecodedVolume,
  type ModelImportLimits,
} from './types';
import type { Quaternion, Transform, VolumeRole } from '../../domain/model';

export interface AmfDecodeOptions {
  readonly filename: string;
  readonly limits: ModelImportLimits;
}

interface AmfVolume {
  name?: string;
  materialId?: string;
  role: VolumeRole;
  triangles: number[];
}

interface AmfObject {
  id: string;
  name?: string;
  vertices: number[];
  volumes: AmfVolume[];
}

interface AmfInstance {
  objectId: string;
  translation: [number, number, number];
  rotationDeg: [number, number, number];
}

/**
 * Decode AMF (ISO/ASTM 52915) meshes, materials, and constellation instances.
 * Slic3r/Orca `slic3r.*` volume metadata selects modifier roles; every other
 * extension field is reported as a dropped field rather than silently ignored.
 */
export function decodeAmf(bytes: Uint8Array, options: AmfDecodeOptions): DecodedModelImport {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const limits = options.limits;
  const notices: DecodedImportNotice[] = [];
  const droppedMetadata = new Set<string>();

  const objects: AmfObject[] = [];
  const materialColors = new Map<string, string>();
  const materialNames = new Map<string, string>();
  const instances: AmfInstance[] = [];

  let unit = 'millimeter';
  let currentObject: AmfObject | undefined;
  let currentVolume: AmfVolume | undefined;
  let currentMaterial: string | undefined;
  let currentInstance: AmfInstance | undefined;
  let pendingVertex: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
  let pendingTriangle: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
  let pendingColor: Record<string, number> = {};
  let metadataType: string | undefined;
  let metadataOwner: 'amf' | 'object' | 'volume' | 'material' | 'instance' | undefined;
  let insideVertexCoordinates = false;
  let insideColor = false;

  const fail: (message: string, reason?: 'invalid-syntax' | 'invalid-geometry' | 'limit-exceeded') => never = (
    message,
    reason = 'invalid-syntax',
  ) => {
    throw new MalformedModelSourceError(`${options.filename}: ${message}`, reason, 'amf');
  };

  scanXml(text, options.filename, limits, 'amf', {
    onOpen(element: XmlElement) {
      switch (element.localName) {
        case 'amf': {
          const declared = (element.attributes.unit ?? 'millimeter').trim().toLowerCase();
          if (!(declared in UNIT_SCALE_TO_MM)) fail(`unsupported unit "${declared}"`);
          unit = declared;
          break;
        }
        case 'object': {
          if (objects.length + 1 > limits.maxObjects) fail(`more than ${limits.maxObjects} objects`, 'limit-exceeded');
          const id = element.attributes.id?.trim();
          if (!id) fail('an <object> element has no id');
          if (objects.some((object) => object.id === id)) fail(`duplicate object id "${id}"`);
          currentObject = { id: id as string, vertices: [], volumes: [] };
          objects.push(currentObject);
          break;
        }
        case 'volume': {
          if (!currentObject) fail('<volume> outside an <object>');
          if (currentObject.volumes.length + 1 > limits.maxVolumesPerObject) {
            fail(
              `object "${currentObject.id}" declares more than ${limits.maxVolumesPerObject} volumes`,
              'limit-exceeded',
            );
          }
          currentVolume = {
            role: 'model',
            triangles: [],
            materialId: element.attributes.materialid?.trim() || undefined,
          };
          currentObject.volumes.push(currentVolume);
          break;
        }
        case 'coordinates':
          insideVertexCoordinates = true;
          pendingVertex = [undefined, undefined, undefined];
          break;
        case 'triangle':
          pendingTriangle = [undefined, undefined, undefined];
          break;
        case 'material':
          currentMaterial = element.attributes.id?.trim() || undefined;
          if (!currentMaterial) fail('a <material> element has no id');
          break;
        case 'color':
          insideColor = true;
          pendingColor = {};
          break;
        case 'constellation':
          break;
        case 'instance': {
          const objectId = element.attributes.objectid?.trim();
          if (!objectId) fail('an <instance> element has no objectid');
          currentInstance = { objectId: objectId as string, translation: [0, 0, 0], rotationDeg: [0, 0, 0] };
          instances.push(currentInstance);
          if (instances.length > limits.maxObjects * limits.maxInstancesPerObject) {
            fail('too many constellation instances', 'limit-exceeded');
          }
          break;
        }
        case 'metadata':
          metadataType = element.attributes.type?.trim();
          metadataOwner = currentInstance
            ? 'instance'
            : currentVolume
              ? 'volume'
              : currentObject
                ? 'object'
                : currentMaterial
                  ? 'material'
                  : 'amf';
          break;
        default:
          break;
      }
    },
    onText(raw: string, parent: string) {
      const value = raw.trim();
      if (!value) return;
      switch (parent) {
        case 'x':
        case 'y':
        case 'z': {
          if (insideVertexCoordinates) {
            const index = parent === 'x' ? 0 : parent === 'y' ? 1 : 2;
            pendingVertex[index] = Number(value);
          }
          break;
        }
        case 'v1':
        case 'v2':
        case 'v3': {
          const index = Number(parent.slice(1)) - 1;
          pendingTriangle[index] = Number.parseInt(value, 10);
          break;
        }
        case 'r':
        case 'g':
        case 'b':
        case 'a':
          if (insideColor) pendingColor[parent] = Number(value);
          break;
        case 'deltax':
        case 'deltay':
        case 'deltaz': {
          if (!currentInstance) break;
          const index = parent === 'deltax' ? 0 : parent === 'deltay' ? 1 : 2;
          currentInstance.translation[index] = Number(value);
          break;
        }
        case 'rx':
        case 'ry':
        case 'rz': {
          if (!currentInstance) break;
          const index = parent === 'rx' ? 0 : parent === 'ry' ? 1 : 2;
          currentInstance.rotationDeg[index] = Number(value);
          break;
        }
        case 'metadata': {
          if (!metadataType) break;
          const type = metadataType.toLowerCase();
          if (type === 'name') {
            if (metadataOwner === 'volume' && currentVolume) currentVolume.name = value;
            else if (metadataOwner === 'object' && currentObject) currentObject.name = value;
            else if (metadataOwner === 'material' && currentMaterial) materialNames.set(currentMaterial, value);
          } else if (type === 'slic3r.modifier' && currentVolume) {
            currentVolume.role = value === '0' ? 'model' : 'parameter-modifier';
          } else {
            droppedMetadata.add(`${metadataOwner ?? 'amf'}:${metadataType}`);
          }
          break;
        }
        default:
          break;
      }
    },
    onClose(localName: string) {
      switch (localName) {
        case 'coordinates': {
          insideVertexCoordinates = false;
          if (!currentObject) fail('<coordinates> outside an <object>');
          const [x, y, z] = pendingVertex;
          if (x === undefined || y === undefined || z === undefined) fail('a vertex is missing a coordinate');
          if (![x, y, z].every((value) => Number.isFinite(value)))
            fail('a vertex has a non-numeric coordinate', 'invalid-geometry');
          if (currentObject.vertices.length / 3 + 1 > limits.maxVertices) {
            fail('vertex count above the import limit', 'limit-exceeded');
          }
          currentObject.vertices.push(x as number, y as number, z as number);
          break;
        }
        case 'triangle': {
          if (!currentVolume) fail('<triangle> outside a <volume>');
          const [a, b, c] = pendingTriangle;
          if (a === undefined || b === undefined || c === undefined) fail('a triangle is missing a vertex reference');
          if (![a, b, c].every((value) => Number.isInteger(value) && (value as number) >= 0)) {
            fail('a triangle references an invalid vertex index', 'invalid-geometry');
          }
          if (currentVolume.triangles.length / 3 + 1 > limits.maxTriangles) {
            fail('triangle count above the import limit', 'limit-exceeded');
          }
          currentVolume.triangles.push(a as number, b as number, c as number);
          break;
        }
        case 'color': {
          insideColor = false;
          if (currentMaterial && !currentVolume) {
            materialColors.set(currentMaterial, colorFromChannels(pendingColor));
          }
          break;
        }
        case 'volume':
          currentVolume = undefined;
          break;
        case 'object':
          currentObject = undefined;
          break;
        case 'material':
          currentMaterial = undefined;
          break;
        case 'instance':
          currentInstance = undefined;
          break;
        case 'metadata':
          metadataType = undefined;
          metadataOwner = undefined;
          break;
        default:
          break;
      }
    },
  });

  if (objects.length === 0) fail('no <object> elements', 'invalid-syntax');

  const instancesByObject = new Map<string, DecodedInstance[]>();
  for (const instance of instances) {
    if (!objects.some((object) => object.id === instance.objectId)) {
      fail(`constellation instance references unknown object "${instance.objectId}"`);
    }
    const list = instancesByObject.get(instance.objectId) ?? [];
    if (list.length + 1 > limits.maxInstancesPerObject) {
      fail(
        `object "${instance.objectId}" declares more than ${limits.maxInstancesPerObject} instances`,
        'limit-exceeded',
      );
    }
    list.push(Object.freeze({ transform: instanceTransform(instance) }));
    instancesByObject.set(instance.objectId, list);
  }

  const decoded: DecodedObject[] = [];
  for (const object of objects) {
    const volumes: DecodedVolume[] = [];
    const vertexCount = object.vertices.length / 3;
    for (const volume of object.volumes) {
      const builder = new TriangleMeshBuilder(limits, 'amf', options.filename);
      const remapped = new Map<number, number>();
      for (let corner = 0; corner < volume.triangles.length; corner += 3) {
        const resolved: number[] = [];
        for (let offset = 0; offset < 3; offset += 1) {
          const source = volume.triangles[corner + offset];
          if (source >= vertexCount) {
            fail(
              `object "${object.id}" references vertex ${source} outside its ${vertexCount} declared vertices`,
              'invalid-geometry',
            );
          }
          let index = remapped.get(source);
          if (index === undefined) {
            index = builder.addVertex(
              object.vertices[source * 3],
              object.vertices[source * 3 + 1],
              object.vertices[source * 3 + 2],
            );
            remapped.set(source, index);
          }
          resolved.push(index);
        }
        builder.addIndexedTriangle(resolved[0], resolved[1], resolved[2]);
      }
      if (builder.triangleCount === 0) continue;
      const repair = builder.repairNotice();
      if (repair) notices.push(repair);
      const materialName = volume.materialId ? (materialNames.get(volume.materialId) ?? volume.materialId) : undefined;
      volumes.push(
        Object.freeze({
          name: boundedName(
            volume.name ?? materialName,
            `${object.name ?? object.id} part ${volumes.length + 1}`,
            limits,
          ),
          role: volume.role,
          mesh: builder.build(),
          materialName,
          colorHex: volume.materialId ? materialColors.get(volume.materialId) : undefined,
        }),
      );
    }
    if (volumes.length === 0) continue;
    const objectInstances = instancesByObject.get(object.id) ?? [Object.freeze({ transform: IDENTITY_TRANSFORM })];
    decoded.push(
      Object.freeze({
        name: boundedName(object.name, `${defaultObjectName(options.filename)} ${decoded.length + 1}`, limits),
        volumes: Object.freeze(volumes),
        instances: Object.freeze(objectInstances),
      }),
    );
  }
  if (decoded.length === 0) fail('no printable volumes', 'invalid-syntax');

  const unitScaleToMm = UNIT_SCALE_TO_MM[unit];
  if (unitScaleToMm !== 1) {
    notices.push({
      kind: 'unit-conversion',
      code: 'amf-unit-converted',
      path: options.filename,
      message: `Converted ${unit} coordinates to millimetres (×${unitScaleToMm})`,
    });
  }
  for (const dropped of [...droppedMetadata].sort()) {
    notices.push({
      kind: 'dropped-field',
      code: 'amf-metadata-not-imported',
      path: options.filename,
      message: `AMF metadata "${dropped}" is not mapped to a canonical field yet and was not imported`,
    });
  }
  if (decoded.some((object) => object.volumes.some((volume) => volume.colorHex))) {
    notices.push({
      kind: 'material-substitution',
      code: 'amf-material-colours-retained',
      path: options.filename,
      message: 'AMF material colours were retained as part metadata; assign filaments to apply them to a print',
    });
  }

  return Object.freeze({
    format: 'amf',
    filename: options.filename,
    unitScaleToMm,
    sourceUnit: unit,
    objects: Object.freeze(decoded),
    notices: Object.freeze(notices),
  });
}

function instanceTransform(instance: AmfInstance): Transform {
  const [rx, ry, rz] = instance.rotationDeg.map((value) => (Number.isFinite(value) ? (value * Math.PI) / 180 : 0));
  return Object.freeze({
    translationMm: Object.freeze(
      instance.translation.map((value) => (Number.isFinite(value) ? value : 0)),
    ) as unknown as Transform['translationMm'],
    rotation: quaternionFromEulerXyz(rx, ry, rz),
    scale: Object.freeze([1, 1, 1]) as unknown as Transform['scale'],
  });
}

/** Rz · Ry · Rx, the composition order AMF specifies for instance rotations. */
function quaternionFromEulerXyz(x: number, y: number, z: number): Quaternion {
  const [sx, cx] = [Math.sin(x / 2), Math.cos(x / 2)];
  const [sy, cy] = [Math.sin(y / 2), Math.cos(y / 2)];
  const [sz, cz] = [Math.sin(z / 2), Math.cos(z / 2)];
  return Object.freeze([
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ]) as unknown as Quaternion;
}

function colorFromChannels(channels: Record<string, number>): string {
  const channel = (value: number | undefined): string => {
    const numeric = Number.isFinite(value) ? (value as number) : 0;
    const scaled = numeric <= 1 ? numeric * 255 : numeric;
    return Math.max(0, Math.min(255, Math.round(scaled)))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(channels.r)}${channel(channels.g)}${channel(channels.b)}`;
}
