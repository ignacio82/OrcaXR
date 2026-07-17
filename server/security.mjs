import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { createInflateRaw } from "node:zlib";

const MiB = 1024 * 1024;
const LOOPBACK_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class HttpError extends Error {
  constructor(status, code, publicMessage, options = {}) {
    super(
      options.internalMessage || publicMessage,
      options.cause ? { cause: options.cause } : undefined,
    );
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

function integerFromEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function isLoopbackHost(host) {
  const normalized = String(host)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function parseOrigins(raw) {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry === "*")
        throw new Error("ORCAXR_ALLOWED_ORIGINS may not contain *");
      let parsed;
      try {
        parsed = new URL(entry);
      } catch {
        throw new Error(`Invalid ORCAXR_ALLOWED_ORIGINS entry: ${entry}`);
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error(
          `Allowed origin must be an HTTP(S) origin without path/query credentials: ${entry}`,
        );
      }
      return parsed.origin;
    });
}

export function loadServerConfig(env = process.env) {
  const host = env.HOST?.trim() || "127.0.0.1";
  const token = env.ORCAXR_SERVER_TOKEN || "";
  const configuredOrigins = parseOrigins(env.ORCAXR_ALLOWED_ORIGINS);
  return {
    host,
    port: integerFromEnv(env, "PORT", 3000, 0, 65535),
    token,
    authRequired: Boolean(token) || !isLoopbackHost(host),
    explicitOrigins: configuredOrigins,
    allowLoopbackOrigins: isLoopbackHost(host),
    maxUploadBytes: integerFromEnv(
      env,
      "ORCAXR_MAX_UPLOAD_BYTES",
      256 * MiB,
      1024,
      2 * 1024 * MiB,
    ),
    maxOverridesBytes: integerFromEnv(
      env,
      "ORCAXR_MAX_OVERRIDES_BYTES",
      512 * 1024,
      2,
      16 * MiB,
    ),
    maxArchiveEntries: integerFromEnv(
      env,
      "ORCAXR_MAX_ARCHIVE_ENTRIES",
      4096,
      2,
      100000,
    ),
    maxArchiveCentralBytes: integerFromEnv(
      env,
      "ORCAXR_MAX_ARCHIVE_CENTRAL_BYTES",
      16 * MiB,
      1024,
      128 * MiB,
    ),
    maxArchiveEntryBytes: integerFromEnv(
      env,
      "ORCAXR_MAX_ARCHIVE_ENTRY_BYTES",
      512 * MiB,
      1024,
      4 * 1024 * MiB,
    ),
    maxArchiveUncompressedBytes: integerFromEnv(
      env,
      "ORCAXR_MAX_ARCHIVE_UNCOMPRESSED_BYTES",
      1024 * MiB,
      1024,
      8 * 1024 * MiB,
    ),
    maxArchiveCompressionRatio: integerFromEnv(
      env,
      "ORCAXR_MAX_ARCHIVE_COMPRESSION_RATIO",
      200,
      2,
      10000,
    ),
    archiveValidationTimeoutMs: integerFromEnv(
      env,
      "ORCAXR_ARCHIVE_VALIDATION_TIMEOUT_MS",
      30_000,
      100,
      10 * 60 * 1000,
    ),
    maxGcodeBytes: integerFromEnv(
      env,
      "ORCAXR_MAX_GCODE_BYTES",
      512 * MiB,
      1024,
      4 * 1024 * MiB,
    ),
    maxConcurrentJobs: integerFromEnv(
      env,
      "ORCAXR_MAX_CONCURRENT_JOBS",
      2,
      1,
      32,
    ),
    maxQueuedJobs: integerFromEnv(env, "ORCAXR_MAX_QUEUED_JOBS", 4, 0, 256),
    maxStoredJobs: integerFromEnv(env, "ORCAXR_MAX_STORED_JOBS", 12, 1, 512),
    sliceTimeoutMs: integerFromEnv(
      env,
      "ORCAXR_SLICE_TIMEOUT_MS",
      45 * 60 * 1000,
      100,
      24 * 60 * 60 * 1000,
    ),
    queueTimeoutMs: integerFromEnv(
      env,
      "ORCAXR_QUEUE_TIMEOUT_MS",
      10 * 60 * 1000,
      100,
      24 * 60 * 60 * 1000,
    ),
    jobTtlMs: integerFromEnv(
      env,
      "ORCAXR_JOB_TTL_MS",
      10 * 60 * 1000,
      1000,
      24 * 60 * 60 * 1000,
    ),
    childKillGraceMs: integerFromEnv(
      env,
      "ORCAXR_CHILD_KILL_GRACE_MS",
      5000,
      10,
      60000,
    ),
    httpRequestTimeoutMs: integerFromEnv(
      env,
      "ORCAXR_HTTP_REQUEST_TIMEOUT_MS",
      2 * 60 * 1000,
      1000,
      60 * 60 * 1000,
    ),
    rateWindowMs: integerFromEnv(
      env,
      "ORCAXR_RATE_WINDOW_MS",
      60 * 1000,
      1000,
      60 * 60 * 1000,
    ),
    maxRequestsPerWindow: integerFromEnv(
      env,
      "ORCAXR_MAX_REQUESTS_PER_WINDOW",
      120,
      1,
      100000,
    ),
    maxSliceRequestsPerWindow: integerFromEnv(
      env,
      "ORCAXR_MAX_SLICE_REQUESTS_PER_WINDOW",
      10,
      1,
      10000,
    ),
    maxRateLimitClients: integerFromEnv(
      env,
      "ORCAXR_MAX_RATE_LIMIT_CLIENTS",
      4096,
      16,
      100000,
    ),
    maxConnections: integerFromEnv(
      env,
      "ORCAXR_MAX_CONNECTIONS",
      128,
      1,
      100000,
    ),
  };
}

