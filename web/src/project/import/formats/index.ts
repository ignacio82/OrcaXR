import { gunzipSync } from 'fflate';

import { UnsafeThreeMfArchiveError, readSafeZip, validatePackagePath } from '../../serialization/deterministicZip';
import { decodeAmf } from './amf';
import { detectModelFormat, fileExtension, type ModelFormatDetection } from './detect';
import { decodeObj } from './obj';
import { decodeStl } from './stl';
import {
  MalformedModelSourceError,
  UnsupportedModelFormatError,
  resolveModelImportLimits,
  type DecodedImportNotice,
  type DecodedModelImport,
  type DecodedObject,
  type ModelImportLimits,
} from './types';

export * from './types';
export { detectModelFormat, fileExtension, type ModelFormatDetection } from './detect';

export interface DecodeModelImportOptions {
  readonly filename: string;
  readonly limits?: Partial<ModelImportLimits>;
  /** Depth guard for archives that themselves contain archives. */
  readonly nestingDepth?: number;
  /** Resolves sibling files such as an OBJ `mtllib`; archives supply members. */
  readonly resolveCompanion?: (name: string) => Uint8Array | undefined;
}

/** Model containers this build can decode into canonical geometry. */
export const SUPPORTED_MODEL_IMPORT_EXTENSIONS: readonly string[] = Object.freeze(['stl', 'obj', 'amf', 'amfz', 'zip']);

/**
 * Signature-first model decode shared by the picker, drag/drop, archives, and
 * automation. Recognised-but-undecodable containers raise
 * `UnsupportedModelFormatError` with a machine-readable reason so the caller
 * can explain the real limitation instead of guessing another parser.
 */
export function decodeModelImport(bytes: Uint8Array, options: DecodeModelImportOptions): DecodedModelImport {
  const limits = resolveModelImportLimits(options.limits);
  const filename = options.filename;
  if (bytes.byteLength > limits.maxBytes) {
    throw new MalformedModelSourceError(
      `${filename} is ${bytes.byteLength.toLocaleString('en-US')} bytes, above the ${limits.maxBytes.toLocaleString('en-US')} byte import limit`,
      'limit-exceeded',
    );
  }
  const detection = detectModelFormat(bytes, filename);
  if (!detection.decodable) {
    throw new UnsupportedModelFormatError(
      unsupportedMessage(filename, detection),
      detection.unsupportedReason ?? 'unknown-signature',
      detection.format,
      detection.detail,
    );
  }

  switch (detection.format) {
    case 'stl-binary':
    case 'stl-ascii':
      return decodeStl(bytes, { filename, limits, format: detection.format });
    case 'obj':
      return decodeObj(bytes, { filename, limits, resolveCompanion: options.resolveCompanion });
    case 'amf':
      return decodeAmf(bytes, { filename, limits });
    case 'amf-compressed':
      return decodeCompressedAmf(bytes, filename, limits);
    case 'zip-archive':
      return decodeArchive(bytes, filename, limits, options.nestingDepth ?? 0);
    default:
      throw new UnsupportedModelFormatError(
        unsupportedMessage(filename, detection),
        'unknown-signature',
        detection.format,
      );
  }
}

function unsupportedMessage(filename: string, detection: ModelFormatDetection): string {
  switch (detection.unsupportedReason) {
    case 'requires-project-import':
      return `${filename} is a 3MF package; open it with Open Project so plates, settings, and paint are preserved`;
    case 'requires-native-kernel':
      return `${filename} is a STEP file, which this build cannot convert to a mesh`;
    case 'requires-emboss-workflow':
      return `${filename} is an SVG; import it through the SVG/emboss workflow`;
    case 'not-a-model-format':
      return `${filename} is G-code, not a model source`;
    default:
      return `${filename} is not a supported model format`;
  }
}

function decodeCompressedAmf(bytes: Uint8Array, filename: string, limits: ModelImportLimits): DecodedModelImport {
  const inner = bytes[0] === 0x1f ? gunzipAmf(bytes, filename, limits) : unzipSingleAmf(bytes, filename, limits);
  const decoded = decodeAmf(inner.bytes, { filename: inner.name, limits });
  return Object.freeze({
    ...decoded,
    format: 'amf-compressed' as const,
    filename,
    notices: Object.freeze([
      ...decoded.notices,
      {
        kind: 'ignored-member' as const,
        code: 'amf-compressed-member',
        path: filename,
        message: `Decompressed AMF member "${inner.name}"`,
      },
    ]),
  });
}

function gunzipAmf(
  bytes: Uint8Array,
  filename: string,
  limits: ModelImportLimits,
): { bytes: Uint8Array; name: string } {
  try {
    const inflated = gunzipSync(bytes);
    if (inflated.byteLength > limits.maxBytes) {
      throw new MalformedModelSourceError(
        `${filename} expands beyond the import size limit`,
        'limit-exceeded',
        'amf-compressed',
      );
    }
    return { bytes: inflated, name: filename.replace(/\.(amfz|gz)$/i, '') || filename };
  } catch (error) {
    if (error instanceof MalformedModelSourceError) throw error;
    throw new MalformedModelSourceError(
      `${filename} is not a readable gzip AMF: ${error instanceof Error ? error.message : String(error)}`,
      'invalid-syntax',
      'amf-compressed',
    );
  }
}

function unzipSingleAmf(
  bytes: Uint8Array,
  filename: string,
  limits: ModelImportLimits,
): { bytes: Uint8Array; name: string } {
  const members = readArchiveMembers(bytes, filename, limits);
  const candidates = [...members].filter(([path]) => fileExtension(path) === 'amf');
  if (candidates.length !== 1) {
    throw new MalformedModelSourceError(
      `${filename} must contain exactly one .amf member; found ${candidates.length}`,
      'invalid-syntax',
      'amf-compressed',
    );
  }
  return { bytes: candidates[0][1], name: candidates[0][0] };
}

