// Emboss font references from the production browser (`embossFontExchange.ts`
// over `truetypeOutlines.ts`, and `embossExchange.ts` for the cuts). Fonts
// are synthetic TrueType files built from glyph descriptions
// (web/src/project/objects/__tests__/syntheticFonts.ts), so no third-party
// font is copied: their bytes are recorded here. They cover every path of the
// browser's reader — quadratic contours (implied midpoints, all-off-curve
// contours, dropped one-point contours, empty contours), every coordinate and
// flag encoding, skipped instructions, composite glyphs with byte, word and
// point-matched arguments and every scale form, nested composites, empty
// glyphs, short, long and non-zero `loca` formats, fewer metrics than glyphs
// and no metrics at all, cmap formats 4 (deltas, glyph arrays, overlaps,
// wrapping, out-of-range arrays, odd counts) and 12 (astral, glyph 0, past
// the glyph count) under scored encoding records, collections with every kind
// of index, and every refusal: at load (short, not TrueType, CFF, each
// required table, units per em, cut short anywhere, unreadable cmap formats)
// and when a glyph is read (nesting, contours out of order, expansion past
// the budget, points past the end).
//
// Each font is read (`EmbossFontReply`), its outlines for texts recorded
// exactly (`EmbossGlyphsReply`, every coordinate as JSON writes it), and
// recipes cut with it (`EmbossTextRequest` → `EmbossReply`, with the SHA-256
// of the mesh bytes). Every cut is also checked here to equal the same recipe
// cut from the recorded outlines (`prepareEmbossWire`). Replayed by Rust, by
// WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  SYNTHETIC_GLYPHS,
  SYNTHETIC_SANS,
  trueTypeCollection,
  trueTypeFont,
  box,
  polygon,
} from "../../web/src/project/objects/__tests__/syntheticFonts.ts";
import {
  embossGlyphsWire,
  prepareEmbossTextWire,
  readEmbossFontWire,
} from "../../web/src/project/objects/embossFontExchange.ts";
import { prepareEmbossWire } from "../../web/src/project/objects/embossExchange.ts";
import {
  decodeProjectEmbossFontRequest,
  decodeProjectEmbossGlyphsRequest,
  decodeProjectEmbossTextRequest,
  encodeProjectEmbossFontReply,
  encodeProjectEmbossFontRequest,
  encodeProjectEmbossGlyphsReply,
  encodeProjectEmbossGlyphsRequest,
  encodeProjectEmbossReply,
  encodeProjectEmbossTextRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- Glyphs ----------------------------------------------------------------------
const { notdef, a: glyphA, o: glyphO, i: glyphI } = SYNTHETIC_GLYPHS;
const simple = (contours, extra = {}) => ({ simple: { contours, ...extra } });
const sans = SYNTHETIC_SANS;
const sansSegments = SYNTHETIC_SANS.subtables[0].segments;

// Astral: format 12, long loca, 2048 units per em, no metrics.
const astral = {
  unitsPerEm: 2048,
  glyphs: [notdef, simple([polygon([[400, 0], [800, 400], [400, 800], [0, 400]])]), glyphO],
  advances: [],
  omit: ["hhea", "hmtx"],
  longLoca: true,
  subtables: [
    {
      format: 12,
      groups: [
        { start: 0x41, end: 0x42, glyph: 1 },
        { start: 0x1f600, end: 0x1f601, glyph: 1 },
        // Glyph 0 is mapped in format 12; a glyph past the count reads as empty.
        { start: 0x30, end: 0x30, glyph: 0 },
        { start: 0x31, end: 0x31, glyph: 40 },
        // Overlapping the first: the later group wins.
        { start: 0x42, end: 0x43, glyph: 2 },
      ],
    },
  ],
};

// Scored records: (3,10) beats (3,1) beats Unicode beats anything else.
const records = (...list) =>
  list.map(([platform, encoding, subtable]) => ({ platform, encoding, subtable }));
const format6 = { format: "raw", bytes: [0, 6, 0, 10, 0, 0, 0, 0x41, 0, 1] };
const mapsA = (glyph) => ({ format: 4, segments: [{ start: 0x41, end: 0x41, delta: glyph - 0x41 }] });
const scoredGlyphs = [notdef, glyphA, glyphO, glyphI];
const scored = (list, subtables) => ({
  glyphs: scoredGlyphs,
  advances: [500, 600, 700, 300],
  subtables,
  records: records(...list),
});

// Failing glyphs: read when a text needs them.
// Glyph 2 + i refers to the next; the last to the simple glyph after them.
const nest = (depth) =>
  Array.from({ length: depth }, (_, i) => ({ composite: [{ glyph: i + 3 }] }));
const deep = {
  glyphs: [notdef, glyphA, ...nest(6), glyphI],
  advances: [500],
  subtables: [
    {
      format: 4,
      segments: [
        { start: 0x41, end: 0x41, delta: 1 - 0x41 },
        // Five nested composites read; six refuse.
        { start: 0x35, end: 0x35, delta: 3 - 0x35 },
        { start: 0x36, end: 0x36, delta: 2 - 0x36 },
        { start: 0x69, end: 0x69, delta: 8 - 0x69 },
      ],
    },
  ],
};
const fanOut = (glyph) => ({
  composite: Array.from({ length: 500 }, (_, i) => ({ glyph, dx: i % 100 })),
});
const broken = {
  glyphs: [
    notdef,
    glyphA,
    simple([box(0, 0, 10, 10), box(20, 20, 30, 30)], { endPoints: [6, 3] }),
    fanOut(4),
    fanOut(5),
    simple([box(0, 0, 500, 500)]),
    { raw: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x9c, 0x3f, 0, 0] },
  ],
  advances: [500, 600],
  subtables: [
    {
      format: 4,
      segments: [
        { start: 0x41, end: 0x41, delta: 1 - 0x41 },
        { start: 0x42, end: 0x42, delta: 2 - 0x42 },
        { start: 0x43, end: 0x43, delta: 3 - 0x43 },
        { start: 0x44, end: 0x44, delta: 6 - 0x44 },
      ],
    },
  ],
};

