// Text embossing references from the production browser (`embossExchange.ts`
// over `emboss.ts`, `extrude.ts` and `polygonTriangulation.ts`): a synthetic
// font whose glyphs exercise every path of the ear clipper — counters, two
// counters in one glyph, concentric rings, overlapping bars that meet on a
// face, separate pieces, touching parts, a self-crossing contour, repeated and
// collinear points, a degenerate contour, an unenclosed counter-wound piece,
// a counter touching its outline and an astral-plane code point — cut under
// every alignment, skew, gap and line count, with missing glyphs and every
// refusal; each cut recorded with the SHA-256 of its mesh bytes. A host
// script then stages cuts as new text parts and as re-cuts (applied, refused
// when run, and refused when unnamed), with undo and redo. Replayed by Rust,
// by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession } from "../../web/src/project/session.ts";
import {
  AsyncEditorSession,
  AsyncSessionError,
} from "../../web/src/project/AsyncEditorSession.ts";
import {
  ProjectSessionEndpoint,
  wireSessionGuard,
} from "../../web/src/project/ProjectSessionEndpoint.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { assertValidProjectState } from "../../web/src/project/domain/validation.ts";
import { StagedInputError } from "../../web/src/project/StagedProjectCommands.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { prepareEmbossWire } from "../../web/src/project/objects/embossExchange.ts";
import {
  decodeProjectEmbossRequest,
  decodeProjectEmbossStage,
  encodeProjectEmbossReply,
  encodeProjectEmbossRequest,
  encodeProjectEmbossStage,
  encodeProjectSessionRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- A synthetic font in 1000 units per em ---------------------------------------
const rect = (x0, y0, x1, y1, ccw = true) => {
  const points = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return ccw ? points : points.reverse();
};
const ring = (cx, cy, r, n, ccw = true) => {
  const points = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))];
  });
  return ccw ? points : points.reverse();
};
const glyph = (char, advance, contours) => ({
  codePoint: char.codePointAt(0),
  advance,
  contours,
});
const font = {
  unitsPerEm: 1000,
  glyphs: [
    // A: an outline with one triangular counter.
    glyph("A", 650, [
      [
        [0, 0],
        [150, 0],
        [210, 200],
        [440, 200],
        [500, 0],
        [650, 0],
        [400, 700],
        [250, 700],
      ],
      [
        [260, 320],
        [325, 520],
        [390, 320],
      ].reverse(),
    ]),
    // B: two counters in one outline.
    glyph("B", 600, [
      rect(0, 0, 550, 700),
      rect(120, 100, 420, 300, false),
      rect(120, 400, 420, 600, false),
    ]),
    // O and 8: concentric rings, and two stacked ones.
    glyph("O", 700, [ring(350, 350, 340, 32), ring(350, 350, 200, 24, false)]),
    glyph("8", 600, [
      ring(300, 190, 180, 20),
      ring(300, 190, 80, 12, false),
      ring(300, 510, 160, 20),
      ring(300, 510, 70, 12, false),
    ]),
    // #: four overlapping bars, each its own solid.
    glyph("#", 700, [
      rect(150, 0, 250, 700),
      rect(450, 0, 550, 700),
      rect(0, 200, 700, 300),
      rect(0, 450, 700, 550),
    ]),
    // i: a stem and a separate dot.
    glyph("i", 300, [rect(100, 0, 200, 450), rect(100, 550, 200, 650)]),
    // ç: a c and a cedilla that touches it.
    glyph("ç", 550, [
      [
        [500, 100],
        [100, 100],
        [100, 500],
        [500, 500],
        [500, 400],
        [200, 400],
        [200, 200],
        [500, 200],
      ],
      rect(250, -100, 350, 100),
    ]),
    // x: one self-crossing contour (a bow tie).
    glyph("x", 500, [
      [
        [0, 0],
        [500, 500],
        [500, 0],
        [0, 500],
      ],
    ]),
    // -: a bar with repeated and collinear points, and a degenerate contour.
    glyph("-", 400, [
      [
        [0, 300],
        [100, 300],
        [100, 300],
        [200, 300],
        [400, 300],
        [400, 400],
        [200, 400],
        [0, 400],
      ],
      [
        [0, 0],
        [10, 0],
      ],
    ]),
    // %: two rings and a slash, and a counter-wound piece enclosed by nothing.
    glyph("%", 800, [
      ring(150, 550, 120, 16),
      ring(150, 550, 50, 10, false),
      ring(650, 150, 120, 16),
      ring(650, 150, 50, 10, false),
      [
        [550, 700],
        [650, 700],
        [250, 0],
        [150, 0],
      ],
    ]),
    // Q: a counter touching its outline at a vertex.
    glyph("Q", 600, [
      rect(0, 0, 600, 600),
      [
        [0, 300],
        [300, 450],
        [300, 150],
      ],
    ]),
    glyph(" ", 250, []),
    // An astral-plane code point: a diamond.
    glyph("😀", 800, [
      [
        [400, 0],
        [800, 400],
        [400, 800],
        [0, 400],
      ],
    ]),
  ],
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

// --- The project -------------------------------------------------------------
const fixture = createProjectFixture();
const state = structuredClone(fixture.state);
assertValidProjectState(state);
const assets = new InMemoryAssetRepository();
assets.put(fixture.asset.descriptor, fixture.asset.bytes);
const objectId = state.plates[0].objects[0].id;
const plainVolume = state.plates[0].objects[0].volumes[0].id;

const session = new EditorSession({
  initialState: state,
  assets,
  serializer: {
    serialize: () => Promise.reject(new Error("unused")),
    deserialize: () => Promise.reject(new Error("unused")),
  },
});
const nonce = [0, 1, 2147483648, 4294967295];
const facade = new AsyncEditorSession(session);
const endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
endpoint.configureStaging({
  maxResources: 4,
  maxCommands: 16,
  maxUnits: 64_000_000,
  maxAssetBytes: 16_000_000,
});
const input = {
  maxUnits: 64_000_000,
  maxNodes: 64_000_000,
  maxDepth: 128,
  maxAssets: 64,
  maxAssetBytes: 16_000_000,
};
let sequence = 0;
const handle = async (operation) =>
  JSON.parse(
    await endpoint.handle(
      encodeProjectSessionRequest({
        protocolVersion: 1,
        generation: nonce,
        requestId: ++sequence,
        operation,
      }),
    ),
  ).result;
assert.ok(
  (
    await handle({
      hello: {
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
        projectSchemaVersion: 1,
        intentVersion: 1,
      },
    })
  ).welcome,
);

// --- The host script ----------------------------------------------------------
const steps = [];
const cuts = new Map();
const observe = () => {
  const snapshot = session.project.getSnapshot();
  const history = session.commands.getHistorySnapshot();
  return {
    revision: snapshot.revision,
    hash: snapshot.hash,
    undoLabel:
      history.undoLabel === undefined ? null : units(history.undoLabel),
  };
};
function prepare(name, text, extra = {}, glyphs = font) {
  const request = encodeProjectEmbossRequest({
    configuration: configuration(text, extra),
    font: glyphs,
  });
  const { reply, emboss } = prepareEmbossWire(
    decodeProjectEmbossRequest(request),
  );
  const step = {
    emboss: name,
    prepare: request,
    reply: encodeProjectEmbossReply(reply),
  };
  cuts.set(name, emboss);
  if (emboss) {
    const bytes = emboss.preview.bytes;
    step.mesh = sha256(bytes);
    if (bytes.length >= 80) step.window = sha256(bytes.subarray(16, 80));
  }
  steps.push(step);
}
const code = (e) =>
  e instanceof AsyncSessionError
    ? e.code === "invalid-request"
      ? "invalidRequest"
      : e.code
    : e instanceof StagedInputError && e.code === "limit"
      ? "resourceLimit"
      : "invalidRequest";
async function stage(name, request) {
  const text = encodeProjectEmbossStage(request);
  const emboss = cuts.get(name);
  let outcome;
  try {
    if (!emboss) throw new StagedInputError("invalid");
    const work = emboss.work(decodeProjectEmbossStage(text), input);
    const stagedId = endpoint.stage(work, facade.captureGuard());
    const result = await handle({ executeStaged: { stagedId } });
    outcome =
      "acknowledged" in result
        ? result.acknowledged.changed
          ? "applied"
          : "unchanged"
        : result.error;
  } catch (e) {
    outcome = code(e);
  }
  steps.push({ emboss: name, stage: text, outcome, ...observe() });
}
async function history(direction) {
  const result = await handle({
    [direction]: wireSessionGuard(facade.captureGuard()),
  });
  assert.ok("acknowledged" in result, direction);
  steps.push({ history: direction, ...observe() });
}

// Cuts: every glyph, alignments, skew, gaps, lines and depths.
prepare("AB8", "AB8");
prepare("O#i", "O#i");
prepare("çx-", "çx-");
prepare("%Q", "%Q");
prepare("astral", "A😀A");
prepare("lone", "A\ud800B");
for (const horizontal of ["left", "center", "right"])
  for (const vertical of ["top", "center", "bottom"])
    prepare(`lines ${horizontal} ${vertical}`, "AB\nO\n8i#", {
      font: { horizontal, vertical, lineGapMm: 2, charGapMm: 0.5 },
    });
prepare("skewed", "B8", { font: { skew: 0.25, lineHeightMm: 7 } });
prepare("deep", "#", { projection: { depthMm: 3.5 } });
prepare("gaps", "i i", { font: { charGapMm: -1.25, lineGapMm: -3 } });
prepare("missing", "AzB");
prepare("faces", "A", {
  family: { value: units("Synthetic Sans") },
  faceName: { value: units("Bold") },
  style: { value: units("normal") },
  weight: { value: units("700") },
});
prepare("long", "AB8O#içx-%Q".repeat(4));
// Refusals.
prepare("empty", "");
prepare("no height", "A", { font: { lineHeightMm: 0 } });
prepare("fractional collection", "A", { font: { collection: 1.5 } });
prepare("negative collection", "A", { font: { collection: -1 } });
prepare("no depth", "A", { projection: { depthMm: 0 } });
prepare("no em", "A", {}, { ...font, unitsPerEm: 0 });
prepare("all missing", "zzz");
prepare("spaces", "   ");

// Stages.
const transform = {
  translationMm: [2, -3, 4],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};
await stage("AB8", {
  add: {
    objectId: units(objectId),
    volumeId: units("import:host:emboss-ab8"),
    assetId: units("import:host:emboss-ab8-mesh"),
    transform,
  },
});
await stage("O#i", {
  add: {
    objectId: units(objectId),
    volumeId: units("import:host:emboss-ab8"),
    assetId: units("import:host:emboss-o-mesh"),
    transform,
  },
});
await stage("O#i", {
  edit: {
    volumeId: units("import:host:emboss-ab8"),
    assetId: units("import:host:emboss-o-mesh"),
  },
});
await stage("çx-", {
  edit: {
    volumeId: units(plainVolume),
    assetId: units("import:host:emboss-c-mesh"),
  },
});
await stage("%Q", {
  add: {
    objectId: units(objectId),
    volumeId: units("import:host:emboss-pq"),
    assetId: units(" import:host:padded"),
    transform,
  },
});
await stage("empty", {
  add: {
    objectId: units(objectId),
    volumeId: units("import:host:emboss-empty"),
    assetId: units("import:host:emboss-empty-mesh"),
    transform,
  },
});
await stage("%Q", {
  add: {
    objectId: units("import:object:missing"),
    volumeId: units("import:host:emboss-pq"),
    assetId: units("import:host:emboss-pq-mesh"),
    transform,
  },
});
await history("undo");
await history("undo");
await history("redo");
await stage("skewed", {
  add: {
    objectId: units(objectId),
    volumeId: units("import:host:emboss-skewed"),
    assetId: units("import:host:emboss-skewed-mesh"),
    transform: {
      translationMm: [0, 0, 0],
      rotation: [0, 0, 0.7071067811865476, 0.7071067811865476],
      scale: [2, 2, 1],
    },
  },
});
session.dispose();

const sources = [
  "tools/cross-platform/emboss-vectors.mjs",
  "web/src/project/objects/embossExchange.ts",
  "web/src/project/objects/emboss.ts",
  "web/src/project/objects/extrude.ts",
  "web/src/project/objects/polygonTriangulation.ts",
  "web/src/project/objects/embossCommands.ts",
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
      stateJson: canonicalStringify(state),
      assets: [fixture.asset].map((a) => ({
        descriptorJson: canonicalStringify(a.descriptor),
        bytes: [...a.bytes],
      })),
      steps,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/emboss-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Emboss reference drift");
const count = (predicate) => steps.filter(predicate).length;
const outcomes = Object.groupBy(
  steps.filter((s) => "outcome" in s),
  (s) => s.outcome,
);
const prepared = steps
  .filter((s) => s.reply?.startsWith('{"prepared"'))
  .map((s) => JSON.parse(s.reply).prepared);
console.log(
  `emboss: ${count((s) => "prepare" in s)} cuts (${prepared.length} prepared, ${prepared.reduce((n, p) => n + p.triangleCount, 0)} triangles, ${prepared.filter((p) => p.openEdgeCount > 0).length} open, ${prepared.filter((p) => p.coincidentEdgeCount > 0).length} coincident), stages ${Object.entries(
    outcomes,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}, ${count((s) => "history" in s)} history steps`,
);
