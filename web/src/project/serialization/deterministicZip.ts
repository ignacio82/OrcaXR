import { unzipSync, zipSync, type Zippable } from 'fflate';

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb8_8320 : 0);
  }
  return value >>> 0;
});

export interface ZipSafetyLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
  maxPathBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipSafetyLimits = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 2048 * 1024 * 1024,
  maxCompressionRatio: 1000,
  maxPathBytes: 512,
});

export class UnsafeThreeMfArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeThreeMfArchiveError';
  }
}

interface CentralEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  directory: boolean;
}

export function readSafeZip(archive: Uint8Array, limits: Partial<ZipSafetyLimits> = {}): Map<string, Uint8Array> {
  const effective = resolveLimits(limits);
  if (archive.byteLength > effective.maxArchiveBytes) {
    throw new UnsafeThreeMfArchiveError(
      `Archive is ${archive.byteLength} bytes; limit is ${effective.maxArchiveBytes}`,
    );
  }
  const centralEntries = inspectCentralDirectory(archive, effective);
  let expanded: Record<string, Uint8Array>;
  try {
    expanded = unzipSync(archive);
  } catch (error) {
    throw new UnsafeThreeMfArchiveError(
      `Invalid or corrupt ZIP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = new Map<string, Uint8Array>();
  for (const entry of centralEntries) {
    if (entry.directory) continue;
    const bytes = expanded[entry.path];
    if (!bytes) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${entry.path} is missing after expansion`);
    }
    if (bytes.byteLength !== entry.uncompressedSize) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${entry.path} expanded to an unexpected size`);
    }
    if (crc32(bytes) !== entry.crc32) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${entry.path} failed its CRC-32 integrity check`);
    }
    result.set(entry.path, bytes.slice());
  }
  return result;
}

export function writeDeterministicZip(
  files: ReadonlyMap<string, Uint8Array>,
  limits: Partial<ZipSafetyLimits> = {},
): Uint8Array {
  const effective = resolveLimits(limits);
  if (files.size > effective.maxEntries) {
    throw new UnsafeThreeMfArchiveError(`Archive has ${files.size} entries; limit is ${effective.maxEntries}`);
  }
  let total = 0;
  const zippable: Zippable = {};
  const fixedLocalTime = new Date(1980, 0, 1, 0, 0, 0, 0);
  const paths = [...files.keys()].sort(compareText);
  for (const path of paths) {
    validatePackagePath(path, effective.maxPathBytes);
    const bytes = files.get(path)!;
    if (bytes.byteLength > effective.maxEntryBytes) {
      throw new UnsafeThreeMfArchiveError(
        `Entry ${path} is ${bytes.byteLength} bytes; limit is ${effective.maxEntryBytes}`,
      );
    }
    total += bytes.byteLength;
    if (total > effective.maxTotalUncompressedBytes) {
      throw new UnsafeThreeMfArchiveError('Archive exceeds the total uncompressed-size limit');
    }
    const alreadyCompressed = /\.(?:3mf|jpe?g|mp4|png|webp|zip)$/i.test(path);
    zippable[path] = [
      bytes,
      {
        level: alreadyCompressed ? 0 : 6,
        mtime: fixedLocalTime,
        os: 3,
        attrs: 0o644 << 16,
      },
    ];
  }
  const output = zipSync(zippable, { level: 6 });
  if (output.byteLength > effective.maxArchiveBytes) {
    throw new UnsafeThreeMfArchiveError('Generated archive exceeds the archive-size limit');
  }
  return output;
}

export function validatePackagePath(path: string, maxPathBytes = 512): void {
  if (!path || path.includes('\u0000') || path.includes('\\')) {
    throw new UnsafeThreeMfArchiveError(`Unsafe package path ${JSON.stringify(path)}`);
  }
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) {
    throw new UnsafeThreeMfArchiveError(`Package path must be relative: ${path}`);
  }
  for (const character of path) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new UnsafeThreeMfArchiveError(`Package path contains an invalid character: ${JSON.stringify(path)}`);
    }
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new UnsafeThreeMfArchiveError(`Package path contains an unsafe segment: ${path}`);
  }
  if (utf8Length(path) > maxPathBytes) {
    throw new UnsafeThreeMfArchiveError(`Package path is too long: ${path}`);
  }
}

