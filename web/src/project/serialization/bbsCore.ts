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
import { emptyFacetAnnotations } from '../domain/model';
import { importFullSpectrumDefinitions } from '../filaments/fullSpectrumImport';
import { serializeFullSpectrumDefinition } from '../filaments/fullSpectrumRecipe';
import { decodeIndexedMeshAsset, type DecodedIndexedMesh } from '../meshCodec';
import { validatePackagePath } from './deterministicZip';

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
const BBS_PLATE_GAP_RATIO = 0.2;
const PRODUCTION_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const MAX_COMPONENT_GRAPH_DEPTH = 64;
const MAX_COMPONENT_GRAPH_EXPANSION = 16_384;

export type BbsPlateCoordinateErrorCode = 'invalid-plate-metadata' | 'missing-printable-area' | 'unassigned-build-item';

/**
 * A BBS archive declared virtual plates, but their global build coordinates
 * could not be converted to canonical plate-local printer coordinates safely.
 */
export class BbsPlateCoordinateError extends Error {
  override readonly name = 'BbsPlateCoordinateError';

  constructor(
    readonly code: BbsPlateCoordinateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

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

/**
 * Lightweight view of BBS/Orca plate membership used while the legacy live
 * workspace is being migrated onto ProjectState. Build item indices are in
 * the exact order of the core 3MF <build>, which is also the order emitted by
 * ThreeMFLoader at its root.
 */
export interface BbsPlateLayout {
  buildItemCount: number;
  bedSizeMm?: { x: number; y: number };
  plates: Array<{
    sourceId: number;
    name: string;
    buildItemIndices: number[];
    originMm?: { x: number; y: number };
  }>;
  unassignedBuildItemIndices: number[];
}

export type BbsPlateLayoutExtraction =
  | { status: 'absent'; layout: null }
  | { status: 'invalid'; layout: null }
  | { status: 'valid'; layout: BbsPlateLayout };

/**
 * Read official Orca/BBS multi-plate membership without decoding the meshes.
 * Membership lives in Metadata/model_settings.config as
 * (object_id, instance_id) pairs; it must not be guessed from thumbnails or
 * the spatial clusters in the core model.
 */
export function extractBbsPlateLayout(files: ReadonlyMap<string, Uint8Array>): BbsPlateLayout | null {
  return extractBbsPlateLayoutResult(files).layout;
}

/** Distinguish an ordinary file with no plate declarations from metadata we cannot trust. */
export function extractBbsPlateLayoutResult(files: ReadonlyMap<string, Uint8Array>): BbsPlateLayoutExtraction {
  const settingsBytes = files.get(MODEL_SETTINGS_PATH);
  if (!settingsBytes) return { status: 'absent', layout: null };

  let declaredPlateCount: number;
  try {
    const settingsXml = decodeText(settingsBytes, MODEL_SETTINGS_PATH);
    declaredPlateCount = [...settingsXml.matchAll(/<plate\b/gi)].length;
  } catch {
    return { status: 'invalid', layout: null };
  }
  if (declaredPlateCount === 0) return { status: 'absent', layout: null };

  try {
    const layout = extractBbsPlateLayoutUnchecked(files);
    if (!layout || layout.plates.length !== declaredPlateCount) return { status: 'invalid', layout: null };
    return { status: 'valid', layout };
  } catch {
    return { status: 'invalid', layout: null };
  }
}

function extractBbsPlateLayoutUnchecked(files: ReadonlyMap<string, Uint8Array>): BbsPlateLayout | null {
  const modelBytes = files.get(CORE_MODEL_PATH);
  const settingsBytes = files.get(MODEL_SETTINGS_PATH);
  if (!modelBytes || !settingsBytes) return null;

  const modelXml = decodeText(modelBytes, CORE_MODEL_PATH);
  const buildBody = /<build\b[^>]*>([\s\S]*?)<\/build>/i.exec(modelXml)?.[1];
  if (buildBody === undefined) return null;
  const buildObjectIds = [...buildBody.matchAll(/<item\b([^>]*)\/?\s*>/gi)].map((item) => {
    const objectId = Number(parseAttributes(item[1]).objectid);
    return Number.isInteger(objectId) && objectId >= 1 ? objectId : undefined;
  });
  if (buildObjectIds.length === 0 || buildObjectIds.some((objectId) => objectId === undefined)) return null;

  const metadata = parseModelSettings(settingsBytes);
  if (metadata.plates.length === 0) return null;
  const orderedMetadata = [...metadata.plates].sort((left, right) => left.sourceId - right.sourceId);
  if (orderedMetadata.some((plate, index) => !plate.sourceIdValid || plate.sourceId !== index + 1)) {
    throw new Error('BBS plater_id values must be unique and contiguous from 1');
  }
  const plates: BbsPlateLayout['plates'] = orderedMetadata.map((plate, index) => ({
    sourceId: plate.sourceId,
    name: plate.name || `Plate ${index + 1}`,
    buildItemIndices: [],
  }));

  const assignmentByInstance = new Map<string, number>();
  const conflictingAssignments = new Set<string>();
  const assignmentPlatesByObject = new Map<number, Set<number>>();
  orderedMetadata.forEach((plate, plateIndex) => {
    for (const assignment of plate.assignments) {
      const key = `${assignment.objectId}:${assignment.instanceIndex}`;
      const previousPlate = assignmentByInstance.get(key);
      if (previousPlate === undefined && !conflictingAssignments.has(key)) assignmentByInstance.set(key, plateIndex);
      else if (previousPlate !== undefined && previousPlate !== plateIndex) {
        assignmentByInstance.delete(key);
        conflictingAssignments.add(key);
      }
      const objectPlates = assignmentPlatesByObject.get(assignment.objectId) ?? new Set<number>();
      objectPlates.add(plateIndex);
      assignmentPlatesByObject.set(assignment.objectId, objectPlates);
    }
  });

  const instanceIndexByObject = new Map<number, number>();
  const unassignedBuildItemIndices: number[] = [];
  buildObjectIds.forEach((objectIdValue, buildItemIndex) => {
    const objectId = objectIdValue!;
    const instanceIndex = instanceIndexByObject.get(objectId) ?? 0;
    instanceIndexByObject.set(objectId, instanceIndex + 1);
    let plateIndex = assignmentByInstance.get(`${objectId}:${instanceIndex}`);
    // Some producers omit or renumber instance_id while still assigning every
    // occurrence of an object to one plate. Use that unambiguous object-level
    // fallback, but never guess when an object spans multiple plates.
    if (plateIndex === undefined) {
      const candidates = assignmentPlatesByObject.get(objectId);
      if (candidates?.size === 1) plateIndex = candidates.values().next().value;
    }
    if (plateIndex === undefined || !plates[plateIndex]) unassignedBuildItemIndices.push(buildItemIndex);
    else plates[plateIndex].buildItemIndices.push(buildItemIndex);
  });

  const project = parseProjectSettings(files.get(PROJECT_SETTINGS_PATH));
  const bedSizeMm = printableAreaSize(project.config.printable_area);
  if (bedSizeMm) {
    const origins = bbsVirtualPlateOrigins(plates.length, bedSizeMm);
    plates.forEach((plate, index) => {
      plate.originMm = origins[index];
    });
  } else if (plates.length === 1) {
    plates[0].originMm = { x: 0, y: 0 };
  }

  return {
    buildItemCount: buildObjectIds.length,
    ...(bedSizeMm ? { bedSizeMm } : {}),
    plates,
    unassignedBuildItemIndices,
  };
}

interface VolumeMapping {
  volume: ProjectVolume;
  numericId: number;
  mesh?: DecodedIndexedMesh;
}

interface ObjectMapping {
  object: ProjectObject;
  plate: ProjectPlate;
  plateOriginMm: { x: number; y: number };
  ordinal: number;
  parentId: number;
  volumes: VolumeMapping[];
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

function canonicalPlateOrigins(
  state: ProjectState,
  orderedPlates: readonly ProjectPlate[],
): Array<{ x: number; y: number }> {
  if (orderedPlates.length <= 1) return orderedPlates.map(() => ({ x: 0, y: 0 }));
  const bedSizeMm = printableAreaSize(state.config.printable_area);
  const needsVirtualOrigin = orderedPlates.some(
    (plate, index) => index > 0 && plate.objects.some((object) => object.instances.length > 0),
  );
  if (!bedSizeMm) {
    if (needsVirtualOrigin) {
      throw new BbsPlateCoordinateError(
        'missing-printable-area',
        `Cannot project ${orderedPlates.length} canonical plates into BBS global build coordinates: project config has no valid printable_area`,
      );
    }
    return orderedPlates.map(() => ({ x: 0, y: 0 }));
  }
  return bbsVirtualPlateOrigins(orderedPlates.length, bedSizeMm);
}

export function buildBbsCore(state: ProjectState, assets: ReadonlyMap<string, AssetPayload>): BbsCoreBuild {
  const warnings: string[] = [];
  const mappings: ObjectMapping[] = [];
  let nextNumericId = 1;
  let ordinal = 0;
  const orderedPlates = [...state.plates].sort((left, right) => left.order - right.order);
  const plateOrigins = canonicalPlateOrigins(state, orderedPlates);
  for (const [plateIndex, plate] of orderedPlates.entries()) {
    for (const object of plate.objects) {
      ordinal += 1;
      const volumes: VolumeMapping[] = object.volumes.map((volume) => {
        const numericId = nextNumericId++;
        const payload = assets.get(volume.source.assetId);
        let mesh: DecodedIndexedMesh | undefined;
        if (!payload) {
          warnings.push(`Volume ${volume.id} has no source asset; omitted from standard 3MF core`);
        } else {
          try {
            mesh = decodeIndexedMeshAsset(payload);
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
      mappings.push({
        object,
        plate,
        plateOriginMm: plateOrigins[plateIndex],
        ordinal,
        parentId: nextNumericId++,
        volumes,
      });
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
  files.set(MODEL_SETTINGS_PATH, encodeText(buildModelSettings(orderedPlates, mappings, filamentSlots)));
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
          mapping.plateOriginMm,
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

function buildModelSettings(
  orderedPlates: readonly ProjectPlate[],
  mappings: ObjectMapping[],
  filamentSlots: ReadonlyMap<FilamentId, number>,
): string {
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
  applyFilamentVectors(config, state);
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
  for (const [key, value] of Object.entries(config)) config[key] = bbsConfigValue(value);
  return `${canonicalStringify(config)}\n`;
}

/**
 * Per-filament option keys, ported verbatim from the pinned engine's
 * `s_Preset_filament_options` (Snapmaker Orca v2.3.4,
 * `src/libslic3r/Preset.cpp`), minus the compatibility and inheritance entries
 * the engine itself skips when it resizes a filament vector.
 *
 * Writing any of these as a scalar is not cosmetic: the engine derives the
 * filament count from `filament_diameter.size()`, and one entry there clamps
 * every per-object extruder assignment back to tool 1, so a multicolor plate
 * silently prints in a single colour.
 */
const FILAMENT_VECTOR_KEYS: readonly string[] = [
  'activate_air_filtration',
  'activate_chamber_temp_control',
  'adaptive_pressure_advance',
  'adaptive_pressure_advance_bridges',
  'adaptive_pressure_advance_model',
  'adaptive_pressure_advance_overhangs',
  'additional_cooling_fan_speed',
  'chamber_temperature',
  'close_fan_the_first_x_layers',
  'complete_print_exhaust_fan_speed',
  'cool_plate_temp',
  'cool_plate_temp_initial_layer',
  'default_filament_colour',
  'dont_slow_down_outer_wall',
  'during_print_exhaust_fan_speed',
  'enable_overhang_bridge_fan',
  'enable_pressure_advance',
  'eng_plate_temp',
  'eng_plate_temp_initial_layer',
  'fan_cooling_layer_time',
  'fan_max_speed',
  'fan_min_speed',
  'filament_cooling_final_speed',
  'filament_cooling_initial_speed',
  'filament_cooling_moves',
  'filament_cost',
  'filament_density',
  'filament_deretraction_speed',
  'filament_diameter',
  'filament_end_gcode',
  'filament_flow_ratio',
  'filament_is_support',
  'filament_loading_speed',
  'filament_loading_speed_start',
  'filament_long_retractions_when_cut',
  'filament_max_volumetric_speed',
  'filament_minimal_purge_on_wipe_tower',
  'filament_multitool_ramming',
  'filament_multitool_ramming_flow',
  'filament_multitool_ramming_volume',
  'filament_notes',
  'filament_ramming_parameters',
  'filament_retract_before_wipe',
  'filament_retract_length_toolchange',
  'filament_retract_lift_above',
  'filament_retract_lift_below',
  'filament_retract_lift_enforce',
  'filament_retract_restart_extra',
  'filament_retract_restart_extra_toolchange',
  'filament_retract_when_changing_layer',
  'filament_retraction_distances_when_cut',
  'filament_retraction_length',
  'filament_retraction_minimum_travel',
  'filament_retraction_speed',
  'filament_shrink',
  'filament_shrinkage_compensation_z',
  'filament_soluble',
  'filament_stamping_distance',
  'filament_stamping_loading_speed',
  'filament_start_gcode',
  'filament_toolchange_delay',
  'filament_type',
  'filament_unloading_speed',
  'filament_unloading_speed_start',
  'filament_vendor',
  'filament_wipe',
  'filament_wipe_distance',
  'filament_z_hop',
  'filament_z_hop_types',
  'full_fan_speed_layer',
  'graphic_effect_plate_temp',
  'graphic_effect_plate_temp_initial_layer',
  'hot_plate_temp',
  'hot_plate_temp_initial_layer',
  'idle_temperature',
  'internal_bridge_fan_speed',
  'ironing_fan_speed',
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
  'nozzle_temperature_range_high',
  'nozzle_temperature_range_low',
  'overhang_fan_speed',
  'overhang_fan_threshold',
  'pellet_flow_coefficient',
  'pressure_advance',
  'reduce_fan_stop_start_freq',
  'required_nozzle_HRC',
  'slow_down_for_layer_cooling',
  'slow_down_layer_time',
  'slow_down_min_speed',
  'supertack_plate_temp',
  'supertack_plate_temp_initial_layer',
  'support_material_interface_fan_speed',
  'temperature_vitrification',
  'textured_cool_plate_temp',
  'textured_cool_plate_temp_initial_layer',
  'textured_plate_temp',
  'textured_plate_temp_initial_layer',
];

/**
 * Give every declared per-filament option one entry per physical filament: the
 * filament's own value when it carries one, otherwise the project-level value
 * (already a vector when the project was imported, a scalar when it came from a
 * flattened profile).
 */
function applyFilamentVectors(config: Record<string, JsonValue>, state: ProjectState): void {
  const physical = state.filaments.physical;
  if (physical.length === 0) return;
  for (const key of FILAMENT_VECTOR_KEYS) {
    if (Array.isArray(config[key]) && (config[key] as JsonValue[]).length === physical.length) continue;
    const base = state.config[key];
    const values = physical.map((filament, index) => {
      if (Object.hasOwn(filament.config, key)) return filament.config[key];
      if (Array.isArray(base)) return base[index] ?? base[base.length - 1];
      return base;
    });
    const fallback = values.find((value) => value !== undefined);
    if (fallback === undefined) continue;
    config[key] = values.map((value) => cloneJson(value ?? fallback));
  }
}

/**
 * Render one project-settings value the way the engine's JSON reader expects.
 * `ConfigBase::load_from_json` accepts strings and arrays of strings only; a
 * numeric or boolean array makes it drop the whole option, so a computed value
 * such as `nozzle_diameter` would silently revert to the engine default.
 */
function bbsConfigValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => bbsValue(entry));
  if (typeof value === 'string') return value;
  return bbsValue(value);
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
    if (mixed.fullSpectrum) {
      rows.push(serializeFullSpectrumDefinition(mixed, state.filaments.physical));
      return;
    }
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

function transform3mf(transform: Transform, translationOffsetMm: { x: number; y: number } = { x: 0, y: 0 }): string {
  const matrix = transformMatrix(transform, translationOffsetMm);
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

function transformMatrix(
  transform: Transform,
  translationOffsetMm: { x: number; y: number } = { x: 0, y: 0 },
): number[] {
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
    transform.translationMm[0] + translationOffsetMm.x,
    2 * (x * y + z * w) * sx,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z - x * w) * sz,
    transform.translationMm[1] + translationOffsetMm.y,
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
  modelPath: string;
  numericId: number;
  name: string;
  materialIndex?: number;
  mesh?: DecodedIndexedMesh;
  components: Array<{
    reference: ParsedObjectReference;
    transform: Matrix4;
    extensionAttributes: ExtensionAttribute[];
  }>;
  annotations: FacetAnnotations;
  extensionAttributes: ExtensionAttribute[];
  facetExtensionAttributes: FacetExtensionAttributes[];
}

interface ParsedObjectReference {
  modelPath: string;
  objectId: number;
}

interface ParsedBuildItem {
  reference: ParsedObjectReference;
  transform: Transform;
  printable: boolean;
  extensionAttributes: ExtensionAttribute[];
}

type Matrix4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

interface ParsedCorePackage {
  title: string;
  materials: Array<{ name: string; color: string }>;
  objects: Map<string, ParsedMeshObject>;
  build: ParsedBuildItem[];
  externalModelPaths: string[];
}

interface ResolvedMeshComponent {
  object: ParsedMeshObject;
  transform: Transform;
  extensionAttributes: ExtensionAttribute[];
}

interface ParsedModelMetadata {
  objectConfig: Map<number, ConfigMap>;
  objectNames: Map<number, string>;
  partData: Map<number, Map<number, { role: VolumeRole; name?: string; config: ConfigMap }>>;
  layerRanges: Map<number, Array<Omit<LayerRange, 'id'>>>;
  plates: Array<{
    sourceId: number;
    sourceIdValid: boolean;
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

interface ImportedPlateCoordinates {
  plateDefinitions: ParsedModelMetadata['plates'];
  plateIndexByBuildItem: number[];
  originsMm: Array<{ x: number; y: number }>;
  normalizedBuildItemCount: number;
}

function importedPlateCoordinates(
  files: ReadonlyMap<string, Uint8Array>,
  metadata: ParsedModelMetadata,
  buildItemCount: number,
): ImportedPlateCoordinates {
  const extraction = extractBbsPlateLayoutResult(files);
  if (extraction.status === 'invalid') {
    throw new BbsPlateCoordinateError(
      'invalid-plate-metadata',
      'Cannot establish BBS plate-local coordinates: model_settings.config contains invalid or contradictory plate membership',
    );
  }
  if (metadata.plates.length === 0) {
    return {
      plateDefinitions: [
        { sourceId: 1, sourceIdValid: true, name: 'Plate 1', printable: true, config: {}, assignments: [] },
      ],
      plateIndexByBuildItem: Array.from({ length: buildItemCount }, () => 0),
      originsMm: [{ x: 0, y: 0 }],
      normalizedBuildItemCount: 0,
    };
  }

  const plateDefinitions = [...metadata.plates].sort((left, right) => left.sourceId - right.sourceId);
  if (plateDefinitions.some((plate, index) => !plate.sourceIdValid || plate.sourceId !== index + 1)) {
    throw new BbsPlateCoordinateError(
      'invalid-plate-metadata',
      'Cannot establish BBS plate-local coordinates: plater_id values must be unique and contiguous from 1',
    );
  }
  if (extraction.status !== 'valid' || extraction.layout.buildItemCount !== buildItemCount) {
    throw new BbsPlateCoordinateError(
      'invalid-plate-metadata',
      'Cannot establish BBS plate-local coordinates: plate membership does not match the core build list',
    );
  }
  const { layout } = extraction;
  if (
    layout.plates.length !== plateDefinitions.length ||
    layout.plates.some((plate, index) => plate.sourceId !== plateDefinitions[index].sourceId)
  ) {
    throw new BbsPlateCoordinateError(
      'invalid-plate-metadata',
      'Cannot establish BBS plate-local coordinates: parsed plate order does not match plater_id metadata',
    );
  }

  const plateIndexByBuildItem = Array.from({ length: buildItemCount }, () => -1);
  for (const [plateIndex, plate] of layout.plates.entries()) {
    for (const buildItemIndex of plate.buildItemIndices) {
      if (buildItemIndex < 0 || buildItemIndex >= buildItemCount || plateIndexByBuildItem[buildItemIndex] !== -1) {
        throw new BbsPlateCoordinateError(
          'invalid-plate-metadata',
          `Cannot establish BBS plate-local coordinates: build item ${buildItemIndex} has contradictory plate membership`,
        );
      }
      plateIndexByBuildItem[buildItemIndex] = plateIndex;
    }
  }

  if (plateDefinitions.length === 1) {
    plateIndexByBuildItem.fill(0);
  } else {
    const unassigned = plateIndexByBuildItem.flatMap((plateIndex, buildItemIndex) =>
      plateIndex === -1 ? [buildItemIndex] : [],
    );
    if (unassigned.length > 0 || layout.unassignedBuildItemIndices.length > 0) {
      const indices = [...new Set([...unassigned, ...layout.unassignedBuildItemIndices])].sort((a, b) => a - b);
      throw new BbsPlateCoordinateError(
        'unassigned-build-item',
        `Cannot establish BBS plate-local coordinates: core build item${indices.length === 1 ? '' : 's'} ${indices.join(
          ', ',
        )} ${indices.length === 1 ? 'is' : 'are'} unassigned or conflicting in model_settings.config`,
      );
    }
  }

  const originsMm = layout.plates.map((plate, plateIndex) => {
    if (plate.originMm) return plate.originMm;
    if (plateIndex === 0 || plate.buildItemIndices.length === 0) return { x: 0, y: 0 };
    throw new BbsPlateCoordinateError(
      'missing-printable-area',
      `Cannot establish BBS plate-local coordinates for plate ${plate.sourceId}: project_settings.config has no valid printable_area`,
    );
  });
  const normalizedBuildItemCount = layout.plates.reduce((count, plate, plateIndex) => {
    const origin = originsMm[plateIndex];
    return count + (origin.x !== 0 || origin.y !== 0 ? plate.buildItemIndices.length : 0);
  }, 0);
  return { plateDefinitions, plateIndexByBuildItem, originsMm, normalizedBuildItemCount };
}

function plateLocalTransform(transform: Transform, originMm: { x: number; y: number }): Transform {
  const x = transform.translationMm[0] - originMm.x;
  const y = transform.translationMm[1] - originMm.y;
  return {
    translationMm: [Object.is(x, -0) ? 0 : x, Object.is(y, -0) ? 0 : y, transform.translationMm[2]],
    rotation: [transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]],
    scale: [transform.scale[0], transform.scale[1], transform.scale[2]],
  };
}

export function importBbsCore(files: ReadonlyMap<string, Uint8Array>, archiveHash: string): ImportedCoreProject {
  const parsed = parseCorePackage(files);
  const projectConfig = parseProjectSettings(files.get(PROJECT_SETTINGS_PATH));
  const modelMetadata = parseModelSettings(files.get(MODEL_SETTINGS_PATH));
  const plateCoordinates = importedPlateCoordinates(files, modelMetadata, parsed.build.length);
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
  // Per-tool filament facts the project actually declares; slicing preflight
  // treats an imported project's own configuration as its authority, so these
  // must survive import instead of collapsing into "Unknown".
  const filamentTypes = perToolConfigValues(projectConfig.config, 'filament_type');
  const filamentNames = perToolConfigValues(projectConfig.config, 'filament_settings_id');
  const nozzleLow = perToolConfigValues(projectConfig.config, 'nozzle_temperature_range_low');
  const nozzleHigh = perToolConfigValues(projectConfig.config, 'nozzle_temperature_range_high');
  const physical: PhysicalFilament[] = colors.map((color, index) => {
    const config: ConfigMap = {};
    if (filamentTypes[index]) config.filament_type = filamentTypes[index];
    if (nozzleLow[index]) config.nozzle_temperature_range_low = nozzleLow[index];
    if (nozzleHigh[index]) config.nozzle_temperature_range_high = nozzleHigh[index];
    return {
      id: makeId('physical-filament', String(index + 1)),
      name: filamentNames[index] || parsed.materials[index]?.name || `Imported tool ${index + 1}`,
      toolId: index,
      material: filamentTypes[index] || 'Unknown',
      color,
      config,
      enabled: true,
    };
  });
  const mixedImport = projectConfig.mixedDefinitions
    ? importFullSpectrumDefinitions(projectConfig.mixedDefinitions, physical, {
        createId: (rowIndex, upstreamStableId) => makeId('mixed-filament', `${rowIndex + 1}-${upstreamStableId}`),
        mixedMaterials: parsed.materials.slice(physical.length),
      })
    : { filaments: [], issues: [] };
  const mixed = [...mixedImport.filaments];
  for (const issue of mixedImport.issues) {
    warnings.push(`FullSpectrum row ${issue.rowIndex + 1} ${issue.severity}: ${issue.message}`);
  }
  const assignmentFilaments = [...physical, ...mixed.filter((filament) => filament.enabled)];
  for (const object of parsed.objects.values()) {
    object.annotations.color = object.annotations.color.flatMap((assignment) => {
      const match = /^import:3mf:paint-slot-(\d+)$/.exec(assignment.value);
      const filament = match ? assignmentFilaments[Number(match[1]) - 1] : undefined;
      return filament ? [{ ...assignment, value: filament.id }] : [];
    });
  }
  if (projectConfig.mixedDefinitions && mixed.length === 0) {
    warnings.push(
      'No valid canonical FullSpectrum rows could be reconstructed; raw definitions remain preserved in config.',
    );
  }
  if (plateCoordinates.normalizedBuildItemCount > 0) {
    warnings.push(
      `Normalized ${plateCoordinates.normalizedBuildItemCount} BBS build transform${
        plateCoordinates.normalizedBuildItemCount === 1 ? '' : 's'
      } from the virtual multi-plate grid into plate-local printer coordinates`,
    );
  }
  if (parsed.externalModelPaths.length > 0) {
    warnings.push(
      `Resolved ${parsed.externalModelPaths.length} referenced 3MF Production Extension model part${
        parsed.externalModelPaths.length === 1 ? '' : 's'
      }; the original split members remain preserved as opaque package entries`,
    );
  }

  const buildByObject = new Map<
    string,
    {
      reference: ParsedObjectReference;
      rows: Array<{ item: ParsedBuildItem; buildItemIndex: number; originalIndex: number }>;
    }
  >();
  const occurrenceByObject = new Map<string, number>();
  parsed.build.forEach((item, buildItemIndex) => {
    const key = objectReferenceKey(item.reference);
    const originalIndex = occurrenceByObject.get(key) ?? 0;
    occurrenceByObject.set(key, originalIndex + 1);
    const group = buildByObject.get(key) ?? { reference: item.reference, rows: [] };
    group.rows.push({ item, buildItemIndex, originalIndex });
    buildByObject.set(key, group);
  });
  assertUnambiguousTopLevelMetadata(buildByObject, modelMetadata);
  const resolvedComponents = resolveComponentGraphs(
    parsed.objects,
    [...buildByObject.values()].map((group) => group.reference),
  );
  const reachableMeshKeys = new Set(
    [...resolvedComponents.values()].flatMap((components) =>
      components.map((component) => objectReferenceKey(component.object)),
    ),
  );

  const assets: AssetPayload[] = [];
  const sourceAssets: SourceAssetDescriptor[] = [];
  const meshAssetIds = new Map<string, SourceAssetDescriptor['id']>();
  for (const object of parsed.objects.values()) {
    const referenceKey = objectReferenceKey(object);
    if (!object.mesh || !reachableMeshKeys.has(referenceKey)) continue;
    const bytes = encodeMeshAsset(object.mesh);
    const id = makeId('asset', objectReferenceToken(object));
    const descriptor: SourceAssetDescriptor = {
      id,
      kind: 'mesh',
      digest: contentDigest(bytes),
      byteLength: bytes.byteLength,
      mediaType: 'application/vnd.orcaxr.indexed-mesh',
      provenance: { source: 'import', uri: `3mf:${object.modelPath}#${object.numericId}` },
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
    meshAssetIds.set(referenceKey, id);
    sourceAssets.push(descriptor);
    assets.push({ descriptor, bytes });
  }

  const plateDefinitions = plateCoordinates.plateDefinitions;
  const plateIds = plateDefinitions.map((_plate, index) => makeId('plate', String(index + 1)));
  const plates: ProjectPlate[] = plateDefinitions.map((plate, index) => ({
    id: plateIds[index],
    name: plate.name || `Plate ${index + 1}`,
    order: index,
    printable: plate.printable,
    config: cloneJson(plate.config),
    objects: [],
  }));

  let sourceObjectOrdinal = 0;
  for (const [parentKey, group] of buildByObject) {
    const parent = parsed.objects.get(parentKey);
    if (!parent) throw new Error(`3MF build references missing object ${describeObjectReference(group.reference)}`);
    const parentId = parent.numericId;
    const parentToken = objectReferenceToken(group.reference);
    const componentRows = resolvedComponents.get(parentKey) ?? [];
    sourceObjectOrdinal += 1;
    const byPlate = new Map<number, Array<{ item: ParsedBuildItem; buildItemIndex: number; originalIndex: number }>>();
    group.rows.forEach((row) => {
      const plateIndex = plateCoordinates.plateIndexByBuildItem[row.buildItemIndex] ?? 0;
      const list = byPlate.get(plateIndex) ?? [];
      list.push(row);
      byPlate.set(plateIndex, list);
    });
    for (const [plateIndex, itemRows] of byPlate) {
      const plate = plates[plateIndex] ?? plates[0];
      const objectId = makeId('object', `${parentToken}-${plateIndex + 1}`);
      const volumes: ProjectVolume[] = [];
      for (const [componentIndex, component] of componentRows.entries()) {
        const leaf = component.object;
        const assetId = meshAssetIds.get(objectReferenceKey(leaf));
        if (!leaf.mesh || !assetId) continue;
        const part = modelMetadata.partData.get(parentId)?.get(leaf.numericId);
        let role = part?.role ?? 'model';
        if (componentRows.length === 1 && role !== 'model') {
          role = 'model';
          warnings.push(
            `Standalone BBS part ${leaf.numericId} had role ${part?.role}; imported as a model volume to preserve canonical object invariants`,
          );
        }
        const volumeConfig = cloneJson(part?.config ?? {});
        const requestedSlot = Number(volumeConfig.extruder);
        const filament = Number.isInteger(requestedSlot)
          ? assignmentFilaments[requestedSlot - 1]
          : leaf.materialIndex !== undefined
            ? assignmentFilaments[leaf.materialIndex]
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
          id: makeId('volume', `${parentToken}-${objectReferenceToken(leaf)}-${componentIndex + 1}-${plateIndex + 1}`),
          name: part?.name ?? leaf.name ?? `Part ${leaf.numericId}`,
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
        const filamentId = Number.isInteger(extruder) ? assignmentFilaments[extruder - 1]?.id : undefined;
        if (filamentId) delete copy.config.extruder;
        return {
          ...copy,
          id: makeId('layer-range', `${parentToken}-${plateIndex + 1}-${index + 1}`),
          ...(filamentId ? { filamentId } : {}),
        };
      });
      const object: ProjectObject = {
        id: objectId,
        name: modelMetadata.objectNames.get(parentId) ?? parent.name ?? `Object ${parentId}`,
        config: objectConfig,
        volumes,
        instances: itemRows.map(({ item, originalIndex }) => ({
          id: makeId('instance', `${parentToken}-${plateIndex + 1}-${originalIndex + 1}`),
          transform: plateLocalTransform(item.transform, plateCoordinates.originsMm[plateIndex]),
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
      if (Number.isInteger(extruder) && assignmentFilaments[extruder - 1]) {
        object.filamentId = assignmentFilaments[extruder - 1].id;
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
    filaments: { physical, mixed },
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

interface ParsedModelPart {
  title: string;
  materials: Array<{ name: string; color: string }>;
  objects: Map<number, ParsedMeshObject>;
  build: ParsedBuildItem[];
}

function parseCorePackage(files: ReadonlyMap<string, Uint8Array>): ParsedCorePackage {
  const rootBytes = files.get(CORE_MODEL_PATH);
  if (!rootBytes) throw new Error(`3MF is missing ${CORE_MODEL_PATH}`);
  const root = parseModelPart(decodeText(rootBytes, CORE_MODEL_PATH), CORE_MODEL_PATH, true);
  const referencedPaths = new Set<string>();
  for (const object of root.objects.values()) {
    for (const component of object.components) {
      if (component.reference.modelPath !== CORE_MODEL_PATH) referencedPaths.add(component.reference.modelPath);
    }
  }
  for (const item of root.build) {
    if (item.reference.modelPath !== CORE_MODEL_PATH) referencedPaths.add(item.reference.modelPath);
  }

  const parts = new Map<string, ParsedModelPart>([[CORE_MODEL_PATH, root]]);
  for (const path of [...referencedPaths].sort(compareText)) {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`3MF Production Extension references missing model part ${path}`);
    parts.set(path, parseModelPart(decodeText(bytes, path), path, false));
  }

  const objects = new Map<string, ParsedMeshObject>();
  for (const part of parts.values()) {
    for (const object of part.objects.values()) objects.set(objectReferenceKey(object), object);
  }
  for (const object of objects.values()) {
    for (const component of object.components) {
      if (!objects.has(objectReferenceKey(component.reference))) {
        throw new Error(`3MF component references missing object ${describeObjectReference(component.reference)}`);
      }
    }
  }
  for (const item of root.build) {
    if (!objects.has(objectReferenceKey(item.reference))) {
      throw new Error(`3MF build references missing object ${describeObjectReference(item.reference)}`);
    }
  }
  return {
    title: root.title,
    materials: root.materials,
    objects,
    build: root.build,
    externalModelPaths: [...referencedPaths].sort(compareText),
  };
}

function parseModelPart(xml: string, modelPath: string, root: boolean): ParsedModelPart {
  const markup = validatedXmlMarkup(xml, modelPath);
  const namespaceMatch = /<model\b([^>]*)>/i.exec(markup);
  if (!namespaceMatch) throw new Error(`${modelPath} is missing its 3MF model element`);
  const namespaces = parseNamespaces(namespaceMatch[1]);
  const modelAttributes = parseAttributes(namespaceMatch[1]);
  const unitScaleMm = modelUnitScaleMm(modelAttributes.unit, modelPath);
  const title = decodeXml(/<metadata\b[^>]*name=["']Title["'][^>]*>([\s\S]*?)<\/metadata>/i.exec(markup)?.[1] ?? '');
  const resourcesMatch = /<resources\b[^>]*>([\s\S]*?)<\/resources>/i.exec(markup);
  const emptyResources = /<resources\b[^>]*\/\s*>/i.test(markup);
  if (!resourcesMatch && !emptyResources) throw new Error(`${modelPath} is missing its 3MF resources element`);
  const resourcesBody = resourcesMatch?.[1] ?? '';
  const materials = [...resourcesBody.matchAll(/<base\b([^>]*)\/?\s*>/gi)].map((base, index) => {
    const attributes = parseAttributes(base[1]);
    return {
      name: attributes.name ? decodeXml(attributes.name) : `Imported tool ${index + 1}`,
      color: normalizeColor(attributes.displaycolor ?? '#CCCCCC').slice(0, 7),
    };
  });
  const objects = new Map<number, ParsedMeshObject>();
  for (const match of resourcesBody.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const attributes = parseAttributes(match[1]);
    const numericId = Number(attributes.id);
    if (!Number.isInteger(numericId) || numericId < 1 || objects.has(numericId)) {
      throw new Error(`${modelPath} contains invalid or duplicate 3MF object ID ${attributes.id ?? ''}`);
    }
    const body = match[2];
    const meshMatches = [...body.matchAll(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/gi)];
    const componentsMatch = /<components\b[^>]*>([\s\S]*?)<\/components>/i.exec(body);
    if (meshMatches.length + (componentsMatch ? 1 : 0) !== 1) {
      throw new Error(`${modelPath} object ${numericId} must contain exactly one mesh or components element`);
    }
    const mesh = meshMatches[0] ? parseMesh(meshMatches[0][1], namespaces, unitScaleMm) : undefined;
    const components = [...(componentsMatch?.[1] ?? '').matchAll(/<component\b([^>]*)\/?\s*>/gi)].map((component) => {
      const attrs = parseAttributes(component[1]);
      const objectId = Number(attrs.objectid);
      if (!Number.isInteger(objectId) || objectId < 1) {
        throw new Error(`${modelPath} component references invalid object ID ${attrs.objectid ?? ''}`);
      }
      const productionPath = productionPathAttribute(component[1], namespaces);
      if (!root && productionPath !== undefined) {
        throw new Error(
          `${modelPath} contains p:path on a non-root component; the 3MF Production Extension permits external paths only in the root model part`,
        );
      }
      const targetPath =
        productionPath === undefined ? modelPath : normalizeProductionModelPath(productionPath, modelPath);
      return {
        reference: { modelPath: targetPath, objectId },
        transform: parseTransformMatrix3mf(attrs.transform, unitScaleMm),
        extensionAttributes: withoutProductionPath(
          parseExtensionAttributes(component[1], namespaces, ['objectid', 'transform']),
        ),
      };
    });
    if (componentsMatch && components.length === 0) {
      throw new Error(`${modelPath} object ${numericId} has an empty components graph`);
    }
    objects.set(numericId, {
      modelPath,
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

  const pairedBuild = /<build\b[^>]*>([\s\S]*?)<\/build>/i.exec(markup);
  const emptyBuild = /<build\b[^>]*\/\s*>/i.test(markup);
  if (!pairedBuild && !emptyBuild) throw new Error(`${modelPath} is missing its 3MF build element`);
  const build = [...(pairedBuild?.[1] ?? '').matchAll(/<item\b([^>]*)\/?\s*>/gi)].map((item) => {
    const attributes = parseAttributes(item[1]);
    const objectId = Number(attributes.objectid);
    if (!Number.isInteger(objectId) || objectId < 1) {
      throw new Error(`${modelPath} build item references invalid object ID ${attributes.objectid ?? ''}`);
    }
    const productionPath = productionPathAttribute(item[1], namespaces);
    if (!root && productionPath !== undefined) {
      throw new Error(`${modelPath} contains p:path in a non-root build section`);
    }
    const targetPath =
      productionPath === undefined ? modelPath : normalizeProductionModelPath(productionPath, modelPath);
    return {
      reference: { modelPath: targetPath, objectId },
      transform: decomposeMatrix(parseTransformMatrix3mf(attributes.transform, unitScaleMm)),
      printable: attributes.printable !== '0',
      extensionAttributes: withoutProductionPath(
        parseExtensionAttributes(item[1], namespaces, ['objectid', 'transform', 'printable']),
      ),
    };
  });
  return { title, materials, objects, build: root ? build : [] };
}

function resolveComponentGraphs(
  objects: ReadonlyMap<string, ParsedMeshObject>,
  roots: readonly ParsedObjectReference[],
): Map<string, ResolvedMeshComponent[]> {
  const result = new Map<string, ResolvedMeshComponent[]>();
  let expansion = 0;
  for (const root of roots) {
    const rootKey = objectReferenceKey(root);
    if (result.has(rootKey)) continue;
    const resolved: ResolvedMeshComponent[] = [];
    const stack = new Set<string>();
    const visit = (
      reference: ParsedObjectReference,
      transform: Matrix4,
      edgeAttributes: ExtensionAttribute[],
      depth: number,
    ): void => {
      if (depth > MAX_COMPONENT_GRAPH_DEPTH) {
        throw new Error(
          `3MF component graph rooted at ${describeObjectReference(root)} exceeds the maximum depth of ${MAX_COMPONENT_GRAPH_DEPTH}`,
        );
      }
      expansion += 1;
      if (expansion > MAX_COMPONENT_GRAPH_EXPANSION) {
        throw new Error(`3MF component graph expansion exceeds the limit of ${MAX_COMPONENT_GRAPH_EXPANSION} objects`);
      }
      const key = objectReferenceKey(reference);
      if (stack.has(key)) {
        throw new Error(`3MF component graph contains a cycle through ${describeObjectReference(reference)}`);
      }
      const object = objects.get(key);
      if (!object) throw new Error(`3MF component references missing object ${describeObjectReference(reference)}`);
      if (object.mesh) {
        resolved.push({
          object,
          transform: decomposeMatrix(transform),
          extensionAttributes: edgeAttributes.map((attribute) => ({ ...attribute })),
        });
        return;
      }
      stack.add(key);
      for (const component of object.components) {
        visit(
          component.reference,
          multiplyMatrices(transform, component.transform),
          component.extensionAttributes,
          depth + 1,
        );
      }
      stack.delete(key);
    };
    visit(root, identityMatrix(), [], 0);
    if (resolved.length === 0) {
      throw new Error(`3MF component graph rooted at ${describeObjectReference(root)} resolves to no mesh objects`);
    }
    result.set(rootKey, resolved);
  }
  return result;
}

function assertUnambiguousTopLevelMetadata(
  groups: ReadonlyMap<string, { reference: ParsedObjectReference }>,
  metadata: ParsedModelMetadata,
): void {
  const referencesById = new Map<number, Set<string>>();
  for (const [key, group] of groups) {
    const references = referencesById.get(group.reference.objectId) ?? new Set<string>();
    references.add(key);
    referencesById.set(group.reference.objectId, references);
  }
  for (const [objectId, references] of referencesById) {
    if (
      references.size > 1 &&
      (metadata.objectConfig.has(objectId) ||
        metadata.objectNames.has(objectId) ||
        metadata.partData.has(objectId) ||
        metadata.layerRanges.has(objectId))
    ) {
      throw new Error(
        `${MODEL_SETTINGS_PATH} object ID ${objectId} is ambiguous across multiple Production Extension model parts`,
      );
    }
  }
}

function objectReferenceKey(reference: ParsedObjectReference | ParsedMeshObject): string {
  const objectId = 'objectId' in reference ? reference.objectId : reference.numericId;
  return `${reference.modelPath}\u0000${objectId}`;
}

function objectReferenceToken(reference: ParsedObjectReference | ParsedMeshObject): string {
  const objectId = 'objectId' in reference ? reference.objectId : reference.numericId;
  return `${fnv1a64(encodeText(reference.modelPath))}-${objectId}`;
}

function describeObjectReference(reference: ParsedObjectReference): string {
  return `${reference.modelPath}#${reference.objectId}`;
}

function normalizeProductionModelPath(rawPath: string, sourcePath: string): string {
  if (!rawPath || rawPath.startsWith('//')) {
    throw new Error(`${sourcePath} contains an invalid 3MF Production Extension path ${JSON.stringify(rawPath)}`);
  }
  const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  try {
    validatePackagePath(path);
  } catch (error) {
    throw new Error(`${sourcePath} contains an invalid 3MF Production Extension path ${JSON.stringify(rawPath)}`, {
      cause: error,
    });
  }
  if (!/\.model$/i.test(path)) {
    throw new Error(`${sourcePath} Production Extension path ${rawPath} does not reference a .model package part`);
  }
  if (path === CORE_MODEL_PATH) {
    throw new Error(`${sourcePath} Production Extension path conflicts with the root model part`);
  }
  return path;
}

function productionPathAttribute(source: string, namespaces: ReadonlyMap<string, string>): string | undefined {
  const values: string[] = [];
  for (const [qualifiedName, value] of Object.entries(parseAttributes(source))) {
    const colon = qualifiedName.indexOf(':');
    if (colon < 0 || qualifiedName.slice(colon + 1) !== 'path') continue;
    const namespace = namespaces.get(qualifiedName.slice(0, colon));
    if (namespace === PRODUCTION_NAMESPACE) values.push(value);
  }
  if (values.length > 1) throw new Error('3MF element contains conflicting Production Extension path attributes');
  return values[0];
}

function withoutProductionPath(attributes: ExtensionAttribute[]): ExtensionAttribute[] {
  return attributes.filter((attribute) => attribute.namespace !== PRODUCTION_NAMESPACE || attribute.name !== 'path');
}

function parseMesh(
  body: string,
  namespaces: ReadonlyMap<string, string>,
  unitScaleMm = 1,
): DecodedIndexedMesh & {
  annotations: FacetAnnotations;
  facetExtensionAttributes: FacetExtensionAttributes[];
} {
  const vertices = [...body.matchAll(/<vertex\b([^>]*)\/?\s*>/gi)].map((vertex) => {
    const attrs = parseAttributes(vertex[1]);
    const value: readonly [number, number, number] = [
      Number(attrs.x) * unitScaleMm,
      Number(attrs.y) * unitScaleMm,
      Number(attrs.z) * unitScaleMm,
    ];
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

function printableAreaSize(value: JsonValue | undefined): { x: number; y: number } | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;]/).map((entry) => entry.trim())
      : [];
  const points: Array<{ x: number; y: number }> = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*x\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/i.exec(entry);
    if (!match) continue;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (points.length < 2) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.max(...xs) - Math.min(...xs);
  const y = Math.max(...ys) - Math.min(...ys);
  return x > 0 && y > 0 ? { x, y } : undefined;
}

/** Mirrors PartPlateList::compute_origin and LOGICAL_PART_PLATE_GAP in Snapmaker Orca v2.3.4. */
function bbsVirtualPlateOrigins(
  plateCount: number,
  bedSizeMm: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const columns = Math.ceil(Math.sqrt(plateCount));
  return Array.from({ length: plateCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      x: column * bedSizeMm.x * (1 + BBS_PLATE_GAP_RATIO),
      y: row === 0 ? 0 : -row * bedSizeMm.y * (1 + BBS_PLATE_GAP_RATIO),
    };
  });
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
    if (
      result.objectConfig.has(objectId) ||
      result.objectNames.has(objectId) ||
      result.partData.has(objectId) ||
      result.layerRanges.has(objectId)
    ) {
      throw new Error(`${MODEL_SETTINGS_PATH} contains duplicate object ID ${objectId}`);
    }
    const body = objectMatch[2];
    const objectPrefix = body.split(/<part\b/i, 1)[0];
    const config = parseMetadataConfig(objectPrefix);
    if (typeof config.name === 'string') {
      result.objectNames.set(objectId, config.name);
      delete config.name;
    }
    result.objectConfig.set(objectId, config);
    const parts = new Map<number, { role: VolumeRole; name?: string; config: ConfigMap }>();
    for (const partMatch of body.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/gi)) {
      const partAttrs = parseAttributes(partMatch[1]);
      const partId = Number(partAttrs.id);
      if (!Number.isInteger(partId)) continue;
      if (parts.has(partId)) {
        throw new Error(`${MODEL_SETTINGS_PATH} object ${objectId} contains duplicate part ID ${partId}`);
      }
      const partConfig = parseMetadataConfig(partMatch[2]);
      const name = typeof partConfig.name === 'string' ? partConfig.name : undefined;
      delete partConfig.name;
      delete partConfig.matrix;
      parts.set(partId, {
        role: roleFromSubtype(partAttrs.subtype),
        name,
        config: partConfig,
      });
    }
    if (parts.size > 0) result.partData.set(objectId, parts);
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
    const attributeSourceId = attrs.id === undefined ? undefined : Number(attrs.id);
    const configSourceId = config.plater_id === undefined ? undefined : Number(config.plater_id);
    const sourceIdCandidate = attributeSourceId ?? configSourceId;
    const sourceId = sourceIdCandidate ?? result.plates.length + 1;
    const sourceIdValid =
      Number.isInteger(sourceId) &&
      sourceId >= 1 &&
      (attributeSourceId === undefined || configSourceId === undefined || attributeSourceId === configSourceId);
    const assignments: Array<{ objectId: number; instanceIndex: number }> = [];
    for (const instance of plateMatch[2].matchAll(
      /<model_instance\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/model_instance>)/gi,
    )) {
      const direct = parseAttributes(instance[1] ?? '');
      const nested = parseMetadataConfig(instance[2] ?? '');
      const objectId = Number(direct.object_id ?? nested.object_id);
      const instanceIndex = Number(direct.instance_id ?? nested.instance_id ?? 0);
      if (Number.isInteger(objectId) && Number.isInteger(instanceIndex)) {
        assignments.push({ objectId, instanceIndex });
      }
    }
    result.plates.push({
      sourceId,
      sourceIdValid,
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

function encodeMeshAsset(mesh: DecodedIndexedMesh): Uint8Array {
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

function parseTransformMatrix3mf(value: string | undefined, unitScaleMm = 1): Matrix4 {
  if (!value) return identityMatrix();
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('Invalid 3MF transform');
  }
  return [
    parts[0],
    parts[3],
    parts[6],
    parts[9] * unitScaleMm,
    parts[1],
    parts[4],
    parts[7],
    parts[10] * unitScaleMm,
    parts[2],
    parts[5],
    parts[8],
    parts[11] * unitScaleMm,
    0,
    0,
    0,
    1,
  ];
}

function identityMatrix(): Matrix4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(left: Matrix4, right: Matrix4): Matrix4 {
  const output = Array.from({ length: 16 }, () => 0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let inner = 0; inner < 4; inner += 1) {
        output[row * 4 + column] += left[row * 4 + inner] * right[inner * 4 + column];
      }
    }
  }
  if (output.some((value) => !Number.isFinite(value))) throw new Error('3MF transform composition overflowed');
  return output as unknown as Matrix4;
}

function decomposeMatrix(matrix: readonly number[]): Transform {
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
  const quaternionNorm = Math.hypot(x, y, z, w);
  if (!Number.isFinite(quaternionNorm) || quaternionNorm < 1e-12) {
    throw new Error('3MF transform has an invalid rotation');
  }
  return {
    translationMm: [matrix[3], matrix[7], matrix[11]],
    rotation: [x / quaternionNorm, y / quaternionNorm, z / quaternionNorm, w / quaternionNorm],
    scale: [sx, sy, sz],
  };
}

function modelUnitScaleMm(unit: string | undefined, path: string): number {
  switch ((unit ?? 'millimeter').toLowerCase()) {
    case 'micron':
      return 0.001;
    case 'millimeter':
      return 1;
    case 'centimeter':
      return 10;
    case 'inch':
      return 25.4;
    case 'foot':
      return 304.8;
    case 'meter':
      return 1000;
    default:
      throw new Error(`${path} declares unsupported 3MF unit ${unit}`);
  }
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

interface XmlOpeningTag {
  name: string;
  selfClosing: boolean;
  attributes: Array<{ name: string; value: string }>;
}

/**
 * Validate the XML before the deliberately small 3MF regex projection reads
 * it. Comments, processing instructions, and CDATA are blanked so markup-like
 * text in those constructs cannot be mistaken for geometry or resources.
 */
function validatedXmlMarkup(xml: string, path: string): string {
  assertXmlValue(xml, path);
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new Error(`${path} contains a prohibited XML DTD or entity declaration`);
  }
  const stack: Array<{ name: string; namespaces: Map<string, string> }> = [];
  const baseNamespaces = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);
  const sanitized: string[] = [];
  let sanitizedCursor = 0;
  let index = 0;
  let rootCount = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open < 0) {
      validateXmlText(xml.slice(index), stack.length > 0, path);
      break;
    }
    validateXmlText(xml.slice(index, open), stack.length > 0, path);
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end < 0 || xml.slice(open + 4, end).includes('--'))
        throw new Error(`${path} contains an invalid XML comment`);
      const after = end + 3;
      sanitized.push(xml.slice(sanitizedCursor, open), ' '.repeat(after - open));
      sanitizedCursor = after;
      index = after;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      if (stack.length === 0) throw new Error(`${path} contains XML CDATA outside the model element`);
      const end = xml.indexOf(']]>', open + 9);
      if (end < 0) throw new Error(`${path} contains unterminated XML CDATA`);
      const after = end + 3;
      sanitized.push(xml.slice(sanitizedCursor, open), ' '.repeat(after - open));
      sanitizedCursor = after;
      index = after;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end < 0) throw new Error(`${path} contains an unterminated XML processing instruction`);
      const after = end + 2;
      sanitized.push(xml.slice(sanitizedCursor, open), ' '.repeat(after - open));
      sanitizedCursor = after;
      index = after;
      continue;
    }
    if (xml.startsWith('<!', open)) throw new Error(`${path} contains an unsupported XML declaration`);
    const end = findXmlTagEnd(xml, open + 1, path);
    const source = xml.slice(open + 1, end);
    if (source.startsWith('/')) {
      const name = source.slice(1).trim();
      assertXmlName(name, path);
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw new Error(`${path} contains mismatched XML closing tag ${name}`);
      }
    } else {
      const tag = parseXmlOpeningTag(source, path);
      const namespaces = new Map(stack.at(-1)?.namespaces ?? baseNamespaces);
      for (const attribute of tag.attributes) {
        if (attribute.name === 'xmlns') namespaces.set('', attribute.value);
        else if (attribute.name.startsWith('xmlns:')) {
          const prefix = attribute.name.slice(6);
          if (!attribute.value) throw new Error(`${path} undeclares XML namespace prefix ${prefix}`);
          namespaces.set(prefix, attribute.value);
        }
      }
      assertBoundXmlName(tag.name, namespaces, path);
      for (const attribute of tag.attributes) {
        if (attribute.name !== 'xmlns' && !attribute.name.startsWith('xmlns:')) {
          assertBoundXmlName(attribute.name, namespaces, path, true);
        }
      }
      if (stack.length === 0) {
        rootCount += 1;
        if (rootCount > 1) throw new Error(`${path} contains multiple XML root elements`);
      }
      if (!tag.selfClosing) stack.push({ name: tag.name, namespaces });
    }
    index = end + 1;
  }
  if (stack.length > 0) throw new Error(`${path} contains an unclosed XML element ${stack.at(-1)!.name}`);
  if (rootCount !== 1) throw new Error(`${path} must contain exactly one XML root element`);
  sanitized.push(xml.slice(sanitizedCursor));
  return sanitized.join('');
}

function findXmlTagEnd(xml: string, start: number, path: string): number {
  let quote = '';
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = '';
      else if (character === '<' || character === '>') {
        throw new Error(`${path} contains a tag delimiter inside an XML attribute`);
      }
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  throw new Error(`${path} contains an unterminated XML tag`);
}

function parseXmlOpeningTag(source: string, path: string): XmlOpeningTag {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  };
  skipWhitespace();
  const nameStart = cursor;
  while (cursor < source.length && !/[\s/]/.test(source[cursor])) cursor += 1;
  const name = source.slice(nameStart, cursor);
  assertXmlName(name, path);
  const attributes: XmlOpeningTag['attributes'] = [];
  const names = new Set<string>();
  let selfClosing = false;
  while (cursor < source.length) {
    skipWhitespace();
    if (cursor >= source.length) break;
    if (source[cursor] === '/') {
      cursor += 1;
      skipWhitespace();
      if (cursor !== source.length) throw new Error(`${path} contains characters after an XML self-closing marker`);
      selfClosing = true;
      break;
    }
    const attributeStart = cursor;
    while (cursor < source.length && !/[\s=]/.test(source[cursor])) cursor += 1;
    const attributeName = source.slice(attributeStart, cursor);
    assertXmlName(attributeName, path);
    if (names.has(attributeName)) throw new Error(`${path} contains duplicate XML attribute ${attributeName}`);
    names.add(attributeName);
    skipWhitespace();
    if (source[cursor] !== '=') throw new Error(`${path} XML attribute ${attributeName} has no value`);
    cursor += 1;
    skipWhitespace();
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") throw new Error(`${path} XML attribute ${attributeName} is not quoted`);
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = source.indexOf(quote, cursor);
    if (valueEnd < 0) throw new Error(`${path} XML attribute ${attributeName} is unterminated`);
    const value = source.slice(valueStart, valueEnd);
    validateXmlEntities(value, path);
    attributes.push({ name: attributeName, value: decodeXml(value) });
    cursor = valueEnd + 1;
  }
  return { name, selfClosing, attributes };
}

function validateXmlText(value: string, insideRoot: boolean, path: string): void {
  if (!insideRoot && value.trim()) throw new Error(`${path} contains text outside its XML root element`);
  if (value.includes(']]>')) throw new Error(`${path} contains an invalid XML CDATA terminator`);
  validateXmlEntities(value, path);
}

function validateXmlEntities(value: string, path: string): void {
  let cursor = value.indexOf('&');
  while (cursor >= 0) {
    const match = /^&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/i.exec(value.slice(cursor));
    if (!match) throw new Error(`${path} contains an invalid or undeclared XML entity`);
    if (match[1] || match[2]) {
      const codePoint = match[1] ? Number(match[1]) : Number.parseInt(match[2], 16);
      if (!isXmlCodePoint(codePoint)) throw new Error(`${path} contains an invalid numeric XML entity`);
    }
    cursor = value.indexOf('&', cursor + match[0].length);
  }
}

function isXmlCodePoint(value: number): boolean {
  return (
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x1_0000 && value <= 0x10_ffff)
  );
}

function assertXmlName(name: string, path: string): void {
  if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(name)) {
    throw new Error(`${path} contains invalid XML name ${JSON.stringify(name)}`);
  }
}

function assertBoundXmlName(
  name: string,
  namespaces: ReadonlyMap<string, string>,
  path: string,
  attribute = false,
): void {
  const colon = name.indexOf(':');
  if (colon < 0) return;
  const prefix = name.slice(0, colon);
  if (!namespaces.has(prefix)) {
    throw new Error(`${path} ${attribute ? 'attribute' : 'element'} ${name} uses an undeclared namespace prefix`);
  }
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

/**
 * Per-tool values of a project-level filament vector. BBS stores these as JSON
 * arrays or delimited strings; a scalar applies to every tool.
 */
function perToolConfigValues(config: ConfigMap, key: string): string[] {
  const value = config[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '')));
  }
  if (typeof value === 'string') {
    const parts = value.includes(';') ? value.split(';') : value.includes(',') ? value.split(',') : [value];
    return parts.map((entry) => entry.trim());
  }
  return [String(value)];
}
