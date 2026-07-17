import { contentDigest, type AssetPayload } from '../assets';
import { seededRandom, UuidIdSource } from '../domain/ids';
import {
  emptyFacetAnnotations,
  identityTransform,
  type MixedFilament,
  type PhysicalFilament,
  type ProjectObject,
  type ProjectState,
  type SourceAssetDescriptor,
} from '../domain/model';

export interface ProjectFixture {
  state: ProjectState;
  asset: AssetPayload;
  object: ProjectObject;
  ids: ReturnType<typeof fixtureIds>;
}

function fixtureIds(source = new UuidIdSource(seededRandom(0x0cca))) {
  return {
    project: source.next('project'),
    plate: source.next('plate'),
    object: source.next('object'),
    volume: source.next('volume'),
    instance: source.next('instance'),
    range: source.next('layer-range'),
    asset: source.next('asset'),
    physical0: source.next('physical-filament'),
    physical1: source.next('physical-filament'),
    mixed: source.next('mixed-filament'),
  };
}

export function createProjectFixture(options: { withObject?: boolean } = {}): ProjectFixture {
  const ids = fixtureIds();
  const bytes = new Uint8Array(36);
  const mesh = new DataView(bytes.buffer);
  [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
  ].forEach((vertex, vertexIndex) => {
    vertex.forEach((coordinate, componentIndex) => {
      mesh.setFloat32(vertexIndex * 12 + componentIndex * 4, coordinate, true);
    });
  });
  const descriptor: SourceAssetDescriptor = {
    id: ids.asset,
    kind: 'mesh',
    digest: contentDigest(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/vnd.orcaxr.indexed-mesh',
    sourceFilename: 'tiny.stl',
    provenance: { source: 'import', uri: 'fixture:tiny' },
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: 36,
        componentType: 'float32',
        componentCount: 3,
        count: 3,
      },
      triangleCount: 1,
    },
  };
  const physical0: PhysicalFilament = {
    id: ids.physical0,
    name: 'Head 1 PLA',
    toolId: 0,
    material: 'PLA',
    color: '#ff0000',
    config: { nozzle_temperature: 220 },
    enabled: true,
  };
  const physical1: PhysicalFilament = {
    id: ids.physical1,
    name: 'Head 2 PLA',
    toolId: 1,
    material: 'PLA',
    color: '#0000ff',
    config: { nozzle_temperature: 215 },
    enabled: true,
  };
  const mixed: MixedFilament = {
    id: ids.mixed,
    name: 'Purple mix',
    displayColor: '#800080',
    components: [
      { filamentId: physical0.id, weight: 1 },
      { filamentId: physical1.id, weight: 1 },
    ],
    distribution: { mode: 'ratio' },
    config: {},
    enabled: true,
  };
  const object: ProjectObject = {
    id: ids.object,
    name: 'Tiny triangle',
    config: { layer_height: 0.2, wall_loops: 2 },
    filamentId: physical0.id,
    volumes: [
      {
        id: ids.volume,
        name: 'Body',
        role: 'model',
        source: { assetId: ids.asset, topologyRevision: 0, triangleCount: 1 },
        transform: identityTransform(),
        config: { wall_loops: 3 },
        annotations: {
          ...emptyFacetAnnotations(0),
          color: [{ triangles: [0], value: mixed.id }],
        },
      },
    ],
    instances: [
      {
        id: ids.instance,
        transform: identityTransform(),
        printable: true,
      },
    ],
    layerRanges: [
      {
        id: ids.range,
        minZMm: 0,
        maxZMm: 5,
        config: { layer_height: 0.12 },
      },
    ],
  };
  const state: ProjectState = {
    schemaVersion: 1,
    id: ids.project,
    name: 'Foundation fixture',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    printer: { profileId: 'snapmaker-u1', toolCount: 2 },
    config: { layer_height: 0.24, sparse_infill_density: 15 },
    activePlateId: ids.plate,
    plates: [
      {
        id: ids.plate,
        name: 'Plate 1',
        order: 0,
        printable: true,
        config: { layer_height: 0.2 },
        objects: options.withObject === false ? [] : [object],
      },
    ],
    filaments: { physical: [physical0, physical1], mixed: [mixed] },
    sourceAssets: [descriptor],
    customGcode: [],
    thumbnails: [],
    extensionBlobs: [],
  };
  return { state, asset: { descriptor, bytes }, object, ids };
}