// --- Fonts -----------------------------------------------------------------------
const fonts = new Map();
const font = (name, bytes) => {
  assert.ok(!fonts.has(name), name);
  fonts.set(name, bytes);
};
const sansBytes = trueTypeFont(sans);
font("sans", sansBytes);
font("astral", trueTypeFont(astral));
font("collection", trueTypeCollection([sans, astral]));
font("true", trueTypeFont({ ...sans, version: [0x74, 0x72, 0x75, 0x65] }));
font("typ1", trueTypeFont({ ...sans, version: [0x74, 0x79, 0x70, 0x31] }));
font("cff and glyf", trueTypeFont({ ...sans, extra: { "CFF ": [1, 0, 4, 1] } }));
font("loca format 2", trueTypeFont({ ...sans, locFormat: 2 }));
font("hmtx short", trueTypeFont({ ...sans, hMetrics: 1 }));
font("no glyphs", trueTypeFont({ ...sans, numGlyphs: 0 }));
font("scored 3.10", trueTypeFont(scored([[1, 0, 0], [0, 3, 1], [3, 1, 2], [3, 10, 3], [3, 1, 1]], [format6, mapsA(1), mapsA(2), mapsA(3)])));
font("scored 3.1", trueTypeFont(scored([[1, 0, 0], [3, 1, 2], [0, 3, 1]], [format6, mapsA(1), mapsA(2)])));
font("scored unicode", trueTypeFont(scored([[1, 0, 0], [0, 4, 1], [0, 3, 2]], [format6, mapsA(1), mapsA(2)])));
font("scored other", trueTypeFont(scored([[1, 0, 1], [2, 1, 0]], [mapsA(1), mapsA(3)])));
font(
  "odd segments",
  trueTypeFont({
    ...sans,
    subtables: [
      {
        format: 4,
        segCountX2: 5,
        segments: [
          { start: 0x41, end: 0x41, delta: 1 - 0x41 },
          { start: 0x4f, end: 0x4f, delta: 2 - 0x4f },
          { start: 0x69, end: 0x69, delta: 3 - 0x69 },
        ],
      },
    ],
  }),
);
font(
  "glyph array past the end",
  trueTypeFont({
    ...sans,
    subtables: [
      {
        format: 4,
        segments: [
          { start: 0x41, end: 0x4f, rangeOffset: 40_000 },
          { start: 0x41, end: 0x41, delta: 1 - 0x41, glyphs: [0] },
          { start: 0x4f, end: 0x4f, delta: 1, glyphs: [1] },
        ],
      },
    ],
  }),
);
font("deep", trueTypeFont(deep));
font("broken", trueTypeFont(broken));
// Refused at load.
font("empty", new Uint8Array(0));
font("short", Uint8Array.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0]));
font("otto", trueTypeFont({ ...sans, version: [0x4f, 0x54, 0x54, 0x4f] }));
font("woff", trueTypeFont({ ...sans, version: [0x77, 0x4f, 0x46, 0x46] }));
font("cff only", trueTypeFont({ ...sans, omit: ["glyf"], extra: { "CFF ": [1, 0, 4, 1] } }));
for (const table of ["head", "maxp", "loca", "glyf", "cmap"])
  font(`no ${table}`, trueTypeFont({ ...sans, omit: [table] }));
