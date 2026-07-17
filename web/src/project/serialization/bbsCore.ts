import { canonicalStringify, cloneJson, fnv1a64 } from '../domain/canonical';
import { entityId, type FilamentId } from '../domain/ids';
import type { AssetPayload } from '../assets';
import { contentDigest } from '../assets';
import type {
  ConfigMap,
  FacetAnnotations,
  JsonValue,
  LayerRange,
  PhysicalFilament,
  ProjectObject,
  ProjectPlate,
  ProjectState,
  ProjectVolume,
  SourceAssetDescriptor,
  Transform,
  TriangleAssignments,
  VolumeRole,
} from '../domain/model';
import { emptyFacetAnnotations, identityTransform } from '../domain/model';

export const CORE_MODEL_PATH = '3D/3dmodel.model';
export const MODEL_RELS_PATH = '3D/_rels/3dmodel.model.rels';
export const PROJECT_SETTINGS_PATH = 'Metadata/project_settings.config';
export const MODEL_SETTINGS_PATH = 'Metadata/model_settings.config';
export const LAYER_RANGES_PATH = 'Metadata/layer_config_ranges.xml';

const ORCAXR_CORE_NAMESPACE = 'https://orcaxr.martinez.fyi/3mf/project/1';
const CORE_OBJECT_ATTRIBUTES_KEY = `${ORCAXR_CORE_NAMESPACE}/core-object-attributes`;
const CORE_COMPONENT_ATTRIBUTES_KEY = `${ORCAXR_CORE_NAMESPACE}/core-component-attributes`;
const CORE_BUILD_ATTRIBUTES_KEY = `${ORCAXR_CORE_NAMESPACE}/core-build-attributes`;
const CORE_FACET_ATTRIBUTES_KEY = `${ORCAXR_CORE_NAMESPACE}/core-facet-attributes`;

export const GENERATED_STANDARD_PATHS = new Set([
  '[Content_Types].xml',
  '_rels/.rels',
  CORE_MODEL_PATH,
  MODEL_RELS_PATH,
  PROJECT_SETTINGS_PATH,
  MODEL_SETTINGS_PATH,
  LAYER_RANGES_PATH,
]);

export interface BbsCoreBuild {
  files: Map<string, Uint8Array>;
  warnings: string[];
}

interface VolumeMapping {
  volume: ProjectVolume;
  numericId: number;
  mesh?: DecodedMesh;
}

interface ObjectMapping {
  object: ProjectObject;
  plate: ProjectPlate;
  ordinal: number;
  parentId: number;
  volumes: VolumeMapping[];
}

interface DecodedMesh {
  vertices: Array<readonly [number, number, number]>;
  triangles: Array<readonly [number, number, number]>;
}

interface ExtensionAttribute {
  namespace: string;
  name: string;
  value: string;
}

interface FacetExtensionAttributes {
  triangle: number;
  attributes: ExtensionAttribute[];
}

