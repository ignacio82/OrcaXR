import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[n] = value >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function asBuffer(input) {
  if (typeof input === "string") return readFileSync(input);
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array)
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("ZIP input must be a path, Buffer, or Uint8Array");
}

function findEndOfCentralDirectory(bytes) {
  const lowerBound = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error(
    "Not a ZIP archive: end-of-central-directory record is missing",
  );
}

function normalizeMemberPath(rawName) {
  const name = rawName.replaceAll("\\", "/");
  if (
    !name ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`Unsafe ZIP member path: ${JSON.stringify(rawName)}`);
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(
      `ZIP member escapes the archive root: ${JSON.stringify(rawName)}`,
    );
  }
  const normalized = parts.filter((part) => part && part !== ".").join("/");
  if (!normalized)
    throw new Error(`Empty ZIP member path: ${JSON.stringify(rawName)}`);
  return normalized;
}

/**
 * Read a classic (non-ZIP64) archive with bounded decompression and CRC validation.
 * Only STORE and DEFLATE are accepted: both cover normal 3MF producers.
 */
export function readZip(input, options = {}) {
  const bytes = asBuffer(input);
  const limits = {
    maxEntries: options.maxEntries ?? 4096,
    maxEntryBytes: options.maxEntryBytes ?? 64 * 1024 * 1024,
    maxTotalBytes: options.maxTotalBytes ?? 256 * 1024 * 1024,
    maxCompressionRatio: options.maxCompressionRatio ?? 250,
  };
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const directoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const directorySize = bytes.readUInt32LE(eocdOffset + 12);
  const directoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (
    totalEntries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error(
      "ZIP64 archives are not supported by the compact parity reader",
    );
  }
  if (totalEntries > limits.maxEntries) {
    throw new Error(
      `ZIP has ${totalEntries} members; limit is ${limits.maxEntries}`,
    );
  }
  if (directoryOffset + directorySize > eocdOffset) {
    throw new Error("ZIP central directory points outside the archive");
  }

  const entries = new Map();
  let offset = directoryOffset;
  let totalInflated = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > bytes.length ||
      bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw new Error(`Invalid ZIP central-directory record ${index}`);
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > bytes.length)
      throw new Error(`Truncated ZIP directory record ${index}`);
    const rawName = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const name = normalizeMemberPath(rawName);
    offset = recordEnd;

    if (rawName.endsWith("/")) continue;
    if (entries.has(name))
      throw new Error(`Duplicate ZIP member after normalization: ${name}`);
    if (flags & 0x41)
      throw new Error(`Encrypted ZIP member is not supported: ${name}`);
    if (method !== 0 && method !== 8) {
      throw new Error(
        `Unsupported ZIP compression method ${method} for ${name}`,
      );
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new Error(
        `ZIP member ${name} exceeds the ${limits.maxEntryBytes}-byte limit`,
      );
    }
    totalInflated += uncompressedSize;
    if (totalInflated > limits.maxTotalBytes) {
      throw new Error(
        `ZIP expands beyond the ${limits.maxTotalBytes}-byte total limit`,
      );
    }
    if (
      compressedSize === 0
        ? uncompressedSize !== 0
        : uncompressedSize / compressedSize > limits.maxCompressionRatio
    ) {
      throw new Error(
        `ZIP member ${name} exceeds the allowed compression ratio`,
      );
    }
    if (
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
    ) {
      throw new Error(`Missing local ZIP header for ${name}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    if (localNameEnd > bytes.length)
      throw new Error(`Truncated local ZIP name for ${name}`);
    const localName = normalizeMemberPath(
      bytes.subarray(localOffset + 30, localNameEnd).toString("utf8"),
    );
    if (
      localName !== name ||
      localMethod !== method ||
      ((localFlags ^ flags) & ~0x8) !== 0
    ) {
      throw new Error(`Local and central ZIP headers disagree for ${name}`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > bytes.length)
      throw new Error(`Truncated ZIP payload for ${name}`);
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const data =
      method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) {
      throw new Error(
        `ZIP member ${name} declared ${uncompressedSize} bytes but expanded to ${data.length}`,
      );
    }
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC mismatch for ZIP member ${name}`);
    }
    entries.set(name, data);
  }
  if (offset !== directoryOffset + directorySize) {
    throw new Error("ZIP central-directory size does not match its records");
  }
  return entries;
}

function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeUInt16(value) {
  const out = Buffer.allocUnsafe(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function writeUInt32(value) {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

/** Create a deterministic STORE-only ZIP suitable for compact generated fixtures. */
export function createZip(entries, options = {}) {
  const pairs =
    entries instanceof Map || Array.isArray(entries)
      ? [...entries]
      : Object.entries(entries);
  const ordered =
    options.sort === false
      ? pairs
      : pairs.sort(([left], [right]) => left.localeCompare(right, "en"));
  const stamp = dosDateTime(
    options.timestamp ?? new Date("1980-01-01T00:00:00Z"),
  );
  const localRecords = [];
  const directoryRecords = [];
  let localOffset = 0;
  for (const [rawName, rawData] of ordered) {
    const name = normalizeMemberPath(rawName);
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    const checksum = crc32(data);
    const local = Buffer.concat([
      writeUInt32(LOCAL_SIGNATURE),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(stamp.time),
      writeUInt16(stamp.date),
      writeUInt32(checksum),
      writeUInt32(data.length),
      writeUInt32(data.length),
      writeUInt16(nameBytes.length),
      writeUInt16(0),
      nameBytes,
      data,
    ]);
    const directory = Buffer.concat([
      writeUInt32(CENTRAL_SIGNATURE),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(stamp.time),
      writeUInt16(stamp.date),
      writeUInt32(checksum),
      writeUInt32(data.length),
      writeUInt32(data.length),
      writeUInt16(nameBytes.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(localOffset),
      nameBytes,
    ]);
    localRecords.push(local);
    directoryRecords.push(directory);
    localOffset += local.length;
  }
  if (ordered.length > 0xffff)
    throw new Error("Too many entries for classic ZIP");
  const directory = Buffer.concat(directoryRecords);
  const eocd = Buffer.concat([
    writeUInt32(EOCD_SIGNATURE),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(ordered.length),
    writeUInt16(ordered.length),
    writeUInt32(directory.length),
    writeUInt32(localOffset),
    writeUInt16(0),
  ]);
  return Buffer.concat([...localRecords, directory, eocd]);
}