font("no units per em", trueTypeFont({ ...sans, unitsPerEm: 0 }));
font("format 6", trueTypeFont({ ...sans, subtables: [format6] }));
font("no records", trueTypeFont({ ...sans, records: [] }));
font(
  "format 4 past the end",
  trueTypeFont({ ...sans, subtables: [{ format: 4, segCountX2: 0xfffe, segments: sansSegments }] }),
);
font(
  "format 12 past the end",
  trueTypeFont({ ...sans, subtables: [{ format: "raw", bytes: [0, 12, 0, 0, 0, 0, 0, 28, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0, 0x41, 0, 0, 0, 0x41] }] }),
);
font("glyphs past loca", trueTypeFont({ ...sans, numGlyphs: 5000 }));
for (const length of [12, 24, 60, 200, sansBytes.length - 200, sansBytes.length - 1])
  font(`cut at ${length}`, sansBytes.subarray(0, length));

// --- The script ------------------------------------------------------------------
const steps = [];
const handles = new Map();
const readFont = (handle, name, collection = 0) => {
  const request = encodeProjectEmbossFontRequest({ collection });
  const { reply, font: source } = readEmbossFontWire(
    decodeProjectEmbossFontRequest(request),
    fonts.get(name),
  );
  steps.push({ read: request, file: name, handle, reply: encodeProjectEmbossFontReply(reply) });
  if (source) handles.set(handle, source);
  return source;
};
const glyphs = (handle, text) => {
  const request = encodeProjectEmbossGlyphsRequest({ text: units(text) });
  const reply = embossGlyphsWire(
    handles.get(handle),
    decodeProjectEmbossGlyphsRequest(request),
  );
  steps.push({ glyphs: request, handle, reply: encodeProjectEmbossGlyphsReply(reply) });
  return reply;
};
const configuration = (text, extra = {}) => {
  const { font: fontProps = {}, projection = {}, ...rest } = extra;
  return {
    text: units(text),
    styleName: units("Synthetic"),
    fontDescriptor: units("synthetic.ttf"),
    fontDescriptorType: units("file_name"),
    font: {
      charGapMm: 0,
      lineGapMm: 0,
      lineHeightMm: 10,
      boldnessMm: 0,
      skew: 0,
      perGlyph: false,
      horizontal: "center",
      vertical: "center",
      collection: 0,
      ...fontProps,
    },
    projection: { depthMm: 1, useSurface: false, ...projection },
    family: { absent: {} },
    faceName: { absent: {} },
    style: { absent: {} },
    weight: { absent: {} },
    ...rest,
  };
};
const cut = (handle, text, extra = {}) => {
  const recipe = configuration(text, extra);
  const request = encodeProjectEmbossTextRequest({ configuration: recipe });
  const source = handles.get(handle);
  const { reply, emboss } = prepareEmbossTextWire(
    source,
    decodeProjectEmbossTextRequest(request),
  );
  const step = { prepare: request, handle, reply: encodeProjectEmbossReply(reply) };
  if (emboss) {
    const bytes = emboss.preview.bytes;
    step.mesh = sha256(bytes);
    if (bytes.length >= 80) step.window = sha256(bytes.subarray(16, 80));
  }
  steps.push(step);
  // The same recipe cut from the text's recorded outlines answers the same.
  const outlines = embossGlyphsWire(source, { text: recipe.text });
  if ("glyphs" in outlines) {
    const viaWire = prepareEmbossWire({ configuration: recipe, font: outlines.glyphs });
    assert.equal(encodeProjectEmbossReply(viaWire.reply), step.reply, `${handle} ${text}`);
    if (viaWire.emboss) assert.equal(sha256(viaWire.emboss.preview.bytes), step.mesh);
  } else {
    assert.ok("refused" in reply && reply.refused.code !== "noGlyphs");
  }
};