export function buildBbsCore(state: ProjectState, assets: ReadonlyMap<string, AssetPayload>): BbsCoreBuild {
  const warnings: string[] = [];
  const mappings: ObjectMapping[] = [];
  let nextNumericId = 1;
  let ordinal = 0;
  const orderedPlates = [...state.plates].sort((left, right) => left.order - right.order);
  for (const plate of orderedPlates) {
    for (const object of plate.objects) {
      ordinal += 1;
      const volumes: VolumeMapping[] = object.volumes.map((volume) => {
        const numericId = nextNumericId++;
        const payload = assets.get(volume.source.assetId);
        let mesh: DecodedMesh | undefined;
        if (!payload) {
          warnings.push(`Volume ${volume.id} has no source asset; omitted from standard 3MF core`);
        } else {
          try {
            mesh = decodeIndexedMesh(payload);
          } catch (error) {
            warnings.push(
              `Volume ${volume.id} could not be projected into standard 3MF: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        return { volume, numericId, mesh };
      });
      mappings.push({ object, plate, ordinal, parentId: nextNumericId++, volumes });
    }
  }

  const filamentSlots = new Map<FilamentId, number>();
  const materialRows: Array<{ name: string; color: string }> = [];
  for (const filament of state.filaments.physical) {
    filamentSlots.set(filament.id, materialRows.length + 1);
    materialRows.push({ name: filament.name, color: normalizeColor(filament.color) });
  }
  for (const filament of state.filaments.mixed.filter((candidate) => candidate.enabled)) {
    filamentSlots.set(filament.id, materialRows.length + 1);
    materialRows.push({ name: filament.name, color: normalizeColor(filament.displayColor) });
  }
  if (materialRows.length > 18) {
    warnings.push(
      `The BBS whole-facet paint encoding supports 18 material states; slots 19-${materialRows.length} remain lossless only in the OrcaXR extension`,
    );
  }
  const referencedFilaments = new Set<FilamentId>();
  for (const plate of state.plates) {
    if (plate.wipeTower?.filamentId) referencedFilaments.add(plate.wipeTower.filamentId);
    for (const object of plate.objects) {
      if (object.filamentId) referencedFilaments.add(object.filamentId);
      object.layerRanges.forEach((range) => {
        if (range.filamentId) referencedFilaments.add(range.filamentId);
      });
      object.volumes.forEach((volume) => {
        if (volume.filamentId) referencedFilaments.add(volume.filamentId);
        volume.annotations.color.forEach((assignment) => referencedFilaments.add(assignment.value));
      });
    }
  }
  for (const filamentId of referencedFilaments) {
    if (!filamentSlots.has(filamentId)) {
      warnings.push(
        `Filament ${filamentId} is disabled or cannot be assigned a BBS material slot; its references remain lossless in the OrcaXR extension`,
      );
    }
  }
  const materialId = nextNumericId;
  const files = new Map<string, Uint8Array>();
  files.set(CORE_MODEL_PATH, encodeText(buildCoreModel(state, mappings, materialRows, materialId, filamentSlots)));
  files.set(MODEL_SETTINGS_PATH, encodeText(buildModelSettings(mappings, filamentSlots)));
  files.set(PROJECT_SETTINGS_PATH, encodeText(buildProjectSettings(state, filamentSlots, warnings)));
  const layerRanges = buildLayerRanges(mappings, filamentSlots);
  if (layerRanges) files.set(LAYER_RANGES_PATH, encodeText(layerRanges));
  files.set(MODEL_RELS_PATH, encodeText(emptyRelationships()));
  if (state.customGcode.length > 0) {
    warnings.push(
      'Custom G-code is preserved losslessly in the OrcaXR extension; the canonical model does not yet carry every BBS height/event field needed for an official custom_gcode_per_layer.xml projection',
    );
  }
  if (state.extensionData || state.extensionBlobs.length > 0) {
    warnings.push('Unknown project extensions are retained as package entries and OrcaXR metadata');
  }
  return { files, warnings };
}

function buildCoreModel(
  state: ProjectState,
  mappings: ObjectMapping[],
  materials: Array<{ name: string; color: string }>,
  materialId: number,
  filamentSlots: ReadonlyMap<FilamentId, number>,
): string {
  const extensionNamespaces = collectCoreExtensionNamespaces(mappings);
  const namespacePrefixes = new Map(
    [...extensionNamespaces].sort(compareText).map((namespace, index) => [namespace, `ext${index + 1}`]),
  );
  const namespaceDeclarations = [...namespacePrefixes.entries()]
    .map(([namespace, prefix]) => ` xmlns:${prefix}="${xmlAttribute(namespace)}"`)
    .join('');
  const hasSupports = mappings.some((mapping) =>
    mapping.volumes.some((entry) => entry.volume.annotations.support.length > 0),
  );
  const hasSeams = mappings.some((mapping) =>
    mapping.volumes.some((entry) => entry.volume.annotations.seam.length > 0),
  );
  const hasColors = mappings.some((mapping) =>
    mapping.volumes.some((entry) => entry.volume.annotations.color.length > 0),
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:ox="${ORCAXR_CORE_NAMESPACE}"${namespaceDeclarations}>`,
    ` <metadata name="Title">${xmlText(state.name)}</metadata>`,
    ' <metadata name="Application">BambuStudio-2.3.4</metadata>',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <metadata name="OrcaXR:Generator">OrcaXR canonical project serializer</metadata>',
  ];
  if (hasSupports) lines.push(' <metadata name="BambuStudio:FdmSupportsPaintingVersion">0</metadata>');
  if (hasSeams) lines.push(' <metadata name="BambuStudio:SeamPaintingVersion">0</metadata>');
  if (hasColors) lines.push(' <metadata name="BambuStudio:MmPaintingVersion">0</metadata>');
  lines.push(' <resources>');
  if (materials.length > 0) {
    lines.push(`  <basematerials id="${materialId}">`);
    for (const material of materials) {
      lines.push(`   <base name="${xmlAttribute(material.name)}" displaycolor="${material.color}"/>`);
    }
    lines.push('  </basematerials>');
  }
  for (const mapping of mappings) {
    for (const entry of mapping.volumes) {
      if (!entry.mesh) continue;
      const slot = entry.volume.filamentId
        ? filamentSlots.get(entry.volume.filamentId)
        : mapping.object.filamentId
          ? filamentSlots.get(mapping.object.filamentId)
          : undefined;
      lines.push(
        `  <object id="${entry.numericId}" type="model" name="${xmlAttribute(
          entry.volume.name,
        )}" ox:stable-id="${xmlAttribute(entry.volume.id)}"${
          slot && materials.length > 0 ? ` pid="${materialId}" pindex="${slot - 1}"` : ''
        }${renderExtensionAttributes(
          entry.volume.extensionData,
          CORE_OBJECT_ATTRIBUTES_KEY,
          namespacePrefixes,
          new Set(['id', 'type', 'name', 'pid', 'pindex']),
        )}>`,
      );
      lines.push('   <mesh>', '    <vertices>');
      for (const vertex of entry.mesh.vertices) {
        lines.push(
          `     <vertex x="${formatNumber(vertex[0])}" y="${formatNumber(vertex[1])}" z="${formatNumber(vertex[2])}"/>`,
        );
      }
      lines.push('    </vertices>', '    <triangles>');
      const annotations = annotationAttributes(entry.volume.annotations, filamentSlots);
      const facetExtensions = readFacetExtensionAttributes(entry.volume.extensionData, entry.mesh.triangles.length);
      entry.mesh.triangles.forEach((triangle, index) => {
        const attributes = new Map(annotations.get(index) ?? []);
        for (const extension of facetExtensions.get(index) ?? []) {
          const renderedName = renderedExtensionName(extension, namespacePrefixes);
          if (renderedName) attributes.set(renderedName, extension.value);
        }
        const rendered = [...attributes.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([name, value]) => ` ${name}="${xmlAttribute(value)}"`)
          .join('');
        lines.push(`     <triangle v1="${triangle[0]}" v2="${triangle[1]}" v3="${triangle[2]}"${rendered}/>`);
      });
      lines.push('    </triangles>', '   </mesh>', '  </object>');
    }
    const components = mapping.volumes.filter((entry) => entry.mesh);
    if (components.length > 0) {
      lines.push(
        `  <object id="${mapping.parentId}" type="model" name="${xmlAttribute(
          mapping.object.name,
        )}" ox:stable-id="${xmlAttribute(mapping.object.id)}"${renderExtensionAttributes(
          mapping.object.extensionData,
          CORE_OBJECT_ATTRIBUTES_KEY,
          namespacePrefixes,
          new Set(['id', 'type', 'name']),
        )}>`,
        '   <components>',
      );
      for (const entry of components) {
        lines.push(
          `    <component objectid="${entry.numericId}" transform="${transform3mf(
            entry.volume.transform,
          )}"${renderExtensionAttributes(
            entry.volume.extensionData,
            CORE_COMPONENT_ATTRIBUTES_KEY,
            namespacePrefixes,
            new Set(['objectid', 'transform']),
          )}/>`,
        );
      }
      lines.push('   </components>', '  </object>');
    }
  }
  lines.push(' </resources>', ' <build>');
  for (const mapping of mappings) {
    if (!mapping.volumes.some((entry) => entry.mesh)) continue;
    for (const instance of mapping.object.instances) {
      lines.push(
        `  <item objectid="${mapping.parentId}" transform="${transform3mf(
          instance.transform,
        )}" printable="${instance.printable ? 1 : 0}" ox:instance-id="${xmlAttribute(
          instance.id,
        )}"${renderExtensionAttributes(
          instance.extensionData,
          CORE_BUILD_ATTRIBUTES_KEY,
          namespacePrefixes,
          new Set(['objectid', 'transform', 'printable']),
        )}/>`,
      );
    }
  }
  lines.push(' </build>', '</model>', '');
  return lines.join('\n');
}

function buildModelSettings(mappings: ObjectMapping[], filamentSlots: ReadonlyMap<FilamentId, number>): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  for (const mapping of mappings) {
    if (!mapping.volumes.some((entry) => entry.mesh)) continue;
    lines.push(` <object id="${mapping.parentId}">`);
    lines.push(metadataLine('name', mapping.object.name, 2));
    if (mapping.object.filamentId) {
      const slot = filamentSlots.get(mapping.object.filamentId);
      if (slot) lines.push(metadataLine('extruder', slot, 2));
    }
    appendConfig(lines, mapping.object.config, 2);
    for (const entry of mapping.volumes) {
      if (!entry.mesh) continue;
      lines.push(`  <part id="${entry.numericId}" subtype="${volumeSubtype(entry.volume.role)}">`);
      lines.push(metadataLine('name', entry.volume.name, 3));
      lines.push(metadataLine('matrix', matrix4(entry.volume.transform), 3));
      const slot = entry.volume.filamentId ? filamentSlots.get(entry.volume.filamentId) : undefined;
      if (slot) lines.push(metadataLine('extruder', slot, 3));
      appendConfig(lines, entry.volume.config, 3);
      lines.push(
        '   <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>',
      );
      lines.push('  </part>');
    }
    lines.push(' </object>');
  }
  let identifyId = 1;
  const orderedPlates = [...new Set(mappings.map((mapping) => mapping.plate))].sort(
    (left, right) => left.order - right.order,
  );
  for (const plate of orderedPlates) {
    lines.push(' <plate>');
    lines.push(metadataLine('plater_id', plate.order + 1, 2));
    lines.push(metadataLine('plater_name', plate.name, 2));
    lines.push(metadataLine('locked', bbsValue(plate.config.locked ?? false), 2));
    lines.push(metadataLine('printable', plate.printable ? 1 : 0, 2));
    const plateConfig = cloneJson(plate.config);
    delete plateConfig.plater_id;
    delete plateConfig.plater_name;
    delete plateConfig.locked;
    delete plateConfig.printable;
    appendConfig(lines, plateConfig, 2);
    for (const mapping of mappings.filter((candidate) => candidate.plate.id === plate.id)) {
      if (!mapping.volumes.some((entry) => entry.mesh)) continue;
      mapping.object.instances.forEach((_instance, instanceIndex) => {
        lines.push('  <model_instance>');
        lines.push(metadataLine('object_id', mapping.parentId, 3));
        lines.push(metadataLine('instance_id', instanceIndex, 3));
        lines.push(metadataLine('identify_id', identifyId++, 3));
        lines.push('  </model_instance>');
      });
    }
    lines.push(' </plate>');
  }
  lines.push(' <assemble/>', '</config>', '');
  return lines.join('\n');
}

function buildProjectSettings(
  state: ProjectState,
  filamentSlots: ReadonlyMap<FilamentId, number>,
  warnings: string[],
): string {
  const config: Record<string, JsonValue> = {
    ...cloneJson(state.config),
    type: 'project_settings',
    name: 'project_settings',
    from: 'project',
    version: '2.3.4',
    filament_colour: state.filaments.physical.map((filament) => normalizeColor(filament.color).slice(0, 7)),
    filament_settings_id: state.filaments.physical.map((filament) => filament.presetId ?? filament.name),
    filament_ids: state.filaments.physical.map((filament) => filament.presetHash ?? filament.presetId ?? ''),
    filament_type: state.filaments.physical.map((filament) => filament.material),
    filament_vendor: state.filaments.physical.map((filament) => filament.vendor ?? ''),
  };
  if (state.printer.profileId) config.printer_settings_id = state.printer.profileId;
  if (
    state.filaments.physical.length > 0 &&
    state.filaments.physical.every((filament) => filament.nozzleDiameterMm !== undefined)
  ) {
    config.nozzle_diameter = state.filaments.physical.map((filament) => filament.nozzleDiameterMm!);
  }
  const filamentConfigKeys = new Set(state.filaments.physical.flatMap((filament) => Object.keys(filament.config)));
  for (const key of [...filamentConfigKeys].sort(compareText)) {
    if (Object.hasOwn(config, key)) continue;
    if (state.filaments.physical.every((filament) => Object.hasOwn(filament.config, key))) {
      config[key] = state.filaments.physical.map((filament) => cloneJson(filament.config[key]));
    }
  }
  const orderedPlates = [...state.plates].sort((left, right) => left.order - right.order);
  const wipeTowers = orderedPlates.map((plate) => plate.wipeTower);
  if (wipeTowers.some((tower) => tower?.enabled)) {
    config.enable_prime_tower = true;
    config.wipe_tower_x = wipeTowers.map((tower) => tower?.positionMm[0] ?? 0);
    config.wipe_tower_y = wipeTowers.map((tower) => tower?.positionMm[1] ?? 0);
    const rotations = wipeTowers.filter((tower) => tower?.enabled).map((tower) => tower!.rotationDeg);
    config.wipe_tower_rotation_angle = rotations[0] ?? 0;
    if (new Set(rotations).size > 1) {
      warnings.push(
        'Per-plate wipe-tower rotations are retained in the OrcaXR extension; BBS project settings carry the first enabled rotation',
      );
    }
    const enabledStates = wipeTowers.map((tower) => Boolean(tower?.enabled));
    if (enabledStates.some(Boolean) && enabledStates.some((enabled) => !enabled)) {
      warnings.push(
        'Per-plate wipe-tower enabled states are retained in the OrcaXR extension; BBS exposes one project-level enable flag',
      );
    }
    const wipeFilament = wipeTowers.find((tower) => tower?.enabled && tower.filamentId)?.filamentId;
    const slot = wipeFilament ? filamentSlots.get(wipeFilament) : undefined;
    if (slot) config.wipe_tower_filament = slot;
  }
  const definitions = serializeMixedDefinitions(state, warnings);
  if (definitions) config.mixed_filament_definitions = definitions;
  return `${canonicalStringify(config)}\n`;
}

function buildLayerRanges(
  mappings: ObjectMapping[],
  filamentSlots: ReadonlyMap<FilamentId, number>,
): string | undefined {
  if (!mappings.some((mapping) => mapping.object.layerRanges.length > 0)) return undefined;
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<objects>'];
  for (const mapping of mappings) {
    if (mapping.object.layerRanges.length === 0) continue;
    lines.push(` <object id="${mapping.ordinal}">`);
    for (const range of mapping.object.layerRanges) {
      lines.push(`  <range min_z="${formatNumber(range.minZMm)}" max_z="${formatNumber(range.maxZMm)}">`);
      const config: ConfigMap = { ...range.config };
      if (range.filamentId) {
        const slot = filamentSlots.get(range.filamentId);
        if (slot) config.extruder = slot;
      }
      for (const [key, value] of Object.entries(config).sort(([left], [right]) => compareText(left, right))) {
        lines.push(`   <option opt_key="${xmlAttribute(key)}">${xmlText(bbsValue(value))}</option>`);
      }
      lines.push('  </range>');
    }
    lines.push(' </object>');
  }
  lines.push('</objects>', '');
  return lines.join('\n');
}

function decodeIndexedMesh(payload: AssetPayload): DecodedMesh {
  const mesh = payload.descriptor.mesh;
  if (payload.descriptor.kind !== 'mesh' || !mesh) throw new Error('asset is not an indexed mesh');
  if (mesh.positions.componentType !== 'float32' || mesh.positions.componentCount < 3) {
    throw new Error('positions must be float32 vectors with at least three components');
  }
  const view = new DataView(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength);
  const vertices: Array<readonly [number, number, number]> = [];
  const positionStride = mesh.positions.byteStride ?? mesh.positions.componentCount * 4;
  for (let index = 0; index < mesh.positions.count; index += 1) {
    const offset = mesh.positions.byteOffset + index * positionStride;
    const vertex: readonly [number, number, number] = [
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
    ];
    if (vertex.some((coordinate) => !Number.isFinite(coordinate))) {
      throw new Error('mesh contains a non-finite vertex');
    }
    vertices.push(vertex);
  }
  const indices: number[] = [];
  if (mesh.indices) {
    const componentBytes = mesh.indices.componentType === 'uint16' ? 2 : 4;
    if (mesh.indices.componentType !== 'uint16' && mesh.indices.componentType !== 'uint32') {
      throw new Error('indices must be uint16 or uint32');
    }
    const stride = mesh.indices.byteStride ?? componentBytes;
    for (let index = 0; index < mesh.indices.count; index += 1) {
      const offset = mesh.indices.byteOffset + index * stride;
      indices.push(componentBytes === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true));
    }
  } else {
    for (let index = 0; index < vertices.length; index += 1) indices.push(index);
  }
  if (indices.length % 3 !== 0 || indices.length / 3 !== mesh.triangleCount) {
    throw new Error('index count does not match the declared triangle count');
  }
  const triangles: Array<readonly [number, number, number]> = [];
  for (let index = 0; index < indices.length; index += 3) {
    const triangle: readonly [number, number, number] = [indices[index], indices[index + 1], indices[index + 2]];
    if (triangle.some((vertex) => vertex < 0 || vertex >= vertices.length)) {
      throw new Error('mesh index is outside the vertex buffer');
    }
    triangles.push(triangle);
  }
  return { vertices, triangles };
}

function annotationAttributes(
  annotations: FacetAnnotations,
  filamentSlots: ReadonlyMap<FilamentId, number>,
): Map<number, Map<string, string>> {
  const attributes = new Map<number, Map<string, string>>();
  addAnnotation(attributes, annotations.color, 'paint_color', (value) =>
    encodeFacetState(filamentSlots.get(value) ?? 0),
  );
  addAnnotation(attributes, annotations.support, 'paint_supports', (value) =>
    encodeFacetState(value === 'enforce' ? 1 : 2),
  );
  addAnnotation(attributes, annotations.seam, 'paint_seam', (value) => encodeFacetState(value === 'prefer' ? 1 : 2));
  addAnnotation(attributes, annotations.fuzzySkin, 'paint_fuzzy_skin', (value) => (value ? encodeFacetState(1) : ''));
  return attributes;
}

function addAnnotation<T extends JsonValue>(
  target: Map<number, Map<string, string>>,
  assignments: TriangleAssignments<T>[],
  name: string,
  encode: (value: T) => string,
): void {
  for (const assignment of assignments) {
    const encoded = encode(assignment.value);
    if (!encoded) continue;
    for (const triangle of assignment.triangles) {
      const values = target.get(triangle) ?? new Map<string, string>();
      values.set(name, encoded);
      target.set(triangle, values);
    }
  }
}

function collectCoreExtensionNamespaces(mappings: ObjectMapping[]): Set<string> {
  const namespaces = new Set<string>();
  const add = (attributes: ExtensionAttribute[]) => {
    for (const attribute of attributes) {
      if (attribute.namespace && attribute.namespace !== ORCAXR_CORE_NAMESPACE) {
        namespaces.add(attribute.namespace);
      }
    }
  };
  for (const mapping of mappings) {
    add(readExtensionAttributes(mapping.object.extensionData, CORE_OBJECT_ATTRIBUTES_KEY));
    for (const instance of mapping.object.instances) {
      add(readExtensionAttributes(instance.extensionData, CORE_BUILD_ATTRIBUTES_KEY));
    }
    for (const entry of mapping.volumes) {
      add(readExtensionAttributes(entry.volume.extensionData, CORE_OBJECT_ATTRIBUTES_KEY));
      add(readExtensionAttributes(entry.volume.extensionData, CORE_COMPONENT_ATTRIBUTES_KEY));
      for (const attributes of readFacetExtensionAttributes(
        entry.volume.extensionData,
        entry.volume.source.triangleCount,
      ).values()) {
        add(attributes);
      }
    }
  }
  return namespaces;
}

function renderExtensionAttributes(
  extensionData: Record<string, JsonValue> | undefined,
  key: string,
  namespacePrefixes: ReadonlyMap<string, string>,
  reservedUnqualified: ReadonlySet<string>,
): string {
  const rendered = new Map<string, string>();
  for (const attribute of readExtensionAttributes(extensionData, key)) {
    if (!attribute.namespace && reservedUnqualified.has(attribute.name)) continue;
    if (
      attribute.namespace === ORCAXR_CORE_NAMESPACE &&
      (attribute.name === 'stable-id' || attribute.name === 'instance-id')
    ) {
      continue;
    }
    const name = renderedExtensionName(attribute, namespacePrefixes);
    if (!name) continue;
    if (rendered.has(name)) throw new Error(`Duplicate preserved 3MF attribute ${name}`);
    rendered.set(name, attribute.value);
  }
  return [...rendered.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => ` ${name}="${xmlAttribute(value)}"`)
    .join('');
}

function renderedExtensionName(
  attribute: ExtensionAttribute,
  namespacePrefixes: ReadonlyMap<string, string>,
): string | undefined {
  assertXmlValue(attribute.value, `attribute ${attribute.name}`);
  if (!attribute.namespace) return attribute.name;
  if (attribute.namespace === ORCAXR_CORE_NAMESPACE) return `ox:${attribute.name}`;
  const prefix = namespacePrefixes.get(attribute.namespace);
  if (!prefix) throw new Error(`No XML prefix allocated for extension namespace ${attribute.namespace}`);
  return `${prefix}:${attribute.name}`;
}

function readExtensionAttributes(
  extensionData: Record<string, JsonValue> | undefined,
  key: string,
): ExtensionAttribute[] {
  return decodeExtensionAttributes(extensionData?.[key], key);
}

function decodeExtensionAttributes(raw: JsonValue | undefined, label: string): ExtensionAttribute[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  return raw.map((entry, index) => {
    if (
      entry === null ||
      Array.isArray(entry) ||
      typeof entry !== 'object' ||
      typeof entry.namespace !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.value !== 'string' ||
      !/^[A-Za-z_][\w.-]*$/.test(entry.name)
    ) {
      throw new Error(`Invalid preserved 3MF attribute at ${label}[${index}]`);
    }
    return { namespace: entry.namespace, name: entry.name, value: entry.value };
  });
}

function readFacetExtensionAttributes(
  extensionData: Record<string, JsonValue> | undefined,
  triangleCount: number,
): Map<number, ExtensionAttribute[]> {
  const raw = extensionData?.[CORE_FACET_ATTRIBUTES_KEY];
  const result = new Map<number, ExtensionAttribute[]>();
  if (raw === undefined) return result;
  if (!Array.isArray(raw)) throw new Error(`${CORE_FACET_ATTRIBUTES_KEY} must be an array`);
  raw.forEach((entry, index) => {
    if (
      entry === null ||
      Array.isArray(entry) ||
      typeof entry !== 'object' ||
      typeof entry.triangle !== 'number' ||
      !Number.isInteger(entry.triangle) ||
      entry.triangle < 0 ||
      entry.triangle >= triangleCount
    ) {
      throw new Error(`Invalid preserved facet metadata at index ${index}`);
    }
    const attributes = decodeExtensionAttributes(entry.attributes, `${CORE_FACET_ATTRIBUTES_KEY}[${index}].attributes`);
    const existing = result.get(entry.triangle) ?? [];
    result.set(entry.triangle, [...existing, ...attributes]);
  });
  return result;
}

function assertXmlValue(value: string, label: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new Error(`${label} contains a character XML 1.0 cannot represent`);
    }
  }
}

function encodeFacetState(state: number): string {
  if (!Number.isInteger(state) || state <= 0 || state > 18) return '';
  if (state <= 2) return (state << 2).toString(16).toUpperCase();
  return `${(state - 3).toString(16).toUpperCase()}C`;
}

function serializeMixedDefinitions(state: ProjectState, warnings: string[]): string {
  const physical = new Map<FilamentId, number>(state.filaments.physical.map((entry, index) => [entry.id, index + 1]));
  const rows: string[] = [];
  state.filaments.mixed.forEach((mixed) => {
    const ids = mixed.components.map((component) => physical.get(component.filamentId));
    if (ids.some((id) => id === undefined) || ids.length < 2) {
      warnings.push(
        `Mixed filament ${mixed.id} uses a nested or missing component and is preserved only in the OrcaXR extension`,
      );
      return;
    }
    const weights = mixed.components.map((component) => component.weight);
    const percentages = normalizedIntegerPercentages(weights);
    const a = ids[0]!;
    const b = ids[1]!;
    const mixB = Math.max(0, Math.min(100, percentages[1] ?? 50));
    const distribution = mixed.distribution.mode === 'cycle' ? 0 : 2;
    const gradientIds = encodePhysicalIds(ids as number[]);
    const stableId = stableNumericId(mixed.id);
    const uiMode =
      mixed.distribution.mode === 'ratio'
        ? 0
        : mixed.distribution.mode === 'cycle'
          ? 1
          : mixed.distribution.mode === 'match'
            ? 2
            : 3;
    let row = `${a},${b},${mixed.enabled ? 1 : 0},1,${mixB},0,g${gradientIds},w${percentages.join(
      '/',
    )},m${distribution},z0,xa0,xb0,d0,o0,u${stableId},cm${uiMode}`;
    if (mixed.distribution.mode === 'gradient') {
      const startTotal = mixed.distribution.startWeights.reduce((sum, weight) => sum + weight, 0);
      const endTotal = mixed.distribution.endWeights.reduce((sum, weight) => sum + weight, 0);
      const start = startTotal > 0 ? mixed.distribution.startWeights[0] / startTotal : 0.8;
      const end = endTotal > 0 ? mixed.distribution.endWeights[0] / endTotal : 0.2;
      row += `,r1/${start.toFixed(4)}/${end.toFixed(4)}`;
      warnings.push(
        `Mixed gradient ${mixed.id} has OrcaXR Z-range semantics that are retained in the extension; the BBS row is an approximate display/slicer projection`,
      );
    }
    if (mixed.distribution.mode === 'cycle') {
      const sequence: string[] = [];
      percentages.forEach((weight, componentIndex) => {
        const repeats = Math.max(1, Math.round(weight / 10));
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          sequence.push(String(ids[componentIndex]));
        }
      });
      row += `,${sequence.join('/')}`;
    }
    rows.push(row);
    if (mixed.distribution.mode === 'cycle') {
      warnings.push(
        `Mixed cycle ${mixed.id} retains its millimetre cycle length only in the OrcaXR extension; the BBS row carries an approximate layer pattern`,
      );
    } else if (mixed.distribution.mode === 'match') {
      warnings.push(
        `Mixed match-color target ${mixed.id} is retained in the OrcaXR extension; the BBS row carries its component weights and UI mode`,
      );
    }
  });
  return rows.join(';');
}

function transform3mf(transform: Transform): string {
  const matrix = transformMatrix(transform);
  return [
    matrix[0],
    matrix[4],
    matrix[8],
    matrix[1],
    matrix[5],
    matrix[9],
    matrix[2],
    matrix[6],
    matrix[10],
    matrix[3],
    matrix[7],
    matrix[11],
  ]
    .map(formatNumber)
    .join(' ');
}

function matrix4(transform: Transform): string {
  return transformMatrix(transform).map(formatNumber).join(' ');
}

function transformMatrix(transform: Transform): number[] {
  let [x, y, z, w] = transform.rotation;
  const norm = Math.hypot(x, y, z, w);
  x /= norm;
  y /= norm;
  z /= norm;
  w /= norm;
  const [sx, sy, sz] = transform.scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y - z * w) * sy,
    2 * (x * z + y * w) * sz,
    transform.translationMm[0],
    2 * (x * y + z * w) * sx,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z - x * w) * sz,
    transform.translationMm[1],
    2 * (x * z - y * w) * sx,
    2 * (y * z + x * w) * sy,
    (1 - 2 * (x * x + y * y)) * sz,
    transform.translationMm[2],
    0,
    0,
    0,
    1,
  ];
}

