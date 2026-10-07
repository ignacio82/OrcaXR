import type { ProjectState } from '../domain/model';
import { CORE_MODEL_PATH, MODEL_RELS_PATH } from './bbsCore';
import { ORCAXR_EXTENSION_PATH, ORCAXR_EXTENSION_FORMAT } from './CanonicalEnvelope';
import { validatePackagePath } from './deterministicZip';
import { opcLowercase } from './opcLowercase';

const CONTENT_TYPES_PATH = '[Content_Types].xml';
const ROOT_RELATIONSHIPS_PATH = '_rels/.rels';
const OPC_RELATIONSHIPS_KEY = `${ORCAXR_EXTENSION_FORMAT}/opc-relationships`;
const OPC_CONTENT_TYPES_KEY = `${ORCAXR_EXTENSION_FORMAT}/opc-content-types`;
const CONTENT_TYPE_EXTENSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

interface PreservedOpcRelationship {
  source: '/' | typeof CORE_MODEL_PATH;
  id: string;
  type: string;
  target: string;
  targetMode: 'Internal' | 'External';
}

type PreservedContentType =
  | { kind: 'default'; extension: string; contentType: string }
  | { kind: 'override'; partName: string; contentType: string };

export function buildRootRelationships(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): string {
  if (!files.has(CORE_MODEL_PATH) || !files.has(ORCAXR_EXTENSION_PATH)) {
    throw new Error('Canonical OPC relationships require the model and project-state members');
  }
  const fixed: PreservedOpcRelationship[] = [
    {
      source: '/',
      id: 'rel-3dmodel',
      type: 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel',
      target: '/3D/3dmodel.model',
      targetMode: 'Internal',
    },
    {
      source: '/',
      id: 'rel-orcaxr-project',
      type: `${ORCAXR_EXTENSION_FORMAT}/relationships/project-state`,
      target: `/${ORCAXR_EXTENSION_PATH}`,
      targetMode: 'Internal',
    },
  ];
  return relationshipDocument('/', fixed, resolvableRelationships(state, files, warnings));
}

export function buildPartRelationships(
  state: ProjectState,
  source: typeof CORE_MODEL_PATH,
  files: ReadonlyMap<string, Uint8Array>,
): string {
  return relationshipDocument(source, [], resolvableRelationships(state, files, []));
}

/**
 * Preserved relationships whose target is actually in this package.
 *
 * A projection may legitimately omit preserved members — the one-plate slice
 * archive drops every opaque entry — and an OPC relationship to a missing part
 * makes the whole package unreadable: the pinned engine reports
 * "Archive does not contain a valid model" and loads nothing. Dropping the
 * dangling row keeps the package loadable and records what was dropped.
 */
function resolvableRelationships(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): PreservedOpcRelationship[] {
  const kept: PreservedOpcRelationship[] = [];
  const dropped: string[] = [];
  for (const relationship of readPreservedRelationships(state)) {
    if (
      relationship.targetMode === 'External' ||
      files.has(resolveRelationshipTarget(relationship.source, relationship.target))
    ) {
      kept.push(relationship);
      continue;
    }
    dropped.push(relationship.target);
  }
  if (dropped.length > 0) {
    warnings.push(
      `Dropped ${dropped.length} preserved package relationship(s) whose target is not part of this archive: ${[
        ...new Set(dropped),
      ]
        .sort()
        .join(', ')}`,
    );
  }
  return kept;
}

function relationshipDocument(
  source: '/' | typeof CORE_MODEL_PATH,
  fixed: PreservedOpcRelationship[],
  preserved: PreservedOpcRelationship[],
): string {
  const rows = [...fixed, ...preserved.filter((relationship) => relationship.source === source)];
  const ids = new Set<string>();
  for (const relationship of rows) {
    if (ids.has(relationship.id)) {
      throw new Error(`Duplicate OPC relationship ID ${relationship.id} for ${source}`);
    }
    ids.add(relationship.id);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...rows
      .sort(
        (left, right) =>
          compareText(left.id, right.id) ||
          compareText(left.type, right.type) ||
          compareText(left.target, right.target),
      )
      .map(
        (relationship) =>
          ` <Relationship Id="${xmlAttribute(relationship.id)}" Type="${xmlAttribute(
            relationship.type,
          )}" Target="${xmlAttribute(relationship.target)}"${
            relationship.targetMode === 'External' ? ' TargetMode="External"' : ''
          }/>`,
      ),
    '</Relationships>',
    '',
  ].join('\n');
}

