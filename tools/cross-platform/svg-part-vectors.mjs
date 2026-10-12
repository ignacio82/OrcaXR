// SVG part references from the production browser (`svgPartExchange.ts` over
// `svgCommands.ts`, `svgShapes.ts`, `extrude.ts` and
// `polygonTriangulation.ts`). Two parts:
//
// - Readings: curated drawings covering every path of the hand-written reader
//   (units, viewBoxes, stylesheets and their cascade, inherited paint, every
//   path command and transform, the XML quirks it tolerates, its refusals)
//   and seeded random documents combining them with malformed spellings,
//   each read with and without a target width. A reading records the
//   SHA-256 of its contours as float64s, its size as IEEE bits and every
//   unsupported feature, so the Rust reader is pinned bit for bit.
// - Exchange: drawings sent as file bytes (a byte-order mark, malformed UTF-8,
//   truncated features and messages, every refusal) cut and recorded with the
//   SHA-256 of their mesh bytes, then staged into a live session as new parts
//   and re-cuts (applied, refused when run, refused when unnamed), with undo
//   and redo. Each drawing is also read on its own, as the SVG part tool reads
//   a picked file (`SvgDrawingReply`: its size and notes, or its refusal).
//   Replayed by Rust, by WASM in Node and Chrome, and over JNI.
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
import {
  readSvgShapes,
  SvgError,
} from "../../web/src/project/objects/svgShapes.ts";
import {
  prepareSvgPartWire,
  readSvgDrawingWire,
} from "../../web/src/project/objects/svgPartExchange.ts";
import {
  decodeProjectSvgPartRequest,
  decodeProjectSvgPartStage,
  encodeProjectSvgDrawingReply,
  encodeProjectSvgPartReply,
  encodeProjectSvgPartRequest,
  encodeProjectSvgPartStage,
  encodeProjectSessionRequest,
} from "../../contracts/generated/project-intents.ts";
import { randomSvgs } from "./svg-random-documents.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = new Float64Array(1);
const words = new BigUint64Array(scratch.buffer);
const bits = (value) => {
  scratch[0] = value;
  return words[0].toString(16).padStart(16, "0");
};