function volumeSubtype(role: VolumeRole): string {
  switch (role) {
    case 'model':
      return 'normal_part';
    case 'parameter-modifier':
      return 'modifier_part';
    case 'negative-volume':
      return 'negative_part';
    case 'support-enforcer':
      return 'support_enforcer';
    case 'support-blocker':
      return 'support_blocker';
  }
}

function appendConfig(lines: string[], config: ConfigMap, indent: number): void {
  for (const [key, value] of Object.entries(config).sort(([left], [right]) => compareText(left, right))) {
    lines.push(metadataLine(key, bbsValue(value), indent));
  }
}

function metadataLine(key: string, value: string | number, indent: number): string {
  return `${' '.repeat(indent)}<metadata key="${xmlAttribute(key)}" value="${xmlAttribute(String(value))}"/>`;
}

function bbsValue(value: JsonValue): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.map(bbsValue).join(';');
  if (typeof value === 'object') return canonicalStringify(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function normalizeColor(color: string): string {
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!match) return '#CCCCCCFF';
  return `#${match[1].toUpperCase()}${(match[2] ?? 'FF').toUpperCase()}`;
}

function stableNumericId(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return BigInt(`0x${fnv1a64(bytes)}`).toString(10);
}

function encodePhysicalIds(ids: number[]): string {
  return ids.some((id) => id > 9) ? ids.join('/') : ids.join('');
}