export function mergePackageRelationships(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): void {
  const merged = new Map<string, PreservedOpcRelationship>();
  for (const relationship of readPreservedRelationships(state)) {
    merged.set(relationshipKey(relationship), relationship);
  }
  for (const [path, source] of [
    [ROOT_RELATIONSHIPS_PATH, '/'],
    [MODEL_RELS_PATH, CORE_MODEL_PATH],
  ] as const) {
    const bytes = files.get(path);
    if (!bytes) continue;
    const xml = decodeText(bytes, path);
    const seenIds = new Set<string>();
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attributes = parseXmlAttributes(match[1]);
      const id = attributes.Id ?? attributes.id;
      const type = attributes.Type ?? attributes.type;
      const target = attributes.Target ?? attributes.target;
      if (!id || !type || !target) {
        warnings.push(`Ignored an incomplete OPC relationship in ${path}`);
        continue;
      }
      if (seenIds.has(id)) throw new Error(`Duplicate OPC relationship ID ${id} in ${path}`);
      seenIds.add(id);
      const targetMode = /^external$/i.test(attributes.TargetMode ?? attributes.targetMode ?? '')
        ? 'External'
        : 'Internal';
      const relationship: PreservedOpcRelationship = { source, id, type, target, targetMode };
      if (isGeneratedRelationship(relationship)) continue;
      if (targetMode === 'Internal') {
        const resolved = resolveRelationshipTarget(source, target);
        if (!files.has(resolved)) {
          warnings.push(`Preserved OPC relationship ${id} from ${path}, but target ${resolved} is missing`);
        }
      }
      merged.set(relationshipKey(relationship), relationship);
    }
  }
  if (merged.size === 0) return;
  state.extensionData = {
    ...(state.extensionData ?? {}),
    [OPC_RELATIONSHIPS_KEY]: [...merged.values()]
      .sort((left, right) => compareText(relationshipKey(left), relationshipKey(right)))
      .map((relationship) => ({ ...relationship })),
  };
}