export function validateServerConfig(config) {
  if (config.token && /[\s\x00-\x1f\x7f]/u.test(config.token)) {
    throw new Error(
      "ORCAXR_SERVER_TOKEN may not contain whitespace or control characters",
    );
  }
  if (!isLoopbackHost(config.host)) {
    if (!config.token || Buffer.byteLength(config.token) < 32) {
      throw new Error(
        "Non-loopback HOST requires ORCAXR_SERVER_TOKEN with at least 32 bytes",
      );
    }
    if (!config.explicitOrigins?.length) {
      throw new Error(
        "Non-loopback HOST requires an explicit ORCAXR_ALLOWED_ORIGINS list",
      );
    }
  } else if (config.token && Buffer.byteLength(config.token) < 32) {
    throw new Error(
      "ORCAXR_SERVER_TOKEN must contain at least 32 bytes when configured",
    );
  }
  if (config.maxStoredJobs < config.maxConcurrentJobs + config.maxQueuedJobs) {
    throw new Error(
      "ORCAXR_MAX_STORED_JOBS must cover concurrent plus queued jobs",
    );
  }
  return config;
}

export function isOriginAllowed(origin, config) {
  if (!origin) return true; // Non-browser clients do not send Origin.
  if (config.explicitOrigins.includes(origin)) return true;
  return config.allowLoopbackOrigins && LOOPBACK_ORIGIN.test(origin);
}

export function bearerTokenMatches(header, expected) {
  if (
    typeof expected !== "string" ||
    expected.length === 0 ||
    typeof header !== "string" ||
    !/^Bearer [^\s]+$/i.test(header)
  )
    return false;
  const supplied = createHash("sha256")
    .update(header.slice(7), "utf8")
    .digest();
  const wanted = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(supplied, wanted);
}