function normalizedIntegerPercentages(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (100 * weight) / total);
  const result = exact.map(Math.floor);
  const remainder = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) result[order[index % order.length].index] += 1;
  return result;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Cannot serialize a non-finite coordinate');
  return Object.is(value, -0) ? '0' : String(value);
}

function xmlAttribute(value: string): string {
  assertXmlValue(value, 'XML attribute');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}

function xmlText(value: string): string {
  assertXmlValue(value, 'XML text');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function emptyRelationships(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '</Relationships>',
    '',
  ].join('\n');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Imported-core DTOs and parser are below. Keeping them in this adapter means
// domain/history remain independent of XML, ZIP, BBS numeric IDs, and fflate.

interface ParsedMeshObject {
  numericId: number;
  name: string;
  materialIndex?: number;
  mesh?: DecodedMesh;
  components: Array<{
    objectId: number;
    transform: Transform;
    extensionAttributes: ExtensionAttribute[];
  }>;
  annotations: FacetAnnotations;
  extensionAttributes: ExtensionAttribute[];
  facetExtensionAttributes: FacetExtensionAttributes[];
}

interface ParsedBuildItem {
  objectId: number;
  transform: Transform;
  printable: boolean;
  extensionAttributes: ExtensionAttribute[];
}

interface ParsedModelMetadata {
  objectConfig: Map<number, ConfigMap>;
  objectNames: Map<number, string>;
  partData: Map<number, { role: VolumeRole; name?: string; config: ConfigMap }>;
  layerRanges: Map<number, Array<Omit<LayerRange, 'id'>>>;
  plates: Array<{
    name: string;
    printable: boolean;
    config: ConfigMap;
    assignments: Array<{ objectId: number; instanceIndex: number }>;
  }>;
}

export interface ImportedCoreProject {
  state: ProjectState;
  assets: AssetPayload[];
  consumedPaths: Set<string>;
  warnings: string[];
}

export function importBbsCore(files: ReadonlyMap<string, Uint8Array>, archiveHash: string): ImportedCoreProject {
  const modelBytes = files.get(CORE_MODEL_PATH);
  if (!modelBytes) throw new Error(`3MF is missing ${CORE_MODEL_PATH}`);
  const modelXml = decodeText(modelBytes, CORE_MODEL_PATH);
  const parsed = parseCoreModel(modelXml);
  const projectConfig = parseProjectSettings(files.get(PROJECT_SETTINGS_PATH));
  const modelMetadata = parseModelSettings(files.get(MODEL_SETTINGS_PATH));
  const layerRanges = parseLayerRanges(files.get(LAYER_RANGES_PATH));
  const warnings = [
    'Imported a 3MF without OrcaXR canonical metadata. Core geometry, transforms, basic BBS settings, plates, and simple whole-facet annotations were recovered; unsupported BBS fields remain preserved as opaque package entries.',
  ];
  const makeId = <Kind extends string>(kind: Kind, suffix: string) =>
    entityId<Kind>(`import:3mf:${archiveHash}-${kind}-${suffix}`);

  const colors =
    projectConfig.filamentColors.length > 0
      ? projectConfig.filamentColors
      : parsed.materials.length > 0
        ? parsed.materials.map((material) => material.color)
        : ['#CCCCCC'];
  const physical: PhysicalFilament[] = colors.map((color, index) => ({
    id: makeId('physical-filament', String(index + 1)),
    name: parsed.materials[index]?.name || `Imported tool ${index + 1}`,
    toolId: index,
    material: 'Unknown',
    color,
    config: {},
    enabled: true,
  }));
  for (const object of parsed.objects.values()) {
    object.annotations.color = object.annotations.color.flatMap((assignment) => {
      const match = /^import:3mf:paint-slot-(\d+)$/.exec(assignment.value);
      const filament = match ? physical[Number(match[1]) - 1] : undefined;
      return filament ? [{ ...assignment, value: filament.id }] : [];
    });
  }
  if (projectConfig.mixedDefinitions) {
    warnings.push(
      'Imported FullSpectrum definitions remain in project config and opaque source metadata; canonical mixed-row reconstruction is deferred to the native BBS adapter.',
    );
  }

  const assets: AssetPayload[] = [];
  const sourceAssets: SourceAssetDescriptor[] = [];
  const meshAssetIds = new Map<number, SourceAssetDescriptor['id']>();
  for (const object of parsed.objects.values()) {
    if (!object.mesh) continue;
    const bytes = encodeMeshAsset(object.mesh);
    const id = makeId('asset', String(object.numericId));
    const descriptor: SourceAssetDescriptor = {
      id,
      kind: 'mesh',
      digest: contentDigest(bytes),
      byteLength: bytes.byteLength,
      mediaType: 'application/vnd.orcaxr.indexed-mesh',
      provenance: { source: 'import', uri: `3mf:${CORE_MODEL_PATH}#${object.numericId}` },
      mesh: {
        positions: {
          byteOffset: 0,
          byteLength: object.mesh.vertices.length * 12,
          componentType: 'float32',
          componentCount: 3,
          count: object.mesh.vertices.length,
        },
        indices: {
          byteOffset: object.mesh.vertices.length * 12,
          byteLength: object.mesh.triangles.length * 12,
          componentType: 'uint32',
          componentCount: 1,
          count: object.mesh.triangles.length * 3,
        },
        triangleCount: object.mesh.triangles.length,
      },
    };
    meshAssetIds.set(object.numericId, id);
    sourceAssets.push(descriptor);
    assets.push({ descriptor, bytes });
  }

  const plateDefinitions =
    modelMetadata.plates.length > 0
      ? modelMetadata.plates
      : [{ name: 'Plate 1', printable: true, config: {}, assignments: [] }];
  const plateIds = plateDefinitions.map((_plate, index) => makeId('plate', String(index + 1)));
  const plates: ProjectPlate[] = plateDefinitions.map((plate, index) => ({
    id: plateIds[index],
    name: plate.name || `Plate ${index + 1}`,
    order: index,
    printable: plate.printable,
    config: cloneJson(plate.config),
    objects: [],
  }));

  const assignments = new Map<string, number>();
  plateDefinitions.forEach((plate, plateIndex) => {
    plate.assignments.forEach((assignment) => {
      assignments.set(`${assignment.objectId}:${assignment.instanceIndex}`, plateIndex);
    });
  });
  const buildByObject = new Map<number, ParsedBuildItem[]>();
  parsed.build.forEach((item) => {
    const list = buildByObject.get(item.objectId) ?? [];
    list.push(item);
    buildByObject.set(item.objectId, list);
  });
  let sourceObjectOrdinal = 0;
  for (const [parentId, buildItems] of buildByObject) {
    const parent = parsed.objects.get(parentId);
    if (!parent) continue;
    sourceObjectOrdinal += 1;
    const byPlate = new Map<number, Array<{ item: ParsedBuildItem; originalIndex: number }>>();
    buildItems.forEach((item, originalIndex) => {
      const plateIndex = assignments.get(`${parentId}:${originalIndex}`) ?? 0;
      const list = byPlate.get(plateIndex) ?? [];
      list.push({ item, originalIndex });
      byPlate.set(plateIndex, list);
    });
    for (const [plateIndex, itemRows] of byPlate) {
      const plate = plates[plateIndex] ?? plates[0];
      const objectId = makeId('object', `${parentId}-${plateIndex + 1}`);
      const componentRows =
        parent.components.length > 0
          ? parent.components
          : [{ objectId: parentId, transform: identityTransform(), extensionAttributes: [] }];
      const volumes: ProjectVolume[] = [];
      for (const component of componentRows) {
        const leaf = parsed.objects.get(component.objectId);
        const assetId = meshAssetIds.get(component.objectId);
        if (!leaf?.mesh || !assetId) continue;
        const part = modelMetadata.partData.get(component.objectId);
        let role = part?.role ?? 'model';
        if (componentRows.length === 1 && role !== 'model') {
          role = 'model';
          warnings.push(
            `Standalone BBS part ${component.objectId} had role ${part?.role}; imported as a model volume to preserve canonical object invariants`,
          );
        }
        const volumeConfig = cloneJson(part?.config ?? {});
        const requestedSlot = Number(volumeConfig.extruder);
        const filament = Number.isInteger(requestedSlot)
          ? physical[requestedSlot - 1]
          : leaf.materialIndex !== undefined
            ? physical[leaf.materialIndex]
            : undefined;
        if (filament) delete volumeConfig.extruder;
        const supportsFilament = role === 'model' || role === 'parameter-modifier';
        const volumeExtensionData: Record<string, JsonValue> = {};
        if (leaf.extensionAttributes.length > 0) {
          volumeExtensionData[CORE_OBJECT_ATTRIBUTES_KEY] = encodeExtensionAttributes(leaf.extensionAttributes);
        }
        if (component.extensionAttributes.length > 0) {
          volumeExtensionData[CORE_COMPONENT_ATTRIBUTES_KEY] = encodeExtensionAttributes(component.extensionAttributes);
        }
        if (leaf.facetExtensionAttributes.length > 0) {
          volumeExtensionData[CORE_FACET_ATTRIBUTES_KEY] = leaf.facetExtensionAttributes.map((row) => ({
            triangle: row.triangle,
            attributes: encodeExtensionAttributes(row.attributes),
          }));
        }
        volumes.push({
          id: makeId('volume', `${parentId}-${component.objectId}-${plateIndex + 1}`),
          name: part?.name ?? leaf.name ?? `Part ${component.objectId}`,
          role,
          source: {
            assetId,
            topologyRevision: 0,
            triangleCount: leaf.mesh.triangles.length,
          },
          transform: component.transform,
          config: volumeConfig,
          annotations: cloneJson(leaf.annotations),
          ...(filament && supportsFilament ? { filamentId: filament.id } : {}),
          ...(Object.keys(volumeExtensionData).length > 0 ? { extensionData: volumeExtensionData } : {}),
        });
      }
      if (volumes.length === 0) continue;
      const objectConfig = cloneJson(modelMetadata.objectConfig.get(parentId) ?? {});
      const importedRanges = layerRanges.get(sourceObjectOrdinal) ?? modelMetadata.layerRanges.get(parentId) ?? [];
      const ranges = importedRanges.map((range, index) => {
        const copy = cloneJson(range);
        const extruder = Number(copy.config.extruder);
        const filamentId = Number.isInteger(extruder) ? physical[extruder - 1]?.id : undefined;
        if (filamentId) delete copy.config.extruder;
        return {
          ...copy,
          id: makeId('layer-range', `${parentId}-${plateIndex + 1}-${index + 1}`),
          ...(filamentId ? { filamentId } : {}),
        };
      });
      const object: ProjectObject = {
        id: objectId,
        name: modelMetadata.objectNames.get(parentId) ?? parent.name ?? `Object ${parentId}`,
        config: objectConfig,
        volumes,
        instances: itemRows.map(({ item, originalIndex }) => ({
          id: makeId('instance', `${parentId}-${plateIndex + 1}-${originalIndex + 1}`),
          transform: item.transform,
          printable: item.printable,
          ...(item.extensionAttributes.length > 0
            ? {
                extensionData: {
                  [CORE_BUILD_ATTRIBUTES_KEY]: encodeExtensionAttributes(item.extensionAttributes),
                },
              }
            : {}),
        })),
        layerRanges: ranges,
        ...(parent.extensionAttributes.length > 0
          ? {
              extensionData: {
                [CORE_OBJECT_ATTRIBUTES_KEY]: encodeExtensionAttributes(parent.extensionAttributes),
              },
            }
          : {}),
      };
      const extruder = Number(objectConfig.extruder);
      if (Number.isInteger(extruder) && physical[extruder - 1]) {
        object.filamentId = physical[extruder - 1].id;
        delete object.config.extruder;
      }
      plate.objects.push(object);
    }
  }
  const state: ProjectState = {
    schemaVersion: 1,
    id: makeId('project', 'root'),
    name: parsed.title || 'Imported 3MF project',
    createdAt: '1980-01-01T00:00:00.000Z',
    updatedAt: '1980-01-01T00:00:00.000Z',
    printer: { toolCount: Math.max(1, physical.length) },
    config: projectConfig.config,
    activePlateId: plates[0].id,
    plates,
    filaments: { physical, mixed: [] },
    sourceAssets,
    customGcode: [],
    thumbnails: [],
    extensionBlobs: [],
  };
  const consumedPaths = new Set([CORE_MODEL_PATH]);
  if (files.has(PROJECT_SETTINGS_PATH)) consumedPaths.add(PROJECT_SETTINGS_PATH);
  if (files.has(MODEL_SETTINGS_PATH)) consumedPaths.add(MODEL_SETTINGS_PATH);
  if (files.has(LAYER_RANGES_PATH)) consumedPaths.add(LAYER_RANGES_PATH);
  return { state, assets, consumedPaths, warnings };
}

function parseCoreModel(xml: string): {
  title: string;
  materials: Array<{ name: string; color: string }>;
  objects: Map<number, ParsedMeshObject>;
  build: ParsedBuildItem[];
} {
  const namespaceMatch = /<model\b([^>]*)>/i.exec(xml);
  if (!namespaceMatch) throw new Error('3MF core is missing its model element');
  const namespaces = parseNamespaces(namespaceMatch[1]);
  const title = decodeXml(/<metadata\b[^>]*name=["']Title["'][^>]*>([\s\S]*?)<\/metadata>/i.exec(xml)?.[1] ?? '');
  const materials = [...xml.matchAll(/<base\b([^>]*)\/?\s*>/gi)].map((base, index) => {
    const attributes = parseAttributes(base[1]);
    return {
      name: attributes.name ? decodeXml(attributes.name) : `Imported tool ${index + 1}`,
      color: normalizeColor(attributes.displaycolor ?? '#CCCCCC').slice(0, 7),
    };
  });
  const objects = new Map<number, ParsedMeshObject>();
  for (const match of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const attributes = parseAttributes(match[1]);
    const numericId = Number(attributes.id);
    if (!Number.isInteger(numericId) || numericId < 1 || objects.has(numericId)) {
      throw new Error(`Invalid or duplicate 3MF object ID ${attributes.id ?? ''}`);
    }
    const body = match[2];
    const meshMatch = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/i.exec(body);
    const mesh = meshMatch ? parseMesh(meshMatch[1], namespaces) : undefined;
    const components = [...body.matchAll(/<component\b([^>]*)\/?\s*>/gi)].map((component) => {
      const attrs = parseAttributes(component[1]);
      const objectId = Number(attrs.objectid);
      if (!Number.isInteger(objectId) || objectId < 1) {
        throw new Error(`3MF component references invalid object ID ${attrs.objectid ?? ''}`);
      }
      return {
        objectId,
        transform: parseTransform3mf(attrs.transform),
        extensionAttributes: parseExtensionAttributes(component[1], namespaces, ['objectid', 'transform']),
      };
    });
    objects.set(numericId, {
      numericId,
      name: attributes.name ? decodeXml(attributes.name) : `Object ${numericId}`,
      ...(Number.isInteger(Number(attributes.pindex)) && Number(attributes.pindex) >= 0
        ? { materialIndex: Number(attributes.pindex) }
        : {}),
      mesh,
      components,
      annotations: mesh?.annotations ?? emptyFacetAnnotations(0),
      extensionAttributes: parseExtensionAttributes(match[1], namespaces, [
        'id',
        'type',
        'name',
        'pid',
        'pindex',
        'thumbnail',
        'partnumber',
      ]),
      facetExtensionAttributes: mesh?.facetExtensionAttributes ?? [],
    });
  }
  const buildBody = /<build\b[^>]*>([\s\S]*?)<\/build>/i.exec(xml)?.[1] ?? '';
  const build = [...buildBody.matchAll(/<item\b([^>]*)\/?\s*>/gi)].map((item) => {
    const attributes = parseAttributes(item[1]);
    const objectId = Number(attributes.objectid);
    if (!Number.isInteger(objectId) || objectId < 1) {
      throw new Error(`3MF build item references invalid object ID ${attributes.objectid ?? ''}`);
    }
    return {
      objectId,
      transform: parseTransform3mf(attributes.transform),
      printable: attributes.printable !== '0',
      extensionAttributes: parseExtensionAttributes(item[1], namespaces, ['objectid', 'transform', 'printable']),
    };
  });
  if (!/<build\b/i.test(xml)) throw new Error('3MF core is missing its build element');
  for (const object of objects.values()) {
    for (const component of object.components) {
      if (!objects.has(component.objectId)) {
        throw new Error(`3MF component references missing object ${component.objectId}`);
      }
    }
  }
  for (const item of build) {
    if (!objects.has(item.objectId)) throw new Error(`3MF build references missing object ${item.objectId}`);
  }
  return { title, materials, objects, build };
}

function parseMesh(
  body: string,
  namespaces: ReadonlyMap<string, string>,
): DecodedMesh & {
  annotations: FacetAnnotations;
  facetExtensionAttributes: FacetExtensionAttributes[];
} {
  const vertices = [...body.matchAll(/<vertex\b([^>]*)\/?\s*>/gi)].map((vertex) => {
    const attrs = parseAttributes(vertex[1]);
    const value: readonly [number, number, number] = [Number(attrs.x), Number(attrs.y), Number(attrs.z)];
    if (value.some((coordinate) => !Number.isFinite(coordinate))) {
      throw new Error('3MF vertex has a non-finite coordinate');
    }
    return value;
  });
  const annotations = emptyFacetAnnotations(0);
  const facetExtensionAttributes: FacetExtensionAttributes[] = [];
  const triangles = [...body.matchAll(/<triangle\b([^>]*)\/?\s*>/gi)].map((triangle, triangleIndex) => {
    const attrs = parseAttributes(triangle[1]);
    const value: readonly [number, number, number] = [Number(attrs.v1), Number(attrs.v2), Number(attrs.v3)];
    if (value.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices.length)) {
      throw new Error('3MF triangle references an invalid vertex');
    }
    importSimpleFacet(annotations.color, triangleIndex, attrs.paint_color, (state) =>
      entityId<'physical-filament'>(`import:3mf:paint-slot-${state}`),
    );
    importSimpleFacet(annotations.support, triangleIndex, attrs.paint_supports, (state) =>
      state === 1 ? 'enforce' : 'block',
    );
    importSimpleFacet(annotations.seam, triangleIndex, attrs.paint_seam ?? attrs.seam, (state) =>
      state === 1 ? 'prefer' : 'avoid',
    );
    importSimpleFacet(annotations.fuzzySkin, triangleIndex, attrs.paint_fuzzy_skin ?? attrs.fuzzy_skin, () => true);
    const extensionAttributes = parseExtensionAttributes(triangle[1], namespaces, ['v1', 'v2', 'v3']);
    if (extensionAttributes.length > 0) {
      facetExtensionAttributes.push({ triangle: triangleIndex, attributes: extensionAttributes });
    }
    return value;
  });
  return { vertices, triangles, annotations, facetExtensionAttributes };
}

function parseProjectSettings(bytes: Uint8Array | undefined): {
  config: ConfigMap;
  filamentColors: string[];
  mixedDefinitions?: string;
} {
  if (!bytes) return { config: {}, filamentColors: [] };
  const text = decodeText(bytes, PROJECT_SETTINGS_PATH).trim();
  const config = Object.create(null) as ConfigMap;
  if (text.startsWith('{')) {
    const parsed: unknown = JSON.parse(text);
    assertSafeJsonTree(parsed, PROJECT_SETTINGS_PATH);
    if (!isRecord(parsed)) throw new Error(`${PROJECT_SETTINGS_PATH} must contain a JSON object`);
    for (const [key, value] of Object.entries(parsed)) {
      if (!['type', 'name', 'from', 'version', 'inherits'].includes(key)) {
        assignConfigValue(config, key, value as JsonValue, PROJECT_SETTINGS_PATH);
      }
    }
  } else {
    for (const match of text.matchAll(/<setting\b([^>]*)\/?\s*>/gi)) {
      const attrs = parseAttributes(match[1]);
      if (attrs.key) {
        assignConfigValue(config, attrs.key, parseScalar(decodeXml(attrs.value ?? '')), PROJECT_SETTINGS_PATH);
      }
    }
  }
  const rawColors = config.filament_colour ?? config.extruder_colour;
  const filamentColors = Array.isArray(rawColors)
    ? rawColors.filter((value): value is string => typeof value === 'string')
    : typeof rawColors === 'string'
      ? rawColors.split(';').filter(Boolean)
      : [];
  return {
    config,
    filamentColors,
    mixedDefinitions:
      typeof config.mixed_filament_definitions === 'string' ? config.mixed_filament_definitions : undefined,
  };
}

function parseModelSettings(bytes: Uint8Array | undefined): ParsedModelMetadata {
  const result: ParsedModelMetadata = {
    objectConfig: new Map(),
    objectNames: new Map(),
    partData: new Map(),
    layerRanges: new Map(),
    plates: [],
  };
  if (!bytes) return result;
  const xml = decodeText(bytes, MODEL_SETTINGS_PATH);
  for (const objectMatch of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const attrs = parseAttributes(objectMatch[1]);
    const objectId = Number(attrs.id);
    if (!Number.isInteger(objectId)) continue;
    const body = objectMatch[2];
    const objectPrefix = body.split(/<part\b/i, 1)[0];
    const config = parseMetadataConfig(objectPrefix);
    if (typeof config.name === 'string') {
      result.objectNames.set(objectId, config.name);
      delete config.name;
    }
    result.objectConfig.set(objectId, config);
    for (const partMatch of body.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/gi)) {
      const partAttrs = parseAttributes(partMatch[1]);
      const partId = Number(partAttrs.id);
      if (!Number.isInteger(partId)) continue;
      const partConfig = parseMetadataConfig(partMatch[2]);
      const name = typeof partConfig.name === 'string' ? partConfig.name : undefined;
      delete partConfig.name;
      delete partConfig.matrix;
      result.partData.set(partId, {
        role: roleFromSubtype(partAttrs.subtype),
        name,
        config: partConfig,
      });
    }
    const ranges: Array<Omit<LayerRange, 'id'>> = [];
    for (const rangeMatch of body.matchAll(/<layer_range\b([^>]*)>([\s\S]*?)<\/layer_range>/gi)) {
      const rangeAttrs = parseAttributes(rangeMatch[1]);
      ranges.push({
        minZMm: Number(rangeAttrs.min_z),
        maxZMm: Number(rangeAttrs.max_z),
        config: parseMetadataConfig(rangeMatch[2]),
      });
    }
    if (ranges.length > 0) result.layerRanges.set(objectId, ranges);
  }
  for (const plateMatch of xml.matchAll(/<plate\b([^>]*)>([\s\S]*?)<\/plate>/gi)) {
    const attrs = parseAttributes(plateMatch[1]);
    const plateConfigXml = plateMatch[2].replace(
      /<model_instance\b[^>]*\/>|<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/gi,
      '',
    );
    const config = parseMetadataConfig(plateConfigXml);
    const assignments: Array<{ objectId: number; instanceIndex: number }> = [];
    for (const instance of plateMatch[2].matchAll(
      /<model_instance\b([^>]*)\/?\s*>([\s\S]*?)<\/model_instance>|<model_instance\b([^>]*)\/>/gi,
    )) {
      const direct = parseAttributes(instance[1] ?? instance[3] ?? '');
      const nested = parseMetadataConfig(instance[2] ?? '');
      const objectId = Number(direct.object_id ?? nested.object_id);
      const instanceIndex = Number(direct.instance_id ?? nested.instance_id ?? 0);
      if (Number.isInteger(objectId) && Number.isInteger(instanceIndex)) {
        assignments.push({ objectId, instanceIndex });
      }
    }
    result.plates.push({
      name: String(attrs.name ?? config.plater_name ?? `Plate ${result.plates.length + 1}`),
      printable: String(attrs.printable ?? config.printable ?? '1') !== '0',
      config: plateConfig(config, attrs),
      assignments,
    });
  }
  return result;
}

function plateConfig(config: ConfigMap, attributes: Record<string, string>): ConfigMap {
  const result = cloneJson(config);
  delete result.plater_id;
  delete result.plater_name;
  delete result.printable;
  if (attributes.locked !== undefined) result.locked = parseScalar(attributes.locked);
  else if (config.locked !== undefined) result.locked = config.locked;
  return result;
}

function parseLayerRanges(bytes: Uint8Array | undefined): Map<number, Array<Omit<LayerRange, 'id'>>> {
  const result = new Map<number, Array<Omit<LayerRange, 'id'>>>();
  if (!bytes) return result;
  const xml = decodeText(bytes, LAYER_RANGES_PATH);
  for (const objectMatch of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const objectId = Number(parseAttributes(objectMatch[1]).id);
    if (!Number.isInteger(objectId)) continue;
    const ranges: Array<Omit<LayerRange, 'id'>> = [];
    for (const rangeMatch of objectMatch[2].matchAll(/<range\b([^>]*)>([\s\S]*?)<\/range>/gi)) {
      const attrs = parseAttributes(rangeMatch[1]);
      const config = Object.create(null) as ConfigMap;
      for (const option of rangeMatch[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
        const optionAttrs = parseAttributes(option[1]);
        if (optionAttrs.opt_key) {
          assignConfigValue(config, optionAttrs.opt_key, parseScalar(decodeXml(option[2])), LAYER_RANGES_PATH);
        }
      }
      ranges.push({
        minZMm: Number(attrs.min_z),
        maxZMm: Number(attrs.max_z),
        config,
      });
    }
    result.set(objectId, ranges);
  }
  return result;
}

function parseMetadataConfig(xml: string): ConfigMap {
  const config = Object.create(null) as ConfigMap;
  for (const metadata of xml.matchAll(/<metadata\b([^>]*)\/?\s*>/gi)) {
    const attrs = parseAttributes(metadata[1]);
    if (attrs.key) assignConfigValue(config, attrs.key, parseScalar(decodeXml(attrs.value ?? '')), MODEL_SETTINGS_PATH);
  }
  return config;
}

function encodeMeshAsset(mesh: DecodedMesh): Uint8Array {
  const positionBytes = mesh.vertices.length * 12;
  const bytes = new Uint8Array(positionBytes + mesh.triangles.length * 12);
  const view = new DataView(bytes.buffer);
  mesh.vertices.forEach((vertex, index) => {
    const offset = index * 12;
    view.setFloat32(offset, vertex[0], true);
    view.setFloat32(offset + 4, vertex[1], true);
    view.setFloat32(offset + 8, vertex[2], true);
  });
  mesh.triangles.forEach((triangle, index) => {
    const offset = positionBytes + index * 12;
    view.setUint32(offset, triangle[0], true);
    view.setUint32(offset + 4, triangle[1], true);
    view.setUint32(offset + 8, triangle[2], true);
  });
  return bytes;
}

function parseTransform3mf(value: string | undefined): Transform {
  if (!value) return identityTransform();
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('Invalid 3MF transform');
  }
  const matrix = [
    parts[0],
    parts[3],
    parts[6],
    parts[9],
    parts[1],
    parts[4],
    parts[7],
    parts[10],
    parts[2],
    parts[5],
    parts[8],
    parts[11],
    0,
    0,
    0,
    1,
  ];
  return decomposeMatrix(matrix);
}

function decomposeMatrix(matrix: number[]): Transform {
  let sx = Math.hypot(matrix[0], matrix[4], matrix[8]);
  const sy = Math.hypot(matrix[1], matrix[5], matrix[9]);
  const sz = Math.hypot(matrix[2], matrix[6], matrix[10]);
  const determinant =
    matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
    matrix[1] * (matrix[4] * matrix[10] - matrix[6] * matrix[8]) +
    matrix[2] * (matrix[4] * matrix[9] - matrix[5] * matrix[8]);
  if (determinant < 0) sx = -sx;
  if (Math.abs(sx) < 1e-12 || sy < 1e-12 || sz < 1e-12) {
    throw new Error('3MF transform is non-invertible');
  }
  const m00 = matrix[0] / sx;
  const m01 = matrix[1] / sy;
  const m02 = matrix[2] / sz;
  const m10 = matrix[4] / sx;
  const m11 = matrix[5] / sy;
  const m12 = matrix[6] / sz;
  const m20 = matrix[8] / sx;
  const m21 = matrix[9] / sy;
  const m22 = matrix[10] / sz;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return {
    translationMm: [matrix[3], matrix[7], matrix[11]],
    rotation: [x, y, z, w],
    scale: [sx, sy, sz],
  };
}

function importSimpleFacet<T extends JsonValue>(
  assignments: TriangleAssignments<T>[],
  triangle: number,
  encoded: string | undefined,
  value: (state: number) => T,
): void {
  const state = decodeSimpleFacetState(encoded);
  if (state > 0) assignments.push({ triangles: [triangle], value: value(state) });
}

function decodeSimpleFacetState(encoded: string | undefined): number {
  if (!encoded || !/^[0-9a-f]+$/i.test(encoded)) return 0;
  const reversed = [...encoded].reverse().map((digit) => Number.parseInt(digit, 16));
  const code = reversed[0];
  if ((code & 3) !== 0) return 0;
  if ((code & 0xc) === 0xc) return reversed.length === 2 ? reversed[1] + 3 : 0;
  return reversed.length === 1 ? code >> 2 : 0;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes = Object.create(null) as Record<string, string>;
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (Object.hasOwn(attributes, match[1])) throw new Error(`Duplicate XML attribute ${match[1]}`);
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function parseNamespaces(source: string): Map<string, string> {
  const namespaces = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);
  for (const [name, value] of Object.entries(parseAttributes(source))) {
    if (name === 'xmlns') namespaces.set('', value);
    else if (name.startsWith('xmlns:')) namespaces.set(name.slice(6), value);
  }
  return namespaces;
}

function parseExtensionAttributes(
  source: string,
  namespaces: ReadonlyMap<string, string>,
  knownUnqualified: string[],
): ExtensionAttribute[] {
  const known = new Set(knownUnqualified);
  const output: ExtensionAttribute[] = [];
  for (const [qualifiedName, value] of Object.entries(parseAttributes(source))) {
    if (qualifiedName === 'xmlns' || qualifiedName.startsWith('xmlns:')) continue;
    const colon = qualifiedName.indexOf(':');
    if (colon < 0) {
      if (!known.has(qualifiedName)) output.push({ namespace: '', name: qualifiedName, value });
      continue;
    }
    const prefix = qualifiedName.slice(0, colon);
    const name = qualifiedName.slice(colon + 1);
    const namespace = namespaces.get(prefix);
    if (!namespace) throw new Error(`3MF attribute ${qualifiedName} uses an undeclared namespace prefix`);
    if (namespace === 'http://www.w3.org/XML/1998/namespace') continue;
    output.push({ namespace, name, value });
  }
  return output;
}

function encodeExtensionAttributes(attributes: ExtensionAttribute[]): JsonValue[] {
  return attributes.map((attribute) => ({
    namespace: attribute.namespace,
    name: attribute.name,
    value: attribute.value,
  }));
}

function roleFromSubtype(value: string | undefined): VolumeRole {
  switch (value) {
    case 'modifier':
    case 'modifier_part':
      return 'parameter-modifier';
    case 'negative_volume':
    case 'negative_part':
      return 'negative-volume';
    case 'support_enforcer':
      return 'support-enforcer';
    case 'support_blocker':
      return 'support-blocker';
    default:
      return 'model';
  }
}

function parseScalar(value: string): JsonValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function assignConfigValue(config: ConfigMap, key: string, value: JsonValue, path: string): void {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
    throw new Error(`${path} contains unsafe configuration key ${key}`);
  }
  config[key] = value;
}

function assertSafeJsonTree(root: unknown, label: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > 1_000_000) throw new Error(`${label} exceeds the JSON node limit`);
    if (depth > 256) throw new Error(`${label} exceeds the JSON nesting limit`);
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains unsafe object key ${key}`);
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
  }
}

function decodeXml(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hex: string | undefined) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      switch (entity.toLowerCase()) {
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&apos;':
          return "'";
        default:
          return entity;
      }
    },
  );
}
