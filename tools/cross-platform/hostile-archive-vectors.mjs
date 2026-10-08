// Hostile archives against the production browser's Open
// (`Bbs3mfProjectSerializer.deserialize`), for the native and WASM archive
// paths to meet: seeded mutations of whole canonical and foreign 3MF packages
// — bit flips, byte writes, truncations, insertions and removals, biased to
// local headers and the central directory — stored as edits to a base so the
// corpus stays small, and hand-built packages whose members are hostile in
// content: byte edits inside members re-zipped with valid CRCs, deep and
// truncated XML, a megabyte attribute, invalid UTF-8, entity declarations,
// UTF-16 XML, case-colliding, traversing, absolute and NUL-bearing member
// names, a nested package and a compression bomb at the ratio limit. Each records the browser's acceptance
// and, when accepted, its state, assets and warnings. Replayed by Rust, by
// WASM in Node and Chrome, and over JNI, where every refusal is also shown to
// leave an edited live session untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { zipSync } from "../../web/node_modules/fflate/esm/index.mjs";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { ORCAXR_EXTENSION_PATH } from "../../web/src/project/serialization/CanonicalEnvelope.ts";
import { readSafeZip } from "../../web/src/project/serialization/deterministicZip.ts";
import { applyArchiveEdits } from "./archive-wasm-replay.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text) => new TextEncoder().encode(text);
const encoded = (text) => (/[\ud800-\udfff]/.test(text) ? Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)) : text);
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/** The browser's Open, as the foreign-import corpus records it. */
async function expectation(bytes) {
  try {
    const opened = await new Bbs3mfProjectSerializer().deserialize(bytes);
    const stateJson = canonicalStringify(opened.state);
    return {
      accepted: true,
      format: readSafeZip(bytes).has(ORCAXR_EXTENSION_PATH) ? "canonical" : "foreign",
      stateSha256: sha256(utf8(stateJson)),
      assets: opened.assets
        .map((asset) => ({
          id: asset.descriptor.id,
          descriptorSha256: sha256(utf8(canonicalStringify(asset.descriptor))),
          bytesSha256: sha256(asset.bytes),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      warnings: opened.warnings.map(encoded),
    };
  } catch {
    return { accepted: false };
  }
}

// --- Bases ---------------------------------------------------------------------------
const canonicalCorpus = JSON.parse(read("testdata/cross-platform/canonical-complete-vectors.json"));
const foreignCorpus = JSON.parse(read("testdata/cross-platform/foreign-import-vectors.json"));
const accepted = canonicalCorpus.cases.filter((c) => c.expected !== null);
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => Number.parseInt(h, 16));
const bases = [
  ...[0, 60, 150].map((i) => ({ name: `canonical/${accepted[i].name}`, bytes: fromHex(accepted[i].archiveHex) })),
  ...["bbs-model/0/basic", "bbs-model/4/color-4", "package-input/0/opaque-Metadata/custom.unknown"]
    .map((name) => foreignCorpus.cases.find((c) => c.name === name))
    .map((c) => ({ name: `foreign/${c.name}`, bytes: Uint8Array.from(Buffer.from(c.archiveBase64, "base64")) })),
];
for (const base of bases) assert.ok((await expectation(base.bytes)).accepted, `${base.name} opens unmutated`);

// --- Seeded mutations ------------------------------------------------------------------
// Counts per base; widen locally (ORCAXR_HOSTILE_MUTATIONS / _CONTENT) to
// search further. The committed corpus uses the defaults.
const MUTATIONS = Number(process.env.ORCAXR_HOSTILE_MUTATIONS ?? 60);
const CONTENT = Number(process.env.ORCAXR_HOSTILE_CONTENT ?? 15);
let state = 0x6a09e667f3bcc909n;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return Number(((state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 32n);
};
const localHeaders = (bytes) => {
  const found = [];
  for (let i = 0; i + 4 <= bytes.length; i += 1)
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) found.push(i);
  return found;
};
/** An offset biased to where structure lives: local headers and the tail. */
const offset = (bytes) => {
  const roll = next() % 4;
  const headers = roll === 0 ? localHeaders(bytes) : [];
  if (headers.length > 0) return Math.min(bytes.length - 1, headers[next() % headers.length] + (next() % 64));
  if (roll === 1) return Math.max(0, bytes.length - 1 - (next() % Math.min(512, bytes.length)));
  return next() % bytes.length;
};
const edit = (bytes) => {
  const kind = next() % 6;
  const at = offset(bytes);
  switch (kind) {
    case 0:
    case 1:
      return { flip: [at, next() % 8] };
    case 2:
      return { set: [at, next() & 0xff] };
    case 3:
      return { truncate: next() % bytes.length };
    case 4:
      return { insert: [at, Array.from({ length: 1 + (next() % 16) }, () => next() & 0xff)] };
    default:
      return { remove: [at, 1 + (next() % 16)] };
  }
};
const cases = [];
for (const [index, base] of bases.entries()) {
  for (let i = 0; i < MUTATIONS; i += 1) {
    const edits = [];
    let bytes = base.bytes;
    for (let n = 1 + (next() % 3); n > 0 && bytes.length > 0; n -= 1) {
      edits.push(edit(bytes));
      bytes = applyArchiveEdits(base.bytes, edits);
    }
    cases.push({ name: `${base.name}/mutation-${i}`, base: index, edits, expected: await expectation(bytes) });
  }
}

// --- Content mutations ---------------------------------------------------------------
// Byte edits inside one member, re-zipped with valid CRCs, so they reach the
// XML, JSON and settings parsers instead of stopping at the container.
const zipOf = (files) =>
  zipSync(Object.fromEntries([...files].map(([path, bytes]) => [path, [bytes, { level: 6, mtime: new Date(1980, 0, 1) }]])));
for (const base of bases) {
  const files = readSafeZip(base.bytes);
  const members = [...files.keys()].filter((path) => /\.(model|config|json|rels|xml)$/i.test(path));
  for (let i = 0; i < CONTENT; i += 1) {
    const member = members[next() % members.length];
    const original = files.get(member);
    const edits = Array.from({ length: 1 + (next() % 3) }, () => {
      const at = next() % Math.max(1, original.length);
      return next() % 3 === 0 ? { remove: [at, 1 + (next() % 8)] } : next() % 2 ? { set: [at, next() & 0xff] } : { flip: [at, next() % 8] };
    });
    const bytes = zipOf(new Map([...files, [member, applyArchiveEdits(original, edits)]]));
    cases.push({ name: `${base.name}/content-${i}`, archiveBase64: base64(bytes), expected: await expectation(bytes) });
  }
}

// --- Hostile content -----------------------------------------------------------------
const foreignFiles = readSafeZip(bases[3].bytes);
const modelPath = [...foreignFiles.keys()].find((path) => path.endsWith(".model"));
const modelText = new TextDecoder().decode(foreignFiles.get(modelPath));
const zip = (files) => zipSync(Object.fromEntries([...files].map(([path, bytes]) => [path, [bytes, { level: 6, mtime: new Date(1980, 0, 1) }]])));
const replaced = (path, bytes) => zip(new Map([...foreignFiles, [path, bytes]]));
const added = (path, bytes) => zip(new Map([...foreignFiles, [path, bytes]]));
const rootTag = modelText.indexOf("<model");
const hostile = {
  "deep-xml": replaced(modelPath, utf8(modelText.slice(0, rootTag) + "<model>" + "<a>".repeat(20000) + "</a>".repeat(20000) + "</model>")),
  "truncated-xml": replaced(modelPath, utf8(modelText.slice(0, Math.floor(modelText.length * 0.6)))),
  "megabyte-attribute": replaced(modelPath, utf8(modelText.replace("<model", `<model huge="${"x".repeat(1 << 20)}"`))),
  "invalid-utf8": replaced(modelPath, Uint8Array.from([...utf8(modelText.slice(0, rootTag + 6)), 0xff, 0xfe, 0xc0, 0xaf, ...utf8(modelText.slice(rootTag + 6))])),
  "entity-declarations": replaced(
    modelPath,
    utf8(`<?xml version="1.0"?><!DOCTYPE model [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>` + modelText.slice(rootTag).replace("<model", "<model note=\"&b;\"")),
  ),
  "utf16-xml": replaced(modelPath, Uint8Array.from([0xff, 0xfe, ...Array.from(modelText).flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])])),
  "case-colliding-model": added(modelPath.replace(/model$/, "MODEL").replace("3D/", "3d/"), foreignFiles.get(modelPath)),
  "traversing-member": added("../outside.txt", utf8("escape")),
  "absolute-member": added("/absolute.txt", utf8("absolute")),
  "backslash-member": added("Metadata\\windows.txt", utf8("backslash")),
  "nul-member": added("Metadata/nul\u0000.txt", utf8("nul")),
  "empty-segment-member": added("Metadata//empty.txt", utf8("empty")),
  "nested-package": added("Metadata/nested.3mf", bases[3].bytes),
  "ratio-bomb": added("Metadata/bomb.bin", new Uint8Array(2 * 1024 * 1024)),
  "large-padding": added("Metadata/padding.txt", utf8(" ".repeat(1024 * 1024 - 1))),
};
// Found by a widened search: a control character in a metadata value the
// next Save regenerates. The browser refuses the Open where it rebuilds the
// member; native once accepted it (it planned the member without writing).
const settingsPath = "Metadata/model_settings.config";
const settingsText = new TextDecoder().decode(foreignFiles.get(settingsPath));
const valueAt = settingsText.indexOf('value="') + 'value="'.length;
hostile["control-character-setting"] = replaced(settingsPath, utf8(settingsText.slice(0, valueAt) + "\u001c" + settingsText.slice(valueAt)));
const rangeFiles = readSafeZip(bases[5].bytes);
const rangesPath = "Metadata/layer_config_ranges.xml";
if (rangeFiles.has(rangesPath)) {
  const ranges = new TextDecoder().decode(rangeFiles.get(rangesPath));
  hostile["control-character-layer-range-key"] = zip(
    new Map([...rangeFiles, [rangesPath, utf8(ranges.replace('opt_key="layer_height"', 'opt_key="lay\u001cr_height"'))]]),
  );
}
for (const [name, bytes] of Object.entries(hostile)) {
  cases.push({ name: `hostile/${name}`, archiveBase64: base64(bytes), expected: await expectation(bytes) });
}

const sources = [
  "tools/cross-platform/hostile-archive-vectors.mjs",
  "tools/cross-platform/archive-wasm-replay.mjs",
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/deterministicZip.ts",
  "testdata/cross-platform/canonical-complete-vectors.json",
  "testdata/cross-platform/foreign-import-vectors.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
      bases: bases.map((b) => ({ name: b.name, archiveBase64: base64(b.bytes) })),
      cases,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/hostile-archive-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Hostile archive reference drift");
const tally = (filter) => cases.filter(filter).length;
console.log(
  `hostile archives: ${cases.length} cases (${tally((c) => c.expected.accepted)} accepted, ${tally((c) => !c.expected.accepted)} refused; ${tally((c) => c.edits)} mutations of ${bases.length} bases, ${tally((c) => c.archiveBase64)} hostile packages)`,
);