export function parseOverridesJson(raw, maxBytes) {
  const text = raw === undefined || raw === "" ? "{}" : String(raw);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new HttpError(
      413,
      "OVERRIDES_TOO_LARGE",
      "Overrides JSON exceeds the configured limit.",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new HttpError(
      400,
      "INVALID_OVERRIDES",
      "Overrides must be valid JSON.",
      { cause },
    );
  }
  if (
    !value ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new HttpError(
      400,
      "INVALID_OVERRIDES",
      "Overrides must be a JSON object.",
    );
  }
  let nodes = 0;
  const visit = (node, depth) => {
    if (depth > 16)
      throw new HttpError(
        400,
        "INVALID_OVERRIDES",
        "Overrides JSON is too deeply nested.",
      );
    if (++nodes > 10000)
      throw new HttpError(
        400,
        "INVALID_OVERRIDES",
        "Overrides JSON has too many values.",
      );
    if (
      typeof node === "string" &&
      Buffer.byteLength(node, "utf8") > maxBytes
    ) {
      throw new HttpError(
        400,
        "INVALID_OVERRIDES",
        "An overrides value is too large.",
      );
    }
    if (Array.isArray(node)) {
      if (node.length > 10000)
        throw new HttpError(
          400,
          "INVALID_OVERRIDES",
          "An overrides array is too large.",
        );
      for (const child of node) visit(child, depth + 1);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_JSON_KEYS.has(key)) {
          throw new HttpError(
            400,
            "INVALID_OVERRIDES",
            "Overrides contain a forbidden key.",
          );
        }
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return value;
}

function zipError(status, code, publicMessage, internalMessage) {
  return new HttpError(status, code, publicMessage, { internalMessage });
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length)
    throw zipError(
      400,
      "INVALID_3MF",
      "The 3MF archive is malformed.",
      "Short ZIP read",
    );
  return buffer;
}

function decodeZipName(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw zipError(
      400,
      "INVALID_3MF",
      "The 3MF archive contains an invalid filename.",
      "Invalid UTF-8 ZIP filename",
    );
  }
}

function validateZipName(name) {
  if (
    !name ||
    name.length > 1024 ||
    /[\\\0-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw zipError(
      400,
      "INVALID_3MF",
      "The 3MF archive contains an unsafe filename.",
      `Unsafe ZIP name: ${name}`,
    );
  }
  const parts = name.split("/");
  const effective = name.endsWith("/") ? parts.slice(0, -1) : parts;
  if (
    !effective.length ||
    effective.some((part) => !part || part === "." || part === "..")
  ) {
    throw zipError(
      400,
      "INVALID_3MF",
      "The 3MF archive contains an unsafe filename.",
      `Traversal ZIP name: ${name}`,
    );
  }
}

function containsZip64Extra(extra) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > extra.length) return true;
    if (id === 0x0001) return true;
    cursor += size;
  }
  return cursor !== extra.length;
}

