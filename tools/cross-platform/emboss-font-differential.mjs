// Real fonts: the shared core's TrueType reader (the project WASM build, in
// Node) against the browser's own (`truetypeOutlines.ts` through
// `embossFontExchange.ts`) on the TrueType fonts installed on this host — or
// the files named on the command line — read live and never copied into the
// repository. For each font: the read reply; the outlines of every code point
// of the Basic Multilingual Plane, 128 to a request (fewer where a reply would
// pass the intent limits), each reply compared byte for byte (every
// coordinate as JSON writes it); and sample texts cut with
// the font, compared by reply and mesh SHA-256. Exits non-zero on the first
// difference. Run after `python3 tools/cross-platform/build-wasm.py --project`:
//
//   node --import ./web/node_modules/tsx/dist/loader.mjs \
//     tools/cross-platform/emboss-font-differential.mjs [font files]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  embossGlyphsWire,
  prepareEmbossTextWire,
  readEmbossFontWire,
} from "../../web/src/project/objects/embossFontExchange.ts";
import {
  encodeProjectEmbossFontReply,
  encodeProjectEmbossGlyphsReply,
  encodeProjectEmbossReply,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const core = await import(
  "data:text/javascript;base64," +
    readFileSync(new URL("core/dist/project-wasm/orcaxr_core.js", root)).toString("base64")
);
await core.default({ module_or_path: readFileSync(new URL("core/dist/project-wasm/orcaxr_core_bg.wasm", root)) });

const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tt[cf]$/i.test(name) ? [path] : [];
  });
const files = process.argv.length > 2 ? process.argv.slice(2) : walk("/usr/share/fonts").sort();
const SAMPLES = ["OrcaXR", "Ägypten ½ ∑ ffi", "Line one\nline two", "0123456789 #&@"];
const recipe = (text) => ({
  text: units(text),
  styleName: units("Differential"),
  fontDescriptor: units("differential.ttf"),
  fontDescriptorType: units("file_name"),
  font: {
    charGapMm: 0.25,
    lineGapMm: 1,
    lineHeightMm: 10,
    boldnessMm: 0,
    skew: 0,
    perGlyph: false,
    horizontal: "center",
    vertical: "center",
    collection: 0,
  },
  projection: { depthMm: 1.5, useSurface: false },
  family: { absent: {} },
  faceName: { absent: {} },
  style: { absent: {} },
  weight: { absent: {} },
});

let fonts = 0;
let outlines = 0;
let points = 0;
let cuts = 0;
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const request = { collection: 0 };
  const browser = readEmbossFontWire(request, bytes);
  const shared = core.read_emboss_font(JSON.stringify(request), bytes);
  try {
    const reply = shared.reply();
    assert.equal(reply, encodeProjectEmbossFontReply(browser.reply), `${file} read`);
    if (!browser.font) continue;
    fonts++;
    // A reply past the intent limits is split until each fits; a newline
    // splits a text into lines and is never looked up.
    const compare = (text) => {
      const ask = { text };
      let expected;
      try {
        expected = encodeProjectEmbossGlyphsReply(embossGlyphsWire(browser.font, ask));
      } catch (error) {
        assert.ok(text.length > 1, `${file} U+${text[0].toString(16)}: ${error}`);
        const half = text.length >> 1;
        compare(text.slice(0, half));
        compare(text.slice(half));
        return;
      }
      assert.equal(shared.glyphs(JSON.stringify(ask)), expected, `${file} U+${text[0].toString(16)}`);
      for (const glyph of JSON.parse(expected).glyphs?.glyphs ?? []) {
        outlines++;
        for (const contour of glyph.contours) points += contour.length;
      }
    };
    for (let start = 0; start < 0x10000; start += 128)
      compare(Array.from({ length: 128 }, (_, i) => start + i).filter((c) => c !== 0x0a));
    for (const text of SAMPLES) {
      const cut = { configuration: recipe(text) };
      const { reply, emboss } = prepareEmbossTextWire(browser.font, cut);
      const prepared = shared.prepare(JSON.stringify(cut));
      try {
        assert.equal(prepared.reply(), encodeProjectEmbossReply(reply), `${file} cut ${JSON.stringify(text)}`);
        if (emboss) {
          const bytes = emboss.preview.bytes;
          assert.equal(sha256(prepared.mesh(0, bytes.length)), sha256(bytes), `${file} mesh ${JSON.stringify(text)}`);
        }
        cuts++;
      } finally {
        prepared.free();
      }
    }
  } finally {
    shared.free();
  }
}
assert.ok(files.length > 0, "no TrueType fonts found");
console.log(
  `emboss font differential: ${files.length} files, ${fonts} fonts read; ${outlines} outlines (${points} points) and ${cuts} cuts identical`,
);