export function readPreservedRelationships(state: ProjectState): PreservedOpcRelationship[] {
  const raw = state.extensionData?.[OPC_RELATIONSHIPS_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${OPC_RELATIONSHIPS_KEY} must be an array`);
  return raw.map((entry, index) => {
    if (
      !isRecord(entry) ||
      (entry.source !== '/' && entry.source !== CORE_MODEL_PATH) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.type !== 'string' ||
      !entry.type ||
      typeof entry.target !== 'string' ||
      !entry.target ||
      (entry.targetMode !== 'Internal' && entry.targetMode !== 'External')
    ) {
      throw new Error(`Invalid preserved OPC relationship at index ${index}`);
    }
    if (entry.targetMode === 'Internal') resolveRelationshipTarget(entry.source, entry.target);
    return {
      source: entry.source,
      id: entry.id,
      type: entry.type,
      target: entry.target,
      targetMode: entry.targetMode,
    };
  });
}

function isGeneratedRelationship(relationship: PreservedOpcRelationship): boolean {
  if (relationship.source !== '/') return false;
  if (
    relationship.type === 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel' &&
    resolveRelationshipTarget('/', relationship.target) === CORE_MODEL_PATH
  ) {
    return true;
  }
  return (
    relationship.type === `${ORCAXR_EXTENSION_FORMAT}/relationships/project-state` &&
    resolveRelationshipTarget('/', relationship.target) === ORCAXR_EXTENSION_PATH
  );
}

function relationshipKey(relationship: PreservedOpcRelationship): string {
  return [relationship.source, relationship.id, relationship.type, relationship.target, relationship.targetMode].join(
    '\u0000',
  );
}

export function resolveRelationshipTarget(source: '/' | typeof CORE_MODEL_PATH, target: string): string {
  const withoutFragment = target.split(/[?#]/, 1)[0];
  const segments = withoutFragment.startsWith('/') ? [] : source === '/' ? [] : source.split('/').slice(0, -1);
  for (const segment of withoutFragment.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`OPC relationship target escapes the package: ${target}`);
      segments.pop();
      continue;
    }
    if (segment.includes('\\') || segment.includes('\u0000')) {
      throw new Error(`Unsafe OPC relationship target ${target}`);
    }
    segments.push(segment);
  }
  const resolved = segments.join('/');
  validatePackagePath(resolved);
  return resolved;
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attributes = Object.create(null) as Record<string, string>;
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (Object.hasOwn(attributes, match[1])) throw new Error(`Duplicate XML attribute ${match[1]}`);
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) return safeCodePoint(Number(decimal), entity);
      if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
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

function safeCodePoint(value: number, original: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10_ffff || (value >= 0xd800 && value <= 0xdfff)) {
    throw new Error(`Invalid XML character reference ${original}`);
  }
  return String.fromCodePoint(value);
}

export function mergePackageContentTypes(
  state: ProjectState,
  files: ReadonlyMap<string, Uint8Array>,
  warnings: string[],
): void {
  const bytes = files.get(CONTENT_TYPES_PATH);
  if (!bytes) {
    warnings.push(`3MF is missing ${CONTENT_TYPES_PATH}; a valid content-type manifest will be generated on save`);
    return;
  }
  const xml = decodeText(bytes, CONTENT_TYPES_PATH);
  const preserved = new Map<string, PreservedContentType>();
  for (const entry of readPreservedContentTypes(state)) {
    preserved.set(contentTypeKey(entry), entry);
  }
  for (const match of xml.matchAll(/<(Default|Override)\b([^>]*)\/?\s*>/gi)) {
    const attributes = parseXmlAttributes(match[2]);
    const contentType = attributes.ContentType ?? attributes.contentType;
    if (!contentType) throw new Error(`${CONTENT_TYPES_PATH} contains an entry without ContentType`);
    if (/^default$/i.test(match[1])) {
      const extension = attributes.Extension ?? attributes.extension;
      if (!extension || !CONTENT_TYPE_EXTENSION.test(extension)) {
        throw new Error(`${CONTENT_TYPES_PATH} contains an invalid default extension`);
      }
      const expected = inferredContentTypeForExtension(extension, files);
      if (expected === contentType) continue;
      const entry: PreservedContentType = { kind: 'default', extension, contentType };
      preserved.set(contentTypeKey(entry), entry);
      continue;
    }
    const partName = attributes.PartName ?? attributes.partName;
    if (!partName?.startsWith('/')) throw new Error(`${CONTENT_TYPES_PATH} contains an invalid PartName`);
    const resolved = partName.slice(1);
    validatePackagePath(resolved);
    if (resolved === ORCAXR_EXTENSION_PATH && contentType === 'application/vnd.orcaxr.project+json') continue;
    if (files.has(resolved) && !defaultExtensionForPath(resolved) && contentType === mediaTypeForPath(resolved))
      continue;
    if (!files.has(resolved)) {
      warnings.push(`Preserved content-type override for missing package part ${partName}`);
    }
    const entry: PreservedContentType = { kind: 'override', partName, contentType };
    preserved.set(contentTypeKey(entry), entry);
  }
  if (preserved.size === 0) return;
  state.extensionData = {
    ...(state.extensionData ?? {}),
    [OPC_CONTENT_TYPES_KEY]: [...preserved.values()]
      .sort((left, right) => compareText(contentTypeKey(left), contentTypeKey(right)))
      .map((entry) => ({ ...entry })),
  };
}

function readPreservedContentTypes(state: ProjectState): PreservedContentType[] {
  const raw = state.extensionData?.[OPC_CONTENT_TYPES_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${OPC_CONTENT_TYPES_KEY} must be an array`);
  return raw.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.contentType !== 'string' ||
      !entry.contentType ||
      (entry.kind !== 'default' && entry.kind !== 'override')
    ) {
      throw new Error(`Invalid preserved content type at index ${index}`);
    }
    if (entry.kind === 'default') {
      if (typeof entry.extension !== 'string' || !CONTENT_TYPE_EXTENSION.test(entry.extension)) {
        throw new Error(`Invalid preserved default content type at index ${index}`);
      }
      return { kind: 'default', extension: entry.extension, contentType: entry.contentType };
    }
    if (typeof entry.partName !== 'string' || !entry.partName.startsWith('/')) {
      throw new Error(`Invalid preserved content-type override at index ${index}`);
    }
    validatePackagePath(entry.partName.slice(1));
    return { kind: 'override', partName: entry.partName, contentType: entry.contentType };
  });
}

