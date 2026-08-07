import { UnsupportedModelFormatError, type ModelImportFormat, type UnsupportedModelFormatReason } from './types';

export interface ModelFormatDetection {
  readonly format: ModelImportFormat;
  /** Lower-case extension without the dot, or an empty string. */
  readonly extension: string;
  /** How the decision was reached; extension is only a tie-breaker. */
  readonly evidence: 'signature' | 'signature+extension' | 'text-heuristic';
  /** True when this container is decodable by `decodeModelImport`. */
  readonly decodable: boolean;
  /** Present when `decodable` is false. */
  readonly unsupportedReason?: UnsupportedModelFormatReason;
  readonly detail?: string;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_EMPTY_HEADER = 0x06054b50;
const ZIP_SPANNED_HEADER = 0x08074b50;
/** Bytes inspected for text heuristics; the rest is never sniffed. */
const TEXT_PROBE_BYTES = 8192;

/** Extensions the pinned Snapmaker v2.3.4 file dialogs expose for model input. */
const EXTENSION_FORMATS: Readonly<Record<string, ModelImportFormat>> = Object.freeze({
  stl: 'stl-binary',
  obj: 'obj',
  amf: 'amf',
  amfz: 'amf-compressed',
  zip: 'zip-archive',
  '3mf': 'project-3mf',
  step: 'step',
  stp: 'step',
  svg: 'svg',
  gcode: 'gcode',
  gco: 'gcode',
  g: 'gcode',
});

const UNSUPPORTED_REASONS: Readonly<Partial<Record<ModelImportFormat, UnsupportedModelFormatReason>>> = Object.freeze({
  'project-3mf': 'requires-project-import',
  step: 'requires-native-kernel',
  svg: 'requires-emboss-workflow',
  gcode: 'not-a-model-format',
});

const UNSUPPORTED_DETAIL: Readonly<Partial<Record<ModelImportFormat, string>>> = Object.freeze({
  'project-3mf': 'Open 3MF archives through the project import preview so plates, settings, and paint are preserved.',
  step: 'STEP requires the OpenCASCADE kernel, which is not built into the browser engine; convert to STL/3MF or use a build that exposes the native converter.',
  svg: 'SVG becomes geometry through the emboss/SVG part workflow rather than a mesh decoder.',
  gcode: 'G-code is sliced output, not a model source; open it in the preview instead.',
});

export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Decide which decoder owns these bytes. Content signature always wins; a
 * recognised extension that disagrees with a recognised signature is rejected
 * rather than reinterpreted, so a renamed archive can never be parsed as STL.
 */
export function detectModelFormat(bytes: Uint8Array, filename: string): ModelFormatDetection {
  const extension = fileExtension(filename);
  if (bytes.byteLength === 0) {
    throw new UnsupportedModelFormatError(`${filename || 'The selected file'} is empty`, 'empty-input');
  }

  const signature = detectBySignature(bytes, extension);
  if (signature) return finish(signature.format, extension, signature.evidence, signature.detail);

  const extensionFormat = EXTENSION_FORMATS[extension];
  if (extensionFormat) {
    throw new UnsupportedModelFormatError(
      `${filename} does not contain valid ${extension.toUpperCase()} content`,
      'extension-signature-mismatch',
      extensionFormat,
      'The file signature does not match its extension; OrcaXR never reinterprets the bytes as another format.',
    );
  }
  throw new UnsupportedModelFormatError(
    `${filename || 'The selected file'} is not a recognised model format`,
    'unknown-signature',
    undefined,
    'Supported model sources are STL, OBJ, AMF, and ZIP archives of those formats; 3MF projects use Open Project.',
  );
}

interface SignatureMatch {
  format: ModelImportFormat;
  evidence: ModelFormatDetection['evidence'];
  detail?: string;
}

function detectBySignature(bytes: Uint8Array, extension: string): SignatureMatch | undefined {
  if (isZipSignature(bytes)) return detectZipFlavor(bytes, extension);
  if (isGzipSignature(bytes)) {
    return { format: 'amf-compressed', evidence: 'signature', detail: 'gzip-compressed AMF' };
  }
  if (isBinaryStl(bytes)) return { format: 'stl-binary', evidence: 'signature' };

  const probe = decodeTextProbe(bytes);
  if (probe === undefined) {
    // A binary .stl whose triangle payload does not add up is still STL: let
    // the decoder report the exact truncation rather than a generic mismatch.
    if (extension === 'stl' && bytes.byteLength >= 84) {
      return { format: 'stl-binary', evidence: 'signature+extension', detail: 'binary STL layout' };
    }
    return undefined;
  }
  const trimmed = probe.replace(/^\uFEFF/, '').trimStart();

  if (/^ISO-10303-21\s*;/i.test(trimmed) || /^STEP;/i.test(trimmed)) {
    return { format: 'step', evidence: 'signature' };
  }
  if (trimmed.startsWith('<')) return detectXmlFlavor(trimmed);
  if (isAsciiStl(trimmed)) return { format: 'stl-ascii', evidence: 'signature' };
  if (extension === 'stl' && /^solid\b/i.test(trimmed)) {
    return { format: 'stl-ascii', evidence: 'signature+extension' };
  }
  if (isObjText(trimmed)) {
    return { format: 'obj', evidence: extension === 'obj' ? 'signature+extension' : 'text-heuristic' };
  }
  if (isGcodeText(trimmed)) return { format: 'gcode', evidence: 'text-heuristic' };
  // Only after every text form is ruled out may a padded binary STL match.
  if (isPaddedBinaryStl(bytes)) return { format: 'stl-binary', evidence: 'signature' };
  return undefined;
}

function detectZipFlavor(bytes: Uint8Array, extension: string): SignatureMatch {
  const firstEntry = readFirstLocalEntryName(bytes);
  if (firstEntry === '[Content_Types].xml' || /^3D\/.+\.model$/i.test(firstEntry ?? '')) {
    return { format: 'project-3mf', evidence: 'signature', detail: 'OPC package' };
  }
  if (extension === 'amf' || extension === 'amfz') {
    return { format: 'amf-compressed', evidence: 'signature+extension' };
  }
  if (extension === '3mf') {
    return { format: 'project-3mf', evidence: 'signature+extension' };
  }
  return { format: 'zip-archive', evidence: 'signature' };
}

function detectXmlFlavor(trimmed: string): SignatureMatch | undefined {
  const root = firstElementName(trimmed);
  if (!root) return undefined;
  const local = root.includes(':') ? root.slice(root.indexOf(':') + 1) : root;
  if (local.toLowerCase() === 'amf') return { format: 'amf', evidence: 'signature' };
  if (local.toLowerCase() === 'svg') return { format: 'svg', evidence: 'signature' };
  return undefined;
}

function finish(
  format: ModelImportFormat,
  extension: string,
  evidence: ModelFormatDetection['evidence'],
  detail?: string,
): ModelFormatDetection {
  const declared = EXTENSION_FORMATS[extension];
  if (declared && !isCompatibleExtension(declared, format)) {
    throw new UnsupportedModelFormatError(
      `A .${extension} file cannot contain ${describeFormat(format)} content`,
      'extension-signature-mismatch',
      format,
      'The file signature does not match its extension; OrcaXR never reinterprets the bytes as another format.',
    );
  }
  const unsupportedReason = UNSUPPORTED_REASONS[format];
  return Object.freeze({
    format,
    extension,
    evidence,
    decodable: unsupportedReason === undefined,
    unsupportedReason,
    detail: detail ?? UNSUPPORTED_DETAIL[format],
  });
}

function isCompatibleExtension(declared: ModelImportFormat, detected: ModelImportFormat): boolean {
  if (declared === detected) return true;
  // STL declares one extension for two encodings; AMF may be plain or zipped.
  if (declared === 'stl-binary' && detected === 'stl-ascii') return true;
  if (declared === 'amf' && detected === 'amf-compressed') return true;
  if (declared === 'amf-compressed' && detected === 'amf') return true;
  return false;
}

function describeFormat(format: ModelImportFormat): string {
  switch (format) {
    case 'stl-binary':
      return 'binary STL';
    case 'stl-ascii':
      return 'ASCII STL';
    case 'amf-compressed':
      return 'compressed AMF';
    case 'project-3mf':
      return '3MF package';
    case 'zip-archive':
      return 'ZIP archive';
    default:
      return format.toUpperCase();
  }
}

function isZipSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const word = readUint32LE(bytes, 0);
  return word === ZIP_LOCAL_HEADER || word === ZIP_EMPTY_HEADER || word === ZIP_SPANNED_HEADER;
}

function isGzipSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/**
 * Binary STL is identified structurally: an 84-byte header plus exactly 50
 * bytes per declared triangle. Trailing bytes are tolerated only when the
 * remainder cannot be another whole triangle, matching common exporters.
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const declared = readUint32LE(bytes, 80);
  if (declared === 0) return bytes.byteLength === 84;
  if (declared > 0xffff_ffff / 50) return false;
  const expected = 84 + declared * 50;
  return expected === bytes.byteLength;
}

/**
 * Some exporters append padding after the last facet. Accept that only when
 * the declared triangle payload fits and the remainder is smaller than one
 * more triangle, so arbitrary text can never be read as a binary mesh.
 */
function isPaddedBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const declared = readUint32LE(bytes, 80);
  if (declared === 0 || declared > (bytes.byteLength - 84) / 50) return false;
  return bytes.byteLength - (84 + declared * 50) < 50;
}

function isAsciiStl(trimmed: string): boolean {
  if (!/^solid\b/i.test(trimmed)) return false;
  return /\bfacet\s+normal\b/i.test(trimmed) || /\bendsolid\b/i.test(trimmed) || /\bouter\s+loop\b/i.test(trimmed);
}

function isObjText(trimmed: string): boolean {
  const lines = trimmed.split(/\r?\n/, 400);
  let vertices = 0;
  let structural = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^v(\s|$)/.test(line)) vertices += 1;
    else if (/^(vn|vt|vp|f|o|g|s|usemtl|mtllib|l|p)(\s|$)/.test(line)) structural += 1;
    else return false;
  }
  return vertices > 0 && vertices + structural >= 3;
}