// The sans font: every glyph, missing and repeated characters, lines.
readFont("sans", "sans");
glyphs("sans", "AOi Ä#8LE");
glyphs("sans", "AAzA\nOĀā￿");
glyphs("sans", "");
glyphs("sans", "\n\n");
glyphs("sans", "A\ud800B\udc00");
glyphs("sans", "\u{1f600}");
cut("sans", "AOi Ä#8LE");
cut("sans", "AO\ni Ä", { font: { horizontal: "left", vertical: "top", lineGapMm: 1.5, charGapMm: 0.25 } });
cut("sans", "#8\nLE\nA", { font: { horizontal: "right", vertical: "bottom", skew: 0.2, lineHeightMm: 7.5 } });
cut("sans", "AzO", { projection: { depthMm: 2.25 } });
cut("sans", "zzz");
cut("sans", "   ");
cut("sans", "");
cut("sans", "A", { font: { lineHeightMm: 0 } });
cut("sans", "AOi", { font: { collection: 1.5 } });
// The astral font: format 12 with glyph 0, a glyph past the count and no metrics.
readFont("astral", "astral");
glyphs("astral", "AB\u{1f600}\u{1f601}C01x");
cut("astral", "A\u{1f600}B", { font: { horizontal: "left" } });
cut("astral", "01");
// The collection: each font, and every index the browser refuses or accepts.
readFont("collection 0", "collection", 0);
readFont("collection 1", "collection", 1);
readFont("collection -0", "collection", -0);
readFont("collection 2", "collection", 2);
readFont("collection 1.5", "collection", 1.5);
readFont("collection -1", "collection", -1);
readFont("collection huge", "collection", 2 ** 53);
readFont("collection 1e21", "collection", 1e21);
glyphs("collection 0", "AOi");
glyphs("collection 1", "AB\u{1f600}");
cut("collection 1", "AB");
// Accepted magic numbers, a CFF table beside glyf, loca format 2 read as long,
// fewer metrics than glyphs, no glyphs at all.
for (const name of ["true", "typ1", "cff and glyf", "loca format 2", "hmtx short", "no glyphs"]) {
  readFont(name, name, 3);
  glyphs(name, "AOi Ä#8LE");
}
cut("hmtx short", "AOi");
cut("no glyphs", "AOi");
// Encoding records, scored.
for (const name of ["scored 3.10", "scored 3.1", "scored unicode", "scored other"]) {
  readFont(name, name);
  glyphs(name, "A");
}
readFont("odd segments", "odd segments");
glyphs("odd segments", "AOi");
readFont("glyph array past the end", "glyph array past the end");
glyphs("glyph array past the end", "ABO");
// Glyphs that refuse when read, after the ones that do not.
readFont("deep", "deep");
glyphs("deep", "A5");
glyphs("deep", "A56");
glyphs("deep", "6A");
cut("deep", "A5");
cut("deep", "A6");
cut("deep", "", { font: { lineHeightMm: 10 } });
cut("deep", "6", { font: { lineHeightMm: -1 } });
readFont("broken", "broken");
glyphs("broken", "A");
glyphs("broken", "AB");
glyphs("broken", "C");
glyphs("broken", "D");
cut("broken", "AC");
cut("broken", "D");
// Refused at load.
for (const name of [
  "empty",
  "short",
  "otto",
  "woff",
  "cff only",
  "no head",
  "no maxp",
  "no loca",
  "no glyf",
  "no cmap",
  "no units per em",
  "format 6",
  "no records",
  "format 4 past the end",
  "format 12 past the end",
  "glyphs past loca",
  ...[...fonts.keys()].filter((name) => name.startsWith("cut at ")),
])
  readFont(name, name);
glyphs("no records", "A");

const sources = [
  "tools/cross-platform/emboss-font-vectors.mjs",
  "web/src/project/objects/__tests__/syntheticFonts.ts",
  "web/src/project/objects/embossFontExchange.ts",
  "web/src/project/objects/truetypeOutlines.ts",
  "web/src/project/objects/embossExchange.ts",
  "web/src/project/objects/emboss.ts",
  "web/src/project/objects/extrude.ts",
  "web/src/project/objects/polygonTriangulation.ts",
  "contracts/project-intents.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      fonts: [...fonts].map(([name, bytes]) => ({
        name,
        bytes: Buffer.from(bytes).toString("base64"),
      })),
      steps,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/emboss-font-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "Emboss font reference drift");
const replies = (key) => steps.filter((s) => key in s).map((s) => JSON.parse(s.reply));
const kinds = (list) =>
  Object.entries(Object.groupBy(list, (r) => Object.keys(r)[0]))
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ");
const outlines = replies("glyphs").flatMap((r) => r.glyphs?.glyphs ?? []);
console.log(
  `emboss fonts: ${fonts.size} fonts; ${steps.filter((s) => "read" in s).length} reads (${kinds(replies("read"))}), ${steps.filter((s) => "glyphs" in s).length} outline requests (${kinds(replies("glyphs"))}; ${outlines.length} outlines, ${outlines.reduce((n, g) => n + g.contours.reduce((m, c) => m + c.length, 0), 0)} points), ${steps.filter((s) => "prepare" in s).length} cuts (${kinds(replies("prepare"))})`,
);