/**
 * The ZIP64 end-of-central-directory record, when the classic one holds
 * sentinels.
 *
 * Only the four fields the classic record could not hold are taken. Everything
 * that bounds this archive — entry count, directory extent, per-path checks,
 * total uncompressed size — is applied afterwards to these values exactly as it
 * is to the classic ones, so a ZIP64 archive gets no more latitude than any
 * other. Sizes are read as 64-bit and refused if they exceed what a browser
 * should hold, which is the concern the outright refusal was standing in for.
 */
function readZip64Eocd(
  archive: Uint8Array,
  view: DataView,
  eocd: number,
): {
  entriesOnDisk: number;
  entryCount: number;
  centralSize: number;
  centralOffset: number;
  recordOffset: number;
} {
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
    throw new UnsafeThreeMfArchiveError('ZIP64 end-of-central-directory locator is missing');
  }
  if (view.getUint32(locator + 4, true) !== 0 || view.getUint32(locator + 16, true) !== 1) {
    throw new UnsafeThreeMfArchiveError('Multi-disk ZIP64 archives are not supported');
  }
  const recordOffset = readUint64(view, locator + 8);
  if (recordOffset < 0 || recordOffset + 56 > archive.byteLength) {
    throw new UnsafeThreeMfArchiveError('ZIP64 end-of-central-directory record is out of bounds');
  }
  if (view.getUint32(recordOffset, true) !== 0x06064b50) {
    throw new UnsafeThreeMfArchiveError('ZIP64 end-of-central-directory record is corrupt');
  }
  return {
    entriesOnDisk: readUint64(view, recordOffset + 24),
    entryCount: readUint64(view, recordOffset + 32),
    centralSize: readUint64(view, recordOffset + 40),
    centralOffset: readUint64(view, recordOffset + 48),
    recordOffset,
  };
}

/**
 * A 64-bit little-endian field, refused rather than truncated when it exceeds
 * what a browser can index safely.
 */
function readUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsafeThreeMfArchiveError('ZIP64 field exceeds the supported browser envelope');
  }
  return Number(value);
}

/**
 * The 0x0001 ZIP64 extended-information field of one central-directory entry.
 *
 * Its layout is positional: uncompressed size, compressed size, local header
 * offset, disk number — each present only when the 32-bit field it replaces
 * held a sentinel. Reading it as a fixed layout would take the wrong eight
 * bytes for any entry that does not use all of them, which is why the caller
 * says which ones it is missing.
 */
function readZip64ExtraField(
  view: DataView,
  extraStart: number,
  extraLength: number,
  wantUncompressed: boolean,
  wantCompressed: boolean,
  wantOffset: boolean,
): { uncompressedSize?: number; compressedSize?: number; localOffset?: number } {
  let cursor = extraStart;
  const end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const headerId = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (cursor + 4 + size > end) throw new UnsafeThreeMfArchiveError('ZIP extra field overruns its record');
    if (headerId === 0x0001) {
      let field = cursor + 4;
      const limit = field + size;
      const take = (): number => {
        if (field + 8 > limit) throw new UnsafeThreeMfArchiveError('ZIP64 extra field is truncated');
        const value = readUint64(view, field);
        field += 8;
        return value;
      };
      const result: { uncompressedSize?: number; compressedSize?: number; localOffset?: number } = {};
      if (wantUncompressed) result.uncompressedSize = take();
      if (wantCompressed) result.compressedSize = take();
      if (wantOffset) result.localOffset = take();
      return result;
    }
    cursor += 4 + size;
  }
  throw new UnsafeThreeMfArchiveError('ZIP entry claims ZIP64 sizes but carries no ZIP64 extra field');
}