function readArchiveMembers(bytes: Uint8Array, filename: string, limits: ModelImportLimits): Map<string, Uint8Array> {
  let members: Map<string, Uint8Array>;
  try {
    members = readSafeZip(bytes, { maxArchiveBytes: limits.maxBytes, maxEntries: limits.maxArchiveMembers });
  } catch (error) {
    if (error instanceof UnsafeThreeMfArchiveError) {
      throw new MalformedModelSourceError(`${filename}: ${error.message}`, 'unsafe-archive', 'zip-archive');
    }
    throw new MalformedModelSourceError(
      `${filename} is not a readable archive: ${error instanceof Error ? error.message : String(error)}`,
      'unsafe-archive',
      'zip-archive',
    );
  }
  for (const path of members.keys()) {
    try {
      validatePackagePath(path);
    } catch (error) {
      throw new MalformedModelSourceError(
        `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        'unsafe-archive',
        'zip-archive',
      );
    }
  }
  return members;
}

/**
 * Decode every supported model inside a ZIP as one atomic import. Unsupported
 * members are reported, never reinterpreted, and a single failing member fails
 * the whole archive so a partial scene can never be committed.
 */
function decodeArchive(
  bytes: Uint8Array,
  filename: string,
  limits: ModelImportLimits,
  nestingDepth: number,
): DecodedModelImport {
  if (nestingDepth > 0) {
    throw new MalformedModelSourceError(
      `${filename} contains nested archives, which are not imported`,
      'unsafe-archive',
      'zip-archive',
    );
  }
  const members = readArchiveMembers(bytes, filename, limits);
  const notices: DecodedImportNotice[] = [];
  const objects: DecodedObject[] = [];
  const resolveCompanion = (name: string): Uint8Array | undefined => {
    const target = name.replace(/^\.\//, '').toLowerCase();
    for (const [path, member] of members) {
      if (path.toLowerCase() === target || path.toLowerCase().endsWith(`/${target}`)) return member;
    }
    return undefined;
  };

  const sorted = [...members.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  let decodedMembers = 0;
  let sourceUnit = 'millimeter';
  let unitScaleToMm = 1;

  for (const path of sorted) {
    const member = members.get(path) as Uint8Array;
    const extension = fileExtension(path);
    if (!SUPPORTED_MODEL_IMPORT_EXTENSIONS.includes(extension) || extension === 'zip') {
      notices.push({
        kind: 'ignored-member',
        code: 'archive-member-skipped',
        path,
        message: `Skipped "${path}"; ${extension ? `.${extension} members are not model sources` : 'it has no model extension'}`,
      });
      continue;
    }
    const decoded = decodeModelImport(member, {
      filename: path,
      limits,
      nestingDepth: nestingDepth + 1,
      resolveCompanion,
    });
    decodedMembers += 1;
    if (decoded.unitScaleToMm !== 1) {
      // Archives may mix units; each member is converted before it is merged.
      sourceUnit = decoded.sourceUnit;
      unitScaleToMm = 1;
      objects.push(...decoded.objects.map((object) => scaleObject(object, decoded.unitScaleToMm)));
      notices.push({
        kind: 'unit-conversion',
        code: 'archive-member-unit-converted',
        path,
        message: `Converted ${decoded.sourceUnit} member coordinates to millimetres (×${decoded.unitScaleToMm})`,
      });
    } else {
      objects.push(...decoded.objects);
    }
    notices.push(...decoded.notices.filter((notice) => notice.code !== 'archive-member-unit-converted'));
    if (objects.length > limits.maxObjects) {
      throw new MalformedModelSourceError(
        `${filename} expands to more than ${limits.maxObjects} objects`,
        'limit-exceeded',
        'zip-archive',
      );
    }
  }

  if (decodedMembers === 0 || objects.length === 0) {
    throw new MalformedModelSourceError(
      `${filename} contains no supported model members (${SUPPORTED_MODEL_IMPORT_EXTENSIONS.filter(
        (extension) => extension !== 'zip',
      )
        .map((extension) => `.${extension}`)
        .join(', ')})`,
      'no-geometry',
      'zip-archive',
    );
  }
  notices.unshift({
    kind: 'ignored-member',
    code: 'archive-members-imported',
    path: filename,
    message: `Imported ${decodedMembers} model member${decodedMembers === 1 ? '' : 's'} from the archive as one transaction`,
  });

  return Object.freeze({
    format: 'zip-archive',
    filename,
    unitScaleToMm,
    sourceUnit,
    objects: Object.freeze(objects),
    notices: Object.freeze(notices),
  });
}

/** Pre-multiply a decoded member so mixed-unit archives share one scale. */
function scaleObject(object: DecodedObject, scale: number): DecodedObject {
  return Object.freeze({
    name: object.name,
    volumes: Object.freeze(
      object.volumes.map((volume) =>
        Object.freeze({
          ...volume,
          mesh: Object.freeze({
            positions: Float32Array.from(volume.mesh.positions, (value) => value * scale),
            indices: volume.mesh.indices,
          }),
        }),
      ),
    ),
    instances: Object.freeze(
      object.instances.map((instance) =>
        Object.freeze({
          ...instance,
          transform: {
            ...instance.transform,
            translationMm: instance.transform.translationMm.map(
              (value) => value * scale,
            ) as unknown as typeof instance.transform.translationMm,
          },
        }),
      ),
    ),
  });
}
