// Printer storage references from the production browser
// (`PrinterStorageExchange.ts` over `PrinterStorage.ts`): what every
// operation sends for paths an operator or a printer could produce (folders,
// nesting, slashes, blanks, traversal, encoded and lone-surrogate names) or
// why it is refused, how each transport outcome finishes, how listing and
// metadata replies of every shape read (missing, blank, mistyped, duplicate
// and huge fields; ties in time and name; thumbnails), and how sizes read.
// Each read records the paths the browser joins for its entries or
// thumbnails, which the wire leaves to the reader. Replayed by Rust, WASM
// (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerStorageFinish,
  answerStoragePlan,
  answerStorageRead,
  answerStorageSize,
} from "../../web/src/printer/PrinterStorageExchange.ts";
import {
  MAX_STORAGE_PATH_UNITS,
  PrinterStorageError,
  listPrinterDirectory,
  readPrinterFileMetadata,
} from "../../web/src/printer/PrinterStorage.ts";
import {
  encodeProjectOptionalText,
  encodeProjectPrinterStorageFinish,
  encodeProjectPrinterStorageOperation,
  encodeProjectPrinterStoragePlan,
  encodeProjectPrinterStorageResult,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const text = (value) => ({ text: units(value) });

// Seeded, so the corpus is the same every run.
let seed = 0x5eed;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

// The longest path a printer holds, and one unit past it.
const longest = `${"a/".repeat(MAX_STORAGE_PATH_UNITS / 2 - 1)}ab`;
const paths = [
  "",
  "part.gcode",
  "projects/part.gcode",
  "/projects/part.gcode/",
  "  spaced/name with spaces.gcode  ",
  "deep/a/b/c/d.gcode",
  "projects",
  "///",
  "   ",
  "../escape.gcode",
  "projects/../part.gcode",
  "./part.gcode",
  "a/./b.gcode",
  "a/../../b.gcode",
  "x\uD800y.gcode",
  "x\uDC00.gcode",
  "emoji 😀.gcode",
  "ümlaut/Ä.gcode",
  "query?&#.gcode",
  "percent%20.gcode",
  "plus+tab\t.gcode",
  " nbsp .gcode﻿",
  "back\\slash.gcode",
  "dots.../..hidden.gcode",
];
// Planned for every operation, finished and read once: each repeats them.
const boundaryPaths = [longest, `${longest}c`, `/${longest}/`];
const names = [
  "renamed.gcode",
  "  trimmed.gcode  ",
  "",
  "   ",
  "a/b.gcode",
  "a\\b.gcode",
  ".",
  "..",
  "...",
  "part.gcode",
  "x\uD800.gcode",
];

const operations = [];
for (const path of [...paths, ...boundaryPaths]) {
  operations.push({ list: text(path) });
  operations.push({ metadata: text(path) });
  operations.push({ download: text(path) });
  operations.push({ delete: text(path) });
  operations.push({ start: text(path) });
  operations.push({ rename: { path: units(path), name: units(pick(names)) } });
}
const boundaryOperations = operations.splice(-6 * boundaryPaths.length);
for (const name of names)
  operations.push({
    rename: { path: units("projects/part.gcode"), name: units(name) },
  });
for (let i = 0; i < 40; i++)
  operations.push({
    move: { source: units(pick(paths)), destination: units(pick(paths)) },
  });
operations.push({
  move: { source: units("a.gcode"), destination: units("/a.gcode/") },
});
operations.push({
  rename: { path: units("folder/a.gcode"), name: units("a.gcode") },
});
// A rename whose new name carries the path past the bound.
boundaryOperations.push(
  { rename: { path: units(longest), name: units("b") } },
  { rename: { path: units(longest.slice(0, -1)), name: units("b") } },
  { move: { source: units(longest), destination: units("part.gcode") } },
);

const planCases = [];
for (const operation of [...operations, ...boundaryOperations]) {
  const plan = await answerStoragePlan(operation);
  planCases.push({
    requestJson: encodeProjectPrinterStorageOperation(operation),
    replyJson: encodeProjectPrinterStoragePlan(plan),
  });
}

const codes = [
  "invalidEndpoint",
  "invalidCredentials",
  "invalidState",
  "invalidRequest",
  "cancelled",
  "timeout",
  "network",
  "authRequired",
  "forbidden",
  "httpError",
  "invalidResponse",
  "protocolError",
  "versionUnsupported",
  "websocketUnavailable",
  "websocketFailed",
  "heartbeatTimeout",
  "reconnectExhausted",
];
const outcomes = [
  { done: {} },
  { cancelled: {} },
  { failed: { code: absent, httpStatus: absent, detail: absent } },
  ...codes.map((code) => ({
    failed: {
      code: { value: code },
      httpStatus: code === "httpError" ? { value: 404 } : absent,
      detail: code === "httpError" ? { value: units("not found") } : absent,
    },
  })),
];
const finishCases = [];
for (const operation of [
  ...operations,
  { delete: text(longest) },
  { list: text(longest) },
]) {
  // A listing or metadata exchange that answers is read, not finished.
  const reads = "list" in operation || "metadata" in operation;
  for (const outcome of reads ? outcomes.slice(1) : outcomes) {
    if (random() > 0.35 && !("done" in outcome)) continue;
    const request = { operation, outcome };
    finishCases.push({
      requestJson: encodeProjectPrinterStorageFinish(request),
      replyJson: encodeProjectPrinterStorageResult(
        await answerStorageFinish(request),
      ),
    });
  }
}

// Listing replies: every field present, missing, blank, mistyped or huge.
const stamps = [
  undefined,
  1_700_000_000,
  1_700_000_000.4995,
  1_700_000_000.0005,
  0,
  -1,
  1e306,
  "1700000000",
  null,
  1_800_000_000,
  1_700_000_000,
];
const sizes = [
  undefined,
  0,
  1024,
  1.5,
  -5,
  "2048",
  null,
  Number.MAX_SAFE_INTEGER,
];
const entryNames = [
  "alpha.gcode",
  "Beta.gcode",
  "beta.gcode",
  "  padded.gcode ",
  "",
  "   ",
  ".",
  "..",
  "ümlaut.gcode",
  "emoji 😀.gcode",
  "x\uD800.gcode",
  "zeta",
];
function directoryEntry() {
  const entry = {};
  const key = pick(["dirname", "name", "both", "neither", "number"]);
  if (key === "dirname" || key === "both") entry.dirname = pick(entryNames);
  if (key === "name" || key === "both") entry.name = pick(entryNames);
  if (key === "number") entry.dirname = 7;
  const modified = pick(stamps);
  if (modified !== undefined) entry.modified = modified;
  const size = pick(sizes);
  if (size !== undefined) entry.size = size;
  return random() < 0.08 ? pick([null, "dir", 3, []]) : entry;
}
function fileEntry() {
  const entry = {};
  const key = pick(["filename", "path", "both", "neither", "number"]);
  if (key === "filename" || key === "both") entry.filename = pick(entryNames);
  if (key === "path" || key === "both") entry.path = pick(entryNames);
  if (key === "number") entry.filename = 3;
  const modified = pick(stamps);
  if (modified !== undefined) entry.modified = modified;
  const size = pick(sizes);
  if (size !== undefined) entry.size = size;
  return random() < 0.08 ? pick([null, "file", 3, []]) : entry;
}
const listingReplies = [
  JSON.stringify(null),
  JSON.stringify([]),
  JSON.stringify("listing"),
  JSON.stringify({}),
  JSON.stringify({ dirs: "nope", files: { not: "array" } }),
  JSON.stringify({
    dirs: [
      { dirname: "archive", modified: 1_700_000_000, size: 4096 },
      { dirname: "alpha" },
      { dirname: ".." },
    ],
    files: [
      { filename: "older.gcode", modified: 1_700_000_000, size: 1024 },
      { filename: "newest.gcode", modified: 1_800_000_000, size: 2048 },
    ],
    disk_usage: { free: 5_000_000, total: 8_000_000, used: 3_000_000 },
  }),
  JSON.stringify({
    files: [
      { filename: "far.gcode", modified: 1e306 },
      { filename: "near.gcode", modified: 1 },
    ],
  }),
  JSON.stringify({ disk_usage: { free: "lots", total: Infinity } }),
  JSON.stringify({ disk_usage: [] }),
  '{"files":[{"filename":"dup.gcode","modified":1,"filename":"last.gcode"}]}',
];
for (let i = 0; i < 60; i++) {
  const reply = {};
  if (random() < 0.9)
    reply.dirs = Array.from(
      { length: Math.floor(random() * 6) },
      directoryEntry,
    );
  if (random() < 0.9)
    reply.files = Array.from({ length: Math.floor(random() * 9) }, fileEntry);
  if (random() < 0.5)
    reply.disk_usage = { free: pick(sizes), total: pick(sizes) };
  listingReplies.push(JSON.stringify(reply));
}
// Thousands of files: the bulk tier carries them.
listingReplies.push(
  JSON.stringify({
    files: Array.from({ length: 3000 }, (_, i) => ({
      filename: `print_${String(i).padStart(4, "0")}_${"x".repeat(60)}.gcode`,
      modified: 1_700_000_000 + (i % 97),
      size: i * 1000,
    })),
  }),
);
const metadataReplies = [
  JSON.stringify(null),
  JSON.stringify([]),
  JSON.stringify({}),
  JSON.stringify({
    size: 1234,
    modified: 1_700_000_000.25,
    slicer: " OrcaSlicer ",
    slicer_version: "2.3.0",
    layer_height: 0.2,
    object_height: 42,
    filament_total: 1234.5,
    filament_weight_total: 3.7,
    estimated_time: 3600,
    first_layer_bed_temp: 60,
    first_layer_extr_temp: 215,
    thumbnails: [
      { width: 32, height: 32, size: 1000, relative_path: ".thumbs/small.png" },
      {
        width: 300,
        height: 300,
        size: 9000,
        relative_path: "./.thumbs/large.png",
      },
      { width: 300, height: 300, relative_path: "/abs.png" },
      { width: "300", height: 300, relative_path: "bad.png" },
      { width: 100, height: 100, relative_path: "  " },
      { width: 100, height: 100 },
      null,
      "thumb",
    ],
  }),
  JSON.stringify({
    slicer: "",
    slicer_version: 2,
    estimated_time: "60",
    modified: 1e306,
    size: -1,
  }),
];
for (let i = 0; i < 30; i++) {
  const reply = {};
  for (const key of [
    "size",
    "modified",
    "layer_height",
    "object_height",
    "estimated_time",
    "filament_total",
  ])
    if (random() < 0.6) reply[key] = pick([...sizes, ...stamps]);
  if (random() < 0.5) reply.slicer = pick(entryNames);
  if (random() < 0.7)
    reply.thumbnails = Array.from({ length: Math.floor(random() * 5) }, () => ({
      width: pick([16, 32, 300, 0, -1, "32", undefined]),
      height: pick([16, 32, 300, 0, -1, undefined]),
      relative_path: pick([
        ".thumbs/a.png",
        "./b.png",
        "/c.png",
        "",
        undefined,
        "d.png",
      ]),
      ...(random() < 0.5 ? { size: pick(sizes) } : {}),
    }));
  metadataReplies.push(JSON.stringify(reply));
}
const readCases = [];
for (const path of paths) {
  for (const reply of pick([listingReplies.slice(0, 12), listingReplies])
    .slice(0, 4)
    .concat(pick(listingReplies)))
    readCases.push({ operation: { list: text(path) }, reply });
  for (const reply of metadataReplies.slice(0, 3).concat(pick(metadataReplies)))
    readCases.push({ operation: { metadata: text(path) }, reply });
}
for (const reply of listingReplies)
  readCases.push({ operation: { list: text("projects") }, reply });
for (const reply of metadataReplies)
  readCases.push({
    operation: { metadata: text("projects/part.gcode") },
    reply,
  });
readCases.push({
  operation: { list: text(longest) },
  reply: listingReplies[5],
});
readCases.push({
  operation: { metadata: text(longest) },
  reply: metadataReplies[3],
});
// A reply to an operation that has none to read finishes as done.
readCases.push({ operation: { delete: text("part.gcode") }, reply: "{}" });
readCases.push({ operation: { start: text("part.gcode") }, reply: '"ok"' });
// The paths the browser joins for a read's entries or thumbnails, as UTF-16
// units (`,`) per path (`;`); a read of more than 256 records none.
async function browserPaths(operation, reply) {
  const transport = {
    request: async () => JSON.parse(reply),
    download: async () => new Uint8Array(0),
  };
  const path = (value) => String.fromCharCode(...value.text);
  try {
    if ("list" in operation) {
      const listing = await listPrinterDirectory(
        transport,
        path(operation.list),
      );
      return [...listing.directories, ...listing.files].map(
        (entry) => entry.path,
      );
    }
    if ("metadata" in operation) {
      const metadata = await readPrinterFileMetadata(
        transport,
        path(operation.metadata),
      );
      return metadata.thumbnails.map((thumbnail) => thumbnail.path);
    }
  } catch (error) {
    if (!(error instanceof PrinterStorageError)) throw error;
  }
  return [];
}
const readRecords = [];
for (const { operation, reply } of readCases) {
  readRecords.push({
    operationJson: encodeProjectPrinterStorageOperation(operation),
    reply,
    replyJson: encodeProjectPrinterStorageResult(
      await answerStorageRead(operation, reply),
    ),
    paths: await browserPaths(operation, reply).then((paths) =>
      paths.length > 256
        ? null
        : paths.map((path) => units(path).join(",")).join(";"),
    ),
  });
}

const sizeValues = [
  0,
  1,
  1023,
  1024,
  1280,
  1536,
  1024 * 99.95,
  1024 * 100,
  5 * 1024 * 1024,
  150 * 1024 * 1024,
  1024 ** 4 * 3.25,
  1024 ** 5 * 7,
  0.5,
  -1,
  Number.NaN,
  Infinity,
  -Infinity,
  1e300,
  1048575,
  1048576,
  1024 * 1024 * 99.95,
  1024 * 1.05,
  1024 * 1.25,
  1024 * 1.35,
];
for (let i = 0; i < 40; i++)
  sizeValues.push(
    Math.floor(random() * 1024 ** (1 + Math.floor(random() * 4))),
  );
const sizeCases = sizeValues.map((bytes) => ({
  bytes,
  replyJson: encodeProjectOptionalText(answerStorageSize(bytes)),
}));

const sources = [
  "tools/cross-platform/printer-storage-vectors.mjs",
  "web/src/printer/PrinterStorageExchange.ts",
  "web/src/printer/PrinterStorage.ts",
  "web/src/printer/PrinterWire.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const corpus = {
  plans: planCases,
  finishes: finishCases,
  reads: readRecords,
  sizes: sizeCases,
};
// Sizes include non-finite numbers, which JSON cannot spell: they travel as text.
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      ...corpus,
    },
    (key, value) =>
      key === "bytes" && typeof value === "number" && !Number.isFinite(value)
        ? String(value)
        : value,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-storage-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer storage reference drift",
  );
console.log(
  `Printer storage references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