function inspectCentralDirectory(archive: Uint8Array, limits: ZipSafetyLimits): CentralEntry[] {
  if (archive.byteLength < 22) throw new UnsafeThreeMfArchiveError('ZIP is truncated');
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const minimum = Math.max(0, archive.byteLength - 65_557);
  let eocd = -1;
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === archive.byteLength) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new UnsafeThreeMfArchiveError('ZIP end-of-central-directory is missing');
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new UnsafeThreeMfArchiveError('Multi-disk ZIP archives are not supported');
  }
  let entriesOnDisk = view.getUint16(eocd + 8, true);
  let entryCount = view.getUint16(eocd + 10, true);
  let centralSize = view.getUint32(eocd + 12, true);
  let centralOffset = view.getUint32(eocd + 16, true);
  let directoryEnd = eocd;
  if (
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    centralSize === 0xffff_ffff ||
    centralOffset === 0xffff_ffff
  ) {
    // A sentinel means the real value lives in the ZIP64 record, not that the
    // archive is large. Upstream's calibration 3MFs are 150 KB and still write
    // one — refusing them outright kept genuinely small, entirely ordinary
    // files out. The values are read from ZIP64 and then face **every** bound
    // below unchanged: entry count, central-directory bounds, path safety, and
    // the total-size limit. Widening what can be *parsed* is not widening what
    // is accepted.
    const zip64 = readZip64Eocd(archive, view, eocd);
    entriesOnDisk = zip64.entriesOnDisk;
    entryCount = zip64.entryCount;
    centralSize = zip64.centralSize;
    centralOffset = zip64.centralOffset;
    // The ZIP64 record and its locator sit between the central directory and
    // the classic end record, so the directory abuts *them*, not it. Still an
    // equality: the directory must end exactly where the ZIP64 record begins,
    // which leaves no unaccounted bytes for anything to hide in.
    directoryEnd = zip64.recordOffset;
  }
  if (entriesOnDisk !== entryCount) {
    throw new UnsafeThreeMfArchiveError('ZIP central-directory entry count is inconsistent');
  }
  if (entryCount > limits.maxEntries) {
    throw new UnsafeThreeMfArchiveError(`ZIP has ${entryCount} entries; limit is ${limits.maxEntries}`);
  }
  if (centralOffset + centralSize !== directoryEnd || centralOffset > archive.byteLength) {
    throw new UnsafeThreeMfArchiveError('ZIP central-directory bounds are invalid');
  }

  const entries: CentralEntry[] = [];
  const localRegions: Array<{ start: number; end: number; path: string }> = [];
  const paths = new Set<string>();
  let total = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new UnsafeThreeMfArchiveError('ZIP central-directory record is corrupt');
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const expectedCrc32 = view.getUint32(offset + 16, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    let localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > directoryEnd) throw new UnsafeThreeMfArchiveError('ZIP central entry is truncated');
    if (flags & 0x1 || flags & 0x40) {
      throw new UnsafeThreeMfArchiveError('Encrypted ZIP entries are not supported');
    }
    // Per-entry ZIP64: the same sentinels appear on individual records, with
    // the real values in the 0x0001 extra field. Read in the order the spec
    // fixes — uncompressed, compressed, local offset — and only for the fields
    // that actually carry a sentinel, since a present field shifts the ones
    // after it.
    if (compressedSize === 0xffff_ffff || uncompressedSize === 0xffff_ffff || localOffset === 0xffff_ffff) {
      const wide = readZip64ExtraField(
        view,
        offset + 46 + nameLength,
        extraLength,
        uncompressedSize === 0xffff_ffff,
        compressedSize === 0xffff_ffff,
        localOffset === 0xffff_ffff,
      );
      if (wide.uncompressedSize !== undefined) uncompressedSize = wide.uncompressedSize;
      if (wide.compressedSize !== undefined) compressedSize = wide.compressedSize;
      if (wide.localOffset !== undefined) localOffset = wide.localOffset;
    }
    if (flags & 0x20 || flags & 0x2000) {
      throw new UnsafeThreeMfArchiveError('Patched or masked ZIP entries are not supported');
    }
    if (compression !== 0 && compression !== 8) {
      throw new UnsafeThreeMfArchiveError(`Unsupported ZIP compression method ${compression}`);
    }
    if (diskStart !== 0 || localOffset + 30 > centralOffset) {
      throw new UnsafeThreeMfArchiveError('ZIP local-file offset is invalid');
    }
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new UnsafeThreeMfArchiveError('ZIP local-file header is missing');
    }
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x800) && nameBytes.some((byte) => byte > 0x7f)) {
      throw new UnsafeThreeMfArchiveError('Non-UTF-8 ZIP filenames are not supported');
    }
    let path: string;
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      throw new UnsafeThreeMfArchiveError('ZIP filename is not valid UTF-8');
    }
    const directory = path.endsWith('/');
    validatePackagePath(directory ? path.slice(0, -1) : path, limits.maxPathBytes);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompression = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    let localCompressedSize = view.getUint32(localOffset + 18, true);
    let localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localDataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localDataOffset + compressedSize > centralOffset) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${path} has invalid local data bounds`);
    }
    const localEnd = localDataOffset + compressedSize;
    const overlap = localRegions.find((region) => localOffset < region.end && region.start < localEnd);
    if (overlap) {
      throw new UnsafeThreeMfArchiveError(`ZIP entries ${overlap.path} and ${path} have overlapping local data`);
    }
    // The local header carries the same sentinels as the central record, in
    // its own ZIP64 extra field. Comparing a sentinel against a real size is
    // what made every upstream archive look inconsistent; both sides have to be
    // widened before they can be compared at all.
    if (localCompressedSize === 0xffff_ffff || localUncompressedSize === 0xffff_ffff) {
      const wide = readZip64ExtraField(
        view,
        localOffset + 30 + localNameLength,
        localExtraLength,
        localUncompressedSize === 0xffff_ffff,
        localCompressedSize === 0xffff_ffff,
        false,
      );
      if (wide.uncompressedSize !== undefined) localUncompressedSize = wide.uncompressedSize;
      if (wide.compressedSize !== undefined) localCompressedSize = wide.compressedSize;
    }
    localRegions.push({ start: localOffset, end: localEnd, path });
    if (localFlags !== flags || localCompression !== compression) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${path} has inconsistent local flags or compression`);
    }
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!equalBytes(localName, nameBytes)) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${path} has inconsistent local and central names`);
    }
    if (
      !(flags & 0x8) &&
      (localCrc32 !== expectedCrc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize)
    ) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${path} has inconsistent local size or CRC metadata`);
    }
    if (paths.has(path)) throw new UnsafeThreeMfArchiveError(`Duplicate ZIP path ${path}`);
    paths.add(path);
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${path} exceeds the per-entry size limit`);
    }
    total += uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new UnsafeThreeMfArchiveError('ZIP exceeds the total uncompressed-size limit');
    }
    if (uncompressedSize > 1024 * 1024 && uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
      throw new UnsafeThreeMfArchiveError(`ZIP entry ${path} has a suspicious compression ratio`);
    }
    entries.push({ path, compressedSize, uncompressedSize, crc32: expectedCrc32, directory });
    offset = end;
  }
  if (offset !== directoryEnd) throw new UnsafeThreeMfArchiveError('ZIP central directory has trailing data');
  return entries;
}

function utf8Length(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        index += 1;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function resolveLimits(overrides: Partial<ZipSafetyLimits>): ZipSafetyLimits {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new UnsafeThreeMfArchiveError(`ZIP safety limit ${name} must be a finite positive number`);
    }
    if (name !== 'maxCompressionRatio' && !Number.isInteger(value)) {
      throw new UnsafeThreeMfArchiveError(`ZIP safety limit ${name} must be an integer`);
    }
  }
  if (limits.maxCompressionRatio < 1) {
    throw new UnsafeThreeMfArchiveError('ZIP maxCompressionRatio must be at least 1');
  }
  return limits;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff];
  }
  return (value ^ 0xffff_ffff) >>> 0;
}
