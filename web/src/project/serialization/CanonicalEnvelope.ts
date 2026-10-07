import { cloneJson } from '../domain/canonical';
import type { AssetId } from '../domain/ids';
import { isStableEntityId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { assertValidProjectState } from '../domain/validation';
import { migrateDenseFacetRefinements } from '../migration/denseFacetRefinement';

export const ORCAXR_EXTENSION_PATH = 'Metadata/orcaxr/project-v1.json';
export const ORCAXR_EXTENSION_FORMAT = 'https://orcaxr.martinez.fyi/3mf/project/1';

interface CanonicalExtensionEnvelope {
  format: typeof ORCAXR_EXTENSION_FORMAT;
  version: 1;
  state: ProjectState;
  assetEntries: Array<{ assetId: AssetId; path: string }>;
}

/** Envelope admission only. ZIP/asset proof, OPC/BBS reconciliation and unknown
 * package-member preservation still belong to Bbs3mfProjectSerializer. */
export function readCanonicalEnvelope(extensionBytes: Uint8Array): CanonicalExtensionEnvelope & {
  warnings: string[];
  migrations: { denseChannels: number; falseFuzzyAssignments: number };
} {
  const envelope = parseEnvelope(extensionBytes);
  const state = cloneJson(envelope.state);
  assertSvgRecipeShapes(state);
  const warnings: string[] = [];
  // Written by a build that stored one refinement root per source triangle.
  const denseRefinementChannels = migrateDenseFacetRefinements(state);
  if (denseRefinementChannels > 0) {
    warnings.push(
      `Converted ${denseRefinementChannels} facet refinement channel${
        denseRefinementChannels === 1 ? '' : 's'
      } from the per-triangle encoding to the subdivided-facet encoding`,
    );
  }
  const legacyFalseFuzzyAssignments = countLegacyFalseFuzzyAssignments(state);
  if (legacyFalseFuzzyAssignments > 0) {
    const validationState = cloneJson(state);
    coerceLegacyFalseFuzzyAssignments(validationState);
    assertValidProjectState(validationState);
    removeLegacyFalseFuzzyAssignments(state);
    warnings.push(
      `Removed ${legacyFalseFuzzyAssignments} legacy false fuzzy-skin facet assignment${
        legacyFalseFuzzyAssignments === 1 ? '' : 's'
      }; false represented the inherited/unpainted state`,
    );
  }
  assertValidProjectState(state);
  return {
    ...envelope,
    state,
    warnings,
    migrations: {
      denseChannels: denseRefinementChannels,
      falseFuzzyAssignments: legacyFalseFuzzyAssignments,
    },
  };
}

function parseEnvelope(bytes: Uint8Array): CanonicalExtensionEnvelope {
  let parsed: unknown;
  let text: string;
  try {
    text = decodeText(bytes, ORCAXR_EXTENSION_PATH);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid OrcaXR canonical metadata: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  // Every JSON node costs at least one character, and the ZIP guards already
  // bound how many characters this entry may contain, so the text length is an
  // exact ceiling on the node count. A flat cap instead would refuse to reopen
  // a project this same serializer had just written, once the model carried
  // more painted triangles than the constant allowed.
  assertSafeJsonTree(parsed, ORCAXR_EXTENSION_PATH, Math.max(DEFAULT_JSON_NODE_LIMIT, text.length));
  if (!isRecord(parsed)) throw new Error('OrcaXR canonical metadata must be a JSON object');
  if (parsed.format !== ORCAXR_EXTENSION_FORMAT || parsed.version !== 1) {
    throw new Error(`Unsupported OrcaXR 3MF extension ${String(parsed.format)} version ${String(parsed.version)}`);
  }
  if (!isRecord(parsed.state) || !Array.isArray(parsed.assetEntries)) {
    throw new Error('OrcaXR canonical metadata is missing state or asset entries');
  }
  const assetEntries = parsed.assetEntries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.assetId !== 'string' || typeof entry.path !== 'string') {
      throw new Error(`Invalid OrcaXR asset mapping at index ${index}`);
    }
    return { assetId: entry.assetId as AssetId, path: entry.path };
  });
  return {
    format: ORCAXR_EXTENSION_FORMAT,
    version: 1,
    state: parsed.state as unknown as ProjectState,
    assetEntries,
  };
}