function isGcodeText(trimmed: string): boolean {
  const lines = trimmed.split(/\r?\n/, 80);
  return lines.some((line) => /^(G0|G1|G28|G90|G92|M104|M109|M140)\b/i.test(line.trim()));
}

function firstElementName(trimmed: string): string | undefined {
  let cursor = 0;
  while (cursor < trimmed.length) {
    const open = trimmed.indexOf('<', cursor);
    if (open < 0) return undefined;
    if (trimmed.startsWith('<?', open) || trimmed.startsWith('<!', open)) {
      const close = trimmed.indexOf('>', open + 2);
      if (close < 0) return undefined;
      cursor = close + 1;
      continue;
    }
    const match = /^<\s*([A-Za-z_][\w.:-]*)/.exec(trimmed.slice(open));
    return match?.[1];
  }
  return undefined;
}

/** Returns undefined when the prefix contains bytes no text format may hold. */
function decodeTextProbe(bytes: Uint8Array): string | undefined {
  const probe = bytes.subarray(0, Math.min(bytes.byteLength, TEXT_PROBE_BYTES));
  for (const byte of probe) {
    if (byte === 0) return undefined;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return undefined;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(probe);
}

function readFirstLocalEntryName(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 30 || readUint32LE(bytes, 0) !== ZIP_LOCAL_HEADER) return undefined;
  const nameLength = bytes[26] | (bytes[27] << 8);
  if (nameLength === 0 || 30 + nameLength > bytes.byteLength || nameLength > 1024) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(30, 30 + nameLength));
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