/** Validate 3MF ZIP structure without expanding attacker-controlled data. */
export async function inspect3mf(filePath, limits) {
  const deadline = Date.now() + limits.archiveValidationTimeoutMs;
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 22)
      throw zipError(
        400,
        "INVALID_3MF",
        "The uploaded 3MF is not a valid ZIP archive.",
        "ZIP shorter than EOCD",
      );
    const tailLength = Math.min(stat.size, 22 + 0xffff);
    const tailOffset = stat.size - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== 0x06054b50) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0)
      throw zipError(
        400,
        "INVALID_3MF",
        "The uploaded 3MF is not a valid ZIP archive.",
        "EOCD not found",
      );
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const eocdOffset = tailOffset + eocd;
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      throw zipError(
        400,
        "INVALID_3MF",
        "Multi-disk 3MF archives are not supported.",
        "Multi-disk ZIP",
      );
    }
    if (
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw zipError(
        400,
        "INVALID_3MF",
        "ZIP64 3MF archives are not supported.",
        "ZIP64 sentinel",
      );
    }
    if (entryCount < 2 || entryCount > limits.maxArchiveEntries) {
      throw zipError(
        413,
        "ARCHIVE_LIMIT",
        "The 3MF archive contains too many entries.",
        `ZIP entries: ${entryCount}`,
      );
    }
    if (
      centralSize > limits.maxArchiveCentralBytes ||
      centralOffset + centralSize > eocdOffset
    ) {
      throw zipError(
        413,
        "ARCHIVE_LIMIT",
        "The 3MF archive directory exceeds the configured limit.",
        "Oversized/out-of-range central directory",
      );
    }

    const central = await readExactly(handle, centralSize, centralOffset);
    const names = new Set();
    const foldedNames = new Set();
    const ranges = [];
    let totalUncompressed = 0;
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (Date.now() > deadline) {
        throw zipError(
          408,
          "ARCHIVE_TIMEOUT",
          "3MF validation exceeded the configured time limit.",
          "Central-directory validation timeout",
        );
      }
      if (
        cursor + 46 > central.length ||
        central.readUInt32LE(cursor) !== 0x02014b50
      ) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive directory is malformed.",
          `Bad central entry ${index}`,
        );
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20);
      const uncompressed = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const startDisk = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length || nameLength === 0 || startDisk !== 0) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive directory is malformed.",
          `Bad lengths/disk at entry ${index}`,
        );
      }
      if ((flags & 0x41) !== 0 || ![0, 8].includes(method)) {
        throw zipError(
          400,
          "INVALID_3MF",
          "Encrypted or unsupported 3MF ZIP entries are not allowed.",
          `Flags/method at entry ${index}`,
        );
      }
      const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const extra = central.subarray(
        cursor + 46 + nameLength,
        cursor + 46 + nameLength + extraLength,
      );
      if (
        compressed === 0xffffffff ||
        uncompressed === 0xffffffff ||
        localOffset === 0xffffffff ||
        containsZip64Extra(extra)
      ) {
        throw zipError(
          400,
          "INVALID_3MF",
          "ZIP64 3MF archives are not supported.",
          `ZIP64 entry ${index}`,
        );
      }
      const name = decodeZipName(nameBytes);
      validateZipName(name);
      const foldedName = name.toLowerCase();
      if (names.has(name) || foldedNames.has(foldedName)) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive contains duplicate entries.",
          `Duplicate ZIP name: ${name}`,
        );
      }
      names.add(name);
      foldedNames.add(foldedName);
      const unixMode = (externalAttributes >>> 16) & 0xf000;
      if (unixMode === 0xa000)
        throw zipError(
          400,
          "INVALID_3MF",
          "Symbolic links are not allowed in 3MF archives.",
          `Symlink ZIP entry: ${name}`,
        );
      if (uncompressed > limits.maxArchiveEntryBytes) {
        throw zipError(
          413,
          "ARCHIVE_LIMIT",
          "A 3MF archive entry exceeds the configured limit.",
          `Entry bytes: ${uncompressed}`,
        );
      }
      totalUncompressed += uncompressed;
      if (totalUncompressed > limits.maxArchiveUncompressedBytes) {
        throw zipError(
          413,
          "ARCHIVE_LIMIT",
          "The expanded 3MF archive exceeds the configured limit.",
          `Expanded bytes: ${totalUncompressed}`,
        );
      }
      if (
        uncompressed > MiB &&
        uncompressed / Math.max(1, compressed) >
          limits.maxArchiveCompressionRatio
      ) {
        throw zipError(
          413,
          "ARCHIVE_LIMIT",
          "The 3MF archive compression ratio is unsafe.",
          `Compression ratio for ${name}`,
        );
      }

      if (localOffset + 30 > centralOffset) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive has an invalid local entry.",
          `Local offset for ${name}`,
        );
      }
      const local = await readExactly(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive has an invalid local entry.",
          `Local signature for ${name}`,
        );
      }
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      if (local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive local entry disagrees with its directory.",
          `Local flags/method for ${name}`,
        );
      }
      const localName = decodeZipName(
        await readExactly(handle, localNameLength, localOffset + 30),
      );
      if (localName !== name)
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive entry names disagree.",
          `Local/central name mismatch: ${name}`,
        );
      const localExtra = await readExactly(
        handle,
        localExtraLength,
        localOffset + 30 + localNameLength,
      );
      if (containsZip64Extra(localExtra)) {
        throw zipError(
          400,
          "INVALID_3MF",
          "ZIP64 3MF archives are not supported.",
          `Local ZIP64 entry ${name}`,
        );
      }
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressed;
      if (dataEnd > centralOffset)
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive entry is out of range.",
          `Data range for ${name}`,
        );
      if (method === 0 && compressed !== uncompressed) {
        throw zipError(
          400,
          "INVALID_3MF",
          "A stored 3MF entry has inconsistent sizes.",
          `Stored sizes for ${name}`,
        );
      }
      if (compressed === 0 && uncompressed !== 0) {
        throw zipError(
          400,
          "INVALID_3MF",
          "A 3MF entry has inconsistent sizes.",
          `Empty compressed data for ${name}`,
        );
      }
      ranges.push({
        start: localOffset,
        end: dataEnd,
        dataStart,
        compressed,
        uncompressed,
        method,
        name,
      });
      cursor = end;
    }
    if (cursor !== central.length)
      throw zipError(
        400,
        "INVALID_3MF",
        "The 3MF archive directory has trailing data.",
        "Central directory length mismatch",
      );
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].start < ranges[i - 1].end) {
        throw zipError(
          400,
          "INVALID_3MF",
          "The 3MF archive contains overlapping entries.",
          `Overlap: ${ranges[i - 1].name}/${ranges[i].name}`,
        );
      }
    }
    const lowerNames = new Set([...names].map((name) => name.toLowerCase()));
    if (
      !lowerNames.has("[content_types].xml") ||
      ![...lowerNames].some((name) => /^3d\/.+\.model$/.test(name))
    ) {
      throw zipError(
        400,
        "INVALID_3MF",
        "The archive does not contain a 3MF model.",
        "Required 3MF members missing",
      );
    }

    // Do not trust central-directory uncompressed sizes alone. Stream every
    // deflated member with a hard expected-size ceiling; no file is extracted.
    for (const entry of ranges) {
      if (entry.method === 0 || entry.compressed === 0) continue;
      const input = createReadStream(filePath, {
        start: entry.dataStart,
        end: entry.dataStart + entry.compressed - 1,
      });
      const inflate = createInflateRaw();
      input.pipe(inflate);
      let actual = 0;
      try {
        for await (const chunk of inflate) {
          if (Date.now() > deadline) {
            input.destroy();
            inflate.destroy();
            throw zipError(
              408,
              "ARCHIVE_TIMEOUT",
              "3MF validation exceeded the configured time limit.",
              `Inflate timeout for ${entry.name}`,
            );
          }
          actual += chunk.length;
          if (
            actual > entry.uncompressed ||
            actual > limits.maxArchiveEntryBytes
          ) {
            input.destroy();
            inflate.destroy();
            throw zipError(
              413,
              "ARCHIVE_LIMIT",
              "A 3MF entry expands beyond its declared limit.",
              `Inflated overflow for ${entry.name}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw zipError(
          400,
          "INVALID_3MF",
          "A compressed 3MF entry is corrupt.",
          `Inflate failed for ${entry.name}: ${error.message}`,
        );
      } finally {
        input.destroy();
        inflate.destroy();
      }
      if (actual !== entry.uncompressed) {
        throw zipError(
          400,
          "INVALID_3MF",
          "A 3MF entry has an invalid expanded size.",
          `Inflated size mismatch for ${entry.name}`,
        );
      }
    }
    return { entries: entryCount, totalUncompressedBytes: totalUncompressed };
  } finally {
    await handle.close();
  }
}

/** Validate the two STL encodings accepted by the external slicing contract. */
export async function inspectStl(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size >= 84) {
      const header = await readExactly(handle, 84, 0);
      const facets = header.readUInt32LE(80);
      const expected = 84 + facets * 50;
      if (expected === stat.size) return { format: "binary", facets };
    }
    const head = await readExactly(handle, Math.min(stat.size, 512), 0);
    const tailLength = Math.min(stat.size, 2048);
    const tail = await readExactly(handle, tailLength, stat.size - tailLength);
    const start = head
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trimStart();
    const end = tail.toString("utf8").trimEnd();
    if (
      !/^solid(?:[\t\r\n ]|$)/i.test(start) ||
      !/(?:^|[\r\n])[\t ]*endsolid(?:[\t ]+[^\r\n]*)?[\t\r\n ]*$/i.test(end)
    ) {
      throw new HttpError(
        400,
        "INVALID_STL",
        "The upload is neither a valid binary nor ASCII STL.",
      );
    }
    return { format: "ascii" };
  } finally {
    await handle.close();
  }
}

export class WindowRateLimiter {
  constructor({ max, windowMs, maxClients }) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxClients = maxClients;
    this.clients = new Map();
  }

  consume(key, now = Date.now()) {
    let state = this.clients.get(key);
    if (!state || now >= state.resetAt)
      state = { count: 0, resetAt: now + this.windowMs };
    state.count += 1;
    this.clients.delete(key);
    this.clients.set(key, state);
    while (this.clients.size > this.maxClients)
      this.clients.delete(this.clients.keys().next().value);
    return {
      allowed: state.count <= this.max,
      remaining: Math.max(0, this.max - state.count),
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
    };
  }
}