// These persisted fields are required by schema 1 even when unresolved plate
// coordinates or a missing drawing postpone standard BBS regeneration. Otherwise
// malformed recipes can enter the editor and fail only on a later export/edit.
function assertSvgRecipeShapes(state: ProjectState): void {
  const plates = (state as unknown as Record<string, unknown>).plates;
  if (!Array.isArray(plates)) return;
  plates.forEach((plate, pi) => {
    if (!isRecord(plate) || !Array.isArray(plate.objects)) return;
    plate.objects.forEach((object, oi) => {
      if (!isRecord(object) || !Array.isArray(object.volumes)) return;
      object.volumes.forEach((volume, vi) => {
        if (!isRecord(volume) || !Object.hasOwn(volume, 'embossSvg')) return;
        const svg = volume.embossSvg;
        if (
          !isRecord(svg) ||
          typeof svg.pathIn3mf !== 'string' ||
          typeof svg.drawingAssetId !== 'string' ||
          !isStableEntityId(svg.drawingAssetId) ||
          typeof svg.depthMm !== 'number' ||
          !Number.isFinite(svg.depthMm) ||
          typeof svg.widthMm !== 'number' ||
          !Number.isFinite(svg.widthMm) ||
          typeof svg.useSurface !== 'boolean' ||
          (Object.hasOwn(svg, 'sourcePath') && typeof svg.sourcePath !== 'string')
        ) {
          throw new Error(`Invalid SVG emboss recipe at plates[${pi}].objects[${oi}].volumes[${vi}]`);
        }
      });
    });
  });
}

function countLegacyFalseFuzzyAssignments(state: ProjectState): number {
  let count = 0;
  visitLegacyFalseFuzzyAssignments(state, () => {
    count += 1;
  });
  return count;
}

function coerceLegacyFalseFuzzyAssignments(state: ProjectState): number {
  let coerced = 0;
  visitLegacyFalseFuzzyAssignments(state, (assignment) => {
    assignment.value = true;
    coerced += 1;
  });
  return coerced;
}

function visitLegacyFalseFuzzyAssignments(
  state: ProjectState,
  visitor: (assignment: Record<string, unknown>) => void,
): void {
  const plates = (state as unknown as Record<string, unknown>).plates;
  if (!Array.isArray(plates)) return;
  for (const plate of plates) {
    if (!isRecord(plate) || !Array.isArray(plate.objects)) continue;
    for (const object of plate.objects) {
      if (!isRecord(object) || !Array.isArray(object.volumes)) continue;
      for (const volume of object.volumes) {
        if (!isRecord(volume) || !isRecord(volume.annotations) || !Array.isArray(volume.annotations.fuzzySkin)) {
          continue;
        }
        for (const assignment of volume.annotations.fuzzySkin) {
          if (!isRecord(assignment) || assignment.value !== false) continue;
          visitor(assignment);
        }
      }
    }
  }
}

function removeLegacyFalseFuzzyAssignments(state: ProjectState): void {
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      for (const volume of object.volumes) {
        volume.annotations.fuzzySkin = (volume.annotations.fuzzySkin as unknown as Array<{ value: boolean }>).filter(
          (assignment) => assignment.value !== false,
        ) as typeof volume.annotations.fuzzySkin;
      }
    }
  }
}

export const DEFAULT_JSON_NODE_LIMIT = 1_000_000;

export function assertSafeJsonTree(root: unknown, label: string, nodeLimit = DEFAULT_JSON_NODE_LIMIT): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > nodeLimit) throw new Error(`${label} exceeds the JSON node limit`);
    if (depth > 256) throw new Error(`${label} exceeds the JSON nesting limit`);
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} contains unsafe object key ${key}`);
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8`);
  }
}
