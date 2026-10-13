/**
 * The hosts' contract for the File menu's model exports and the names its
 * outputs are offered under, every answer from the production modules
 * (`stlExport.ts`, `outputNames.ts`, the project serializer's name). The
 * shared Rust core answers the same requests (`orcaxr_archive::exports`).
 *
 * - STL `{"archive","selectedInstanceIds"}` on a project and its assets →
 *   the reply `{"filename","instanceCount","instanceIds","mediaType",
 *   "triangleCount"}` with the file's bytes — Export as one STL… (`archive`
 *   false: the selected instances on the active plate, else all of them,
 *   merged) or Export all objects as STLs… (true: one STL per instance in a
 *   ZIP, a lone instance its own STL) — or `{"error"}`, the export's own
 *   words, and no bytes;
 * - Export as 3MF… of a project snapshot → the reply `{"filename",
 *   "mediaType","warnings"}` with the package's bytes — the serializer's own
 *   Save, which the browser's Export as 3MF… is — or `{"refused":
 *   "unsavable_project"}` for a project the serializer refuses, and no bytes;
 * - name `{"kind","name"}` (`kind` one of `plate-gcode`, `toolpath-obj`,
 *   `stl`, `project`; `name` text, or null for a plate the project lacks) →
 *   `{"filename"}`.
 *
 * A malformed request is refused as `invalid_request`.
 */
import type { AssetRepository } from '../assets';
import { canonicalStringify } from '../domain/canonical';
import type { InstanceId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { Bbs3mfProjectSerializer, suggestedProjectFilename } from '../serialization/Bbs3mfProjectSerializer';
import type { ProjectArchiveSnapshot } from '../ports';
import { plateGcodeFilename, toolpathObjFilename } from '../outputNames';
import {
  activePlateInstanceIds,
  exportCanonicalStlArchive,
  exportCanonicalStlFile,
  selectedActivePlateInstanceIds,
  stlExportInstanceIds,
  suggestedStlFilename,
} from './stlExport';

export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function fields(request: string, keys: readonly string[]): JsonObject {
  let value: Json;
  try {
    value = JSON.parse(request) as Json;
  } catch {
    invalid();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}

/** One export through the File menu's STL actions: the reply and, unless it failed, the file. */
export function stlExportExchange(
  state: ProjectState,
  assets: AssetRepository,
  request: string,
): { reply: string; bytes?: Uint8Array } {
  const value = fields(request, ['archive', 'selectedInstanceIds']);
  const archive = value.archive;
  const selected = value.selectedInstanceIds;
  if (typeof archive !== 'boolean' || !Array.isArray(selected) || selected.some((id) => typeof id !== 'string'))
    invalid();
  const selection = selected as InstanceId[];
  let instanceIds: InstanceId[];
  try {
    let exported;
    if (archive) {
      const chosen = selectedActivePlateInstanceIds(state, selection);
      instanceIds = chosen.length > 0 ? chosen : activePlateInstanceIds(state);
      exported = exportCanonicalStlArchive(state, assets, chosen.length > 0 ? chosen : undefined);
    } else {
      instanceIds = stlExportInstanceIds(state, selection);
      exported = exportCanonicalStlFile(state, assets, instanceIds);
    }
    return {
      reply: canonicalStringify({
        filename: exported.suggestedFilename,
        instanceCount: exported.instanceCount,
        instanceIds,
        mediaType: exported.mediaType,
        triangleCount: exported.triangleCount,
      }),
      bytes: exported.bytes,
    };
  } catch (error) {
    return { reply: canonicalStringify({ error: error instanceof Error ? error.message : String(error) }) };
  }
}

/** Export as 3MF…: the project's package as the browser saves it. */
export async function projectArchiveExportExchange(
  snapshot: ProjectArchiveSnapshot,
): Promise<{ reply: string; bytes?: Uint8Array }> {
  let saved;
  try {
    saved = await new Bbs3mfProjectSerializer().serialize(snapshot);
  } catch {
    return { reply: canonicalStringify({ refused: 'unsavable_project' }) };
  }
  return {
    reply: canonicalStringify({
      filename: saved.suggestedFilename,
      mediaType: saved.mediaType,
      warnings: saved.warnings,
    }),
    bytes: saved.bytes,
  };
}

/** The name an output is offered under. */
export function exportNameExchange(request: string): string {
  const value = fields(request, ['kind', 'name']);
  const name = value.name;
  if (name !== null && typeof name !== 'string') invalid();
  const filename = (() => {
    switch (value.kind) {
      case 'plate-gcode':
        return plateGcodeFilename(name ?? undefined);
      case 'toolpath-obj':
        return toolpathObjFilename(name ?? undefined);
      case 'stl':
        return name === null ? invalid() : suggestedStlFilename(name);
      case 'project':
        return name === null ? invalid() : suggestedProjectFilename(name);
      default:
        return invalid();
    }
  })();
  return canonicalStringify({ filename });
}