// --- Readings ------------------------------------------------------------------
const svg = (
  body,
  attributes = 'width="100mm" height="50mm" viewBox="0 0 100 50"',
) => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const square = '<path d="M10 10 H40 V40 H10 Z"/>';
const curated = [
  // Sizes: units, viewBoxes and their absence.
  ...[
    "px",
    "pt",
    "pc",
    "mm",
    "cm",
    "in",
    "q",
    "Q",
    "MM",
    "%",
    "em",
    "constructor",
    "",
  ].map((u) => svg(square, `width="120${u}" height="60${u}"`)),
  svg(square, 'width="1e2mm" height=" 50 mm " viewBox="0,0,100,50"'),
  svg(square, 'width="+.5e2mm" height="1.2.3mm" viewBox="0 0 100"'),
  svg(square, 'viewBox="-20 -10 100 50"'),
  svg(square, 'viewBox="0 0 -1 50" width="20mm"'),
  svg(square, ""),
  svg(square, 'width="\u00a080mm\u3000" height="40mm"'),
  svg(square, 'width="10mm" height="10mm" transform="scale(2) rotate(15)"'),
  // Every shape, and their degenerate forms.
  svg(
    '<rect x="5" y="5" width="30" height="20"/><rect x="40" y="5" width="30" height="20" rx="4"/><rect x="5" y="30" width="30" height="15" ry="6" rx=""/><rect width="0" height="5"/><rect width="10" height="10" rx="-2"/><rect width="10" height="10" rx="50" ry="2"/>',
  ),
  svg(
    '<circle cx="20" cy="20" r="10"/><circle r="0"/><circle cx="1e400" r="5"/><ellipse cx="60" cy="25" rx="20" ry="8"/><ellipse rx="5" ry="0"/>',
  ),
  svg(
    '<polygon points="10,10 40,10 40,40 10,40"/><polyline points="50 10 80 10 80 40 50 40 60"/><polygon points="1,1 2,2"/>',
  ),
  svg('<line x1="0" y1="0" x2="10" y2="10"/>' + square),
  // Paths: every command, relative and absolute, implicit repeats, smooth
  // reflections, arcs and malformed data.
  svg('<path d="M10 10 L40 10 40 40 10 40 Z m5 5 l10 0 0 10 -10 0 z"/>'),
  svg(
    '<path d="M10 10 h30 v30 H10 V10 z M50 10 C60 0 80 0 90 10 S90 40 70 40 Q50 40 50 25 T50 10 Z"/>',
  ),
  svg(
    '<path d="M10 25 c0-10 20-10 20 0 s20 10 20 0 q10-10 20 0 t20 0 L90 45 H10 Z"/>',
  ),
  svg('<path d="M10 25 L20 25 S30 10 40 25 T60 25 L60 45 L10 45 Z"/>'),
  svg(
    '<path d="M10 25 A15 15 0 0 1 40 25 A15 15 0 1 1 10 25 Z M60 25 a10 5 30 1 0 20 0 a10 5 30 0 0 -20 0 z"/>',
  ),
  svg(
    '<path d="M10 25 A0 15 0 0 1 40 25 L40 45 L10 45 Z M50 25 A5 5 0 0 1 50 25 L60 40 L50 40 Z M60 10 A1 1 0 0 1 90 10 L90 40 Z"/>',
  ),
  svg('<path d="M10 25 A15 15 0 0110 40 L40 40 Z"/>'),
  svg('<path d="M10 10L40 10L40 40L10 40ZM1.5.5.5 1 2 3"/>'),
  svg('<path d="M10 10 L40 10 L40 40 L10 40 Z L5"/>'),
  svg('<path d="garbage"/><path d="  "/><path d=""/><path/>' + square),
  svg('<path d="M10 10 C20 20 30"/>' + square),
  svg('<path d="M10-10e0L+40,10l-.5.5-30 30z"/>'),
  svg('<path d="M10 10 L40 10 L40 40 L10 40 L1e308 10 L-1e308 10 Z"/>'),
  // Transforms.
  svg(
    `<g transform="translate(10 5) scale(0.5) rotate(30 20 20)">${square}</g>`,
  ),
  svg(
    `<g transform="skewX(20)">${square}</g><g transform="skewY(-35)">${square}</g><g transform="skewX(90)">${square}</g>`,
  ),
  svg(
    `<g transform="matrix(1 0.2 -0.3 1 5 6)">${square}</g><g transform="matrix(1 2)">${square}</g>`,
  ),
  svg(
    `<g transform="translate(5)scale(2,0.5)">${square}</g><g transform="SCALE (2)">${square}</g>`,
  ),
  svg(
    `<g transform="perspective(5) rotate(10">${square}</g><g transform="translate10">${square}</g>`,
  ),
  svg(
    `<path transform="rotate(45)" d="M10 10 H40 V40 H10 Z"/><path transform="xscale(2)" d="M50 10 H60 V20 Z"/>`,
  ),
  // Presentation: inheritance and the cascade.
  svg(
    `<g fill="none" stroke="#000">${square}<path fill="red" d="M50 10 H60 V20 Z"/></g>`,
  ),
  svg(
    `<g fill="none" stroke="#000"><title>Logo</title><desc>d</desc><style>path{}</style>${square}</g>`,
  ),
  svg(
    `<g style="fill:none;stroke:#000">${square}</g><g fill="none" stroke="none">${square}</g>`,
  ),
  svg(
    `<path style="fill:#f00;fill:none;stroke:#000" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<path style="FILL : NONE ; Stroke:black" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<path fill="none" stroke="#000" style="fill: red" d="M0 0 L50 0 L50 50 Z"/>`,
  ),
  svg(
    `<path fill="none" stroke="#000" style="fill: red !important" d="M0 0 L50 0 L50 50 Z"/><path style="fill:none ! IMPORTANT;stroke:#000" d="M60 0 L90 0 L90 30 Z"/>`,
  ),
  svg(
    `<style>.line{fill:none;stroke:#000}</style><path class="line" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<style>.b{fill:none;stroke:#000} .a{fill:#f00}</style><path class="a b" d="M0 0 L50 0 L50 50 Z"/><path class="b a" d="M60 0 L90 0 L90 30 Z"/>`,
  ),
  svg(
    `<style>#p{fill:none;stroke:#000} .a{fill:#f00} path{fill:red}</style><path id="p" class="a" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<style>.a{fill:none !important;stroke:#000}</style><path class="a" style="fill:red" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<style>/* .x{fill:none;stroke:#000} */ path { fill : none ; stroke : #000 } rect{fill:red}</style>${square}<rect width="5" height="5"/>`,
  ),
  svg(
    `<style>@media print { path { fill: none; stroke: #000 } } @import url(a.css); @font-face{font-family:x} path{stroke:#000}</style>${square}`,
  ),
  svg(
    `<style>g path, .a > b, *, a:hover, .a.b, #p{fill:none;stroke:#000} , rect{fill:none;stroke:#111}</style>${square}<rect width="5" height="5"/>`,
  ),
  svg(`<style>a{b{fill:none}} path{fill:none;stroke:#000}</style>${square}`),
  svg(`<style>{fill:none} x{fill:none} path{stroke:#000</style>${square}`),
  svg(
    `<STYLE type="text/css"><![CDATA[ .c-1{fill:none;stroke:red} ]]></STYLE><path class="c-1\u3000other" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<style>.a{color:red}</style><style>.a{fill:none;stroke:#000}</style><path class="a" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<style>path{fill:none;stroke:#000}</style><path id="constructor" class="toString" d="M0 0 L50 0 L50 50 Z"/>${square}`,
  ),
  svg(
    `<styles>path{fill:none;stroke:#000}</styles>${square}<style>path{fill:none;stroke:#000}`,
  ),
  // Unsupported elements, containers and XML quirks.
  svg(
    `<text>hi</text><tspan/><textPath/><image/><use/><clipPath/><mask/><filter/><pattern/><linearGradient/><radialGradient/><marker/>${square}`,
  ),
  svg(
    `<defs>${square}</defs><a>${square}</a><switch>${square}</switch><svg>${square}</svg><symbol>${square}</symbol><foo>${square}</foo>`,
  ),
  svg(
    `<constructor/><toString/><__proto__/>${square}<path __proto__="x" constructor="y" d="M50 10 H60 V20 Z"/>`,
  ),
  svg(
    `<!-- <rect width="50" height="50"/> --><![CDATA[<rect width="50" height="50"/>]]><?pi x?><!DOCTYPE x>${square}`,
  ),
  svg(
    `<svg:path d="M10 10 H40 V40 H10 Z"/><PATH D="M50 10 H60 V20 Z"/><Path d='M70 10 H80 V20 Z'/>`,
  ),
  svg(
    `<path d="M10 10 H40 V40 H10 Z" fill="&quot;none&quot;" stroke="#000"/><path d="M50 10 H60 V20 Z" fill="&amp;lt;"/>`,
  ),
  svg(
    `<path a="1"b="2" d="M10 10 H40 V40 H10 Z" x"y="3" d='M50 10 H60 V20 Z'/>`,
  ),
  svg(
    `<path d="M10 10 H40 V40 H10 Z" fill = "none" stroke="#000" fill="red"/>`,
  ),
  svg(`<g><path d="M10 10 H40 V40 H10 Z"></path></g></g>${square}`),
  svg(`< path d="M10 10 H40 V40 H10 Z"/>${square}`),
  svg(`<ÄRGER/><Σ/><İ/>${square}`),
  `\ufeff<?xml version="1.0"?><!DOCTYPE svg><SVG width="20mm" height="20mm">${square}</SVG>`,
  `<svg-x width="20mm">${square}</svg-x>`,
  `<svgx/><svg width="20mm">${square}</svg>`,
  `<svg width="20mm"/>`,
  `<svg width="20mm"`,
  `no drawing here`,
  `<svg width="20mm"><text>only words</text></svg>`,
  `<svg width="20mm"></svg>`,
  `<svg width="20mm"><g fill="none" stroke="#000"><path d="M0 0 L10 0"/></g></svg>`,
  // Nesting at and past the limit.
  `<svg>${"<g>".repeat(256)}${square}${"</g>".repeat(256)}</svg>`,
  `<svg>${"<g>".repeat(257)}${square}${"</g>".repeat(257)}</svg>`,
];
const readings = [];
const reading = (source, width) => {
  // As IEEE bits: JSON has no NaN or infinities.
  const entry = { source, width: width === undefined ? null : bits(width) };
  try {
    const shapes = readSvgShapes(source, width);
    const flat = [shapes.contours.length];
    for (const contour of shapes.contours) {
      flat.push(contour.length);
      for (const [x, y] of contour) flat.push(x, y);
    }
    entry.contours = sha256(new Uint8Array(Float64Array.from(flat).buffer));
    entry.contourCount = shapes.contours.length;
    entry.sizeMm = shapes.sizeMm.map(bits);
    entry.unsupported = shapes.unsupported.map((f) => [
      f.element,
      f.reason,
      f.detail,
    ]);
  } catch (error) {
    if (!(error instanceof SvgError)) throw error;
    entry.error = [error.code, error.message];
  }
  readings.push(entry);
};
for (const source of curated) {
  reading(source);
  reading(source, 37.5);
}
reading(curated[0], 0);
reading(curated[0], -2);
reading(curated[0], NaN);
reading(curated[0], Infinity);
for (const { source, width } of randomSvgs(360)) reading(source, width);

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
const utf8 = (text) => new TextEncoder().encode(text);
function prepare(name, drawing, recipe = {}) {
  const request = encodeProjectSvgPartRequest({
    fileName: units(recipe.fileName ?? `${name}.svg`),
    depthMm: recipe.depthMm ?? 2,
    widthMm:
      recipe.widthMm === undefined ? { absent: {} } : { value: recipe.widthMm },
    useSurface: recipe.useSurface ?? false,
    sourcePath:
      recipe.sourcePath === undefined
        ? { absent: {} }
        : { value: units(recipe.sourcePath) },
  });
  const bytes = typeof drawing === "string" ? utf8(drawing) : drawing;
  const { reply, svg: cut } = prepareSvgPartWire(
    decodeProjectSvgPartRequest(request),
    bytes,
  );
  const step = {
    svg: name,
    prepare: request,
    drawing: Buffer.from(bytes).toString("base64"),
    reply: encodeProjectSvgPartReply(reply),
    read: encodeProjectSvgDrawingReply(readSvgDrawingWire(bytes)),
  };
  cuts.set(name, cut);
  if (cut) {
    const mesh = cut.cut.preview.bytes;
    step.mesh = sha256(mesh);
    if (mesh.length >= 80) step.window = sha256(mesh.subarray(16, 80));
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
  const text = encodeProjectSvgPartStage(request);
  const cut = cuts.get(name);
  let outcome;
  try {
    if (!cut) throw new StagedInputError("invalid");
    const work = cut.work(decodeProjectSvgPartStage(text), input);
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
  steps.push({ svg: name, stage: text, outcome, ...observe() });
}
async function history(direction) {
  const result = await handle({
    [direction]: wireSessionGuard(facade.captureGuard()),
  });
  assert.ok("acknowledged" in result, direction);
  steps.push({ history: direction, ...observe() });
}

const logo = svg(
  '<path d="M0 0 H40 V20 H0 Z M10 5 V15 H30 V5 Z"/><circle cx="50" cy="10" r="8"/>',
);
prepare("logo", logo);
prepare("wide", logo, {
  widthMm: 40,
  depthMm: 3,
  useSurface: true,
  sourcePath: "C:\\art\\logo.svg",
  fileName: "Logo.SVG",
});
prepare("bom", Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(svg(square))]));
prepare(
  "malformed",
  Uint8Array.from([
    ...utf8(svg(`<!-- `)),
    0xff,
    0xc3,
    0x28,
    0xe2,
    0x82,
    0xf0,
    0x9f,
    0x98,
    ...utf8(` -->${square}`),
  ]),
);
prepare("astral", svg(square), {
  fileName: "logo 😀 \ud800 ünï.svg",
  sourcePath: "",
});
prepare("unnamed", svg(square), { fileName: "" });
prepare("dotted", svg(square), { fileName: ".svg" });
prepare("long name", svg(square), { fileName: `${"n".repeat(100)}.svg` });
prepare("many notes", svg(`${"<text>x</text>".repeat(80)}${square}`));
prepare(
  "long selector",
  svg(
    `<style>${"g ".repeat(1500)}path{fill:none;stroke:#000}</style>${square}`,
  ),
);
prepare(
  "long element",
  svg(`<${"q".repeat(200)} transform="perspective(2)"/>${square}`),
);
// Refusals.
prepare("no svg", "plain text");
prepare("no depth", svg(square), { depthMm: 0 });
prepare("negative depth", svg(square), { depthMm: -1 });
prepare("no width", svg(square), { widthMm: 0 });
prepare("words only", svg("<text>only words</text>"));
prepare(
  "lines only",
  svg(
    `<style>${"g ".repeat(1500)}path{fill:none;stroke:#000}</style><g fill="none" stroke="#000">${square}</g>`,
  ),
);
prepare("empty", svg(""));
prepare("degenerate", svg('<polygon points="0,0 10,0 20,0"/>'));
prepare(
  "overflow",
  svg(
    '<path d="M-1e308 0 L0 0 L1e308 0 Z"/><rect width="10" height="10"/>',
    'width="100mm" height="100mm" viewBox="0 0 100 100"',
  ),
);
prepare(
  "float32",
  svg(
    '<rect width="1e39" height="1e39"/>',
    'width="100mm" height="100mm" viewBox="0 0 100 100"',
  ),
);
prepare(
  "too deep",
  `<svg>${"<g>".repeat(300)}${square}${"</g>".repeat(300)}</svg>`,
);