function contentTypeKey(entry: PreservedContentType): string {
  return entry.kind === 'default' ? `default\u0000${opcLowercase(entry.extension)}` : `override\u0000${entry.partName}`;
}

function inferredContentTypeForExtension(
  extension: string,
  files: ReadonlyMap<string, Uint8Array>,
): string | undefined {
  const suffix = `.${opcLowercase(extension)}`;
  const path = [...files.keys()].find((candidate) => opcLowercase(candidate).endsWith(suffix));
  return path ? mediaTypeForPath(path) : undefined;
}

function defaultExtensionForPath(path: string): string | undefined {
  const extension = path.includes('.') ? opcLowercase(path.slice(path.lastIndexOf('.') + 1)) : '';
  return CONTENT_TYPE_EXTENSION.test(extension) ? extension : undefined;
}

export function buildContentTypes(files: ReadonlyMap<string, Uint8Array>, state: ProjectState): string {
  const preserved = readPreservedContentTypes(state);
  const types = new Map<string, string>(
    preserved
      .filter((entry): entry is Extract<PreservedContentType, { kind: 'default' }> => entry.kind === 'default')
      .map((entry) => [opcLowercase(entry.extension), entry.contentType]),
  );
  const required = new Map<string, string>([
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['model', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'],
  ]);
  for (const [extension, contentType] of required) {
    const existing = types.get(extension);
    if (existing && existing !== contentType) {
      throw new Error(`Preserved .${extension} content type conflicts with the required OPC/3MF type`);
    }
    types.set(extension, contentType);
  }
  const overrides = new Map(
    preserved
      .filter((entry): entry is Extract<PreservedContentType, { kind: 'override' }> => entry.kind === 'override')
      .map((entry) => [entry.partName, entry.contentType]),
  );
  for (const path of files.keys()) {
    if (path === CONTENT_TYPES_PATH) continue;
    const extension = defaultExtensionForPath(path);
    if (extension) {
      if (!types.has(extension)) types.set(extension, mediaTypeForPath(path));
    } else if (!overrides.has(`/${path}`)) {
      // Preserve arbitrary valid member names without generating a Default that
      // our importer rejects. Explicit per-part declarations keep precedence.
      overrides.set(`/${path}`, mediaTypeForPath(path));
    }
  }
  overrides.set(`/${ORCAXR_EXTENSION_PATH}`, 'application/vnd.orcaxr.project+json');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ...[...types.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([extension, mediaType]) =>
          ` <Default Extension="${xmlAttribute(extension)}" ContentType="${xmlAttribute(mediaType)}"/>`,
      ),
    ...[...overrides.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([partName, contentType]) =>
          ` <Override PartName="${xmlAttribute(partName)}" ContentType="${xmlAttribute(contentType)}"/>`,
      ),
    '</Types>',
    '',
  ].join('\n');
}

export function mediaTypeForPath(path: string): string {
  const lower = opcLowercase(path);
  if (lower.endsWith('.rels')) return 'application/vnd.openxmlformats-package.relationships+xml';
  if (lower.endsWith('.model')) return 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.xml') || lower.endsWith('.config')) return 'text/xml';
  if (lower.endsWith('.txt') || lower.endsWith('.gcode')) return 'text/plain';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function xmlAttribute(value: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new Error('XML attribute contains a character XML 1.0 cannot represent');
    }
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
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
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