// Stages.
const transform = {
  translationMm: [2, -3, 4],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};
const add = (name, volume, mesh, drawing, extra = {}) =>
  stage(name, {
    add: {
      objectId: units(extra.objectId ?? objectId),
      volumeId: units(volume),
      assetId: units(mesh),
      drawingAssetId: units(drawing),
      transform: extra.transform ?? transform,
    },
  });
const edit = (name, volume, mesh, drawing) =>
  stage(name, {
    edit: {
      volumeId: units(volume),
      assetId: units(mesh),
      drawingAssetId: units(drawing),
    },
  });
await add(
  "logo",
  "import:host:svg-logo",
  "import:host:svg-logo-mesh",
  "import:host:svg-logo-drawing",
);
await add(
  "logo",
  "import:host:svg-logo",
  "import:host:svg-logo-mesh-2",
  "import:host:svg-logo-drawing-2",
);
await edit(
  "wide",
  "import:host:svg-logo",
  "import:host:svg-wide-mesh",
  "import:host:svg-wide-drawing",
);
await edit(
  "bom",
  "import:host:svg-logo",
  "import:host:svg-bom-mesh",
  "import:host:svg-wide-drawing",
);
await edit(
  "astral",
  plainVolume,
  "import:host:svg-astral-mesh",
  "import:host:svg-astral-drawing",
);
await edit(
  "astral",
  "import:host:svg-missing",
  "import:host:svg-astral-mesh",
  "import:host:svg-astral-drawing",
);
await add(
  "astral",
  "import:host:svg-astral",
  "import:host:svg-astral-mesh",
  "import:host:svg-astral-drawing",
);
await add(
  "unnamed",
  "import:host:svg-unnamed",
  " import:host:padded",
  "import:host:svg-unnamed-drawing",
);
await add(
  "unnamed",
  "import:host:svg-unnamed",
  "import:host:svg-unnamed-mesh",
  "import:host:padded ",
);
await add(
  "unnamed",
  "import:host:svg-unnamed",
  "import:host:svg-unnamed-mesh",
  "import:host:svg-unnamed-drawing",
);
await add(
  "dotted",
  "import:host:svg-dotted",
  "import:host:svg-dotted-mesh",
  "import:host:svg-dotted-drawing",
  { objectId: "import:object:missing" },
);
await add(
  "malformed",
  "import:host:svg-malformed",
  "import:host:svg-malformed-mesh",
  fixture.asset.descriptor.id,
);
await add(
  "no svg",
  "import:host:svg-none",
  "import:host:svg-none-mesh",
  "import:host:svg-none-drawing",
);
await history("undo");
await history("undo");
await history("redo");
await add(
  "long name",
  "import:host:svg-long",
  "import:host:svg-long-mesh",
  "import:host:svg-long-drawing",
  {
    transform: {
      translationMm: [0, 0, 0],
      rotation: [0, 0, 0.7071067811865476, 0.7071067811865476],
      scale: [2, 2, 1],
    },
  },
);
await edit(
  "logo",
  "import:host:svg-long",
  "import:host:svg-logo-mesh",
  "import:host:svg-logo-drawing",
);
await history("undo");
session.dispose();

const sources = [
  "tools/cross-platform/svg-part-vectors.mjs",
  "tools/cross-platform/svg-random-documents.mjs",
  "web/src/project/objects/svgPartExchange.ts",
  "web/src/project/objects/svgCommands.ts",
  "web/src/project/objects/svgShapes.ts",
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
      readings,
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
const path = new URL("testdata/cross-platform/svg-part-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(readFileSync(path, "utf8"), output, "SVG part reference drift");
const count = (predicate) => steps.filter(predicate).length;
const outcomes = Object.groupBy(
  steps.filter((s) => "outcome" in s),
  (s) => s.outcome,
);
const prepared = steps
  .filter((s) => s.reply?.startsWith('{"prepared"'))
  .map((s) => JSON.parse(s.reply).prepared);
const errors = Object.groupBy(
  readings.filter((r) => r.error),
  (r) => r.error[0],
);
console.log(
  `svg: ${readings.length} readings (${readings.filter((r) => r.contours).length} with contours, ${Object.entries(
    errors,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(
      ", ",
    )}, ${readings.reduce((n, r) => n + (r.unsupported?.length ?? 0), 0)} notes); ${count((s) => "prepare" in s)} cuts (${prepared.length} prepared, ${prepared.reduce((n, p) => n + p.triangleCount, 0)} triangles), stages ${Object.entries(
    outcomes,
  )
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}, ${count((s) => "history" in s)} history steps`,
);
