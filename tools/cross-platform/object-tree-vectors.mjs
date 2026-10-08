// Objects tree references from the production browser (`objectTreeExchange.ts`
// over `projectObjectsTree`, `buildObjectTreeView`, `objectTreeSelectionRequest`
// and `resolveObjectTreeSelection`): visible-row pages under default, full and
// collapsed expansion, filters (ASCII, folded non-ASCII, whitespace-only and
// unmatched), selections that include project and filament references, and
// requested focus; every selection mode with visible, hidden and absent
// anchors; and an oversized page. States derive from the browser fixture
// (whose mesh the bindings upload): non-ASCII, whitespace-laden and
// lone-surrogate names and IDs, refined and sparse paint, mixed and inherited
// filaments, fractional heights, out-of-order plates and a 40-object plate
// for paging. The model-vector states are replayed by Rust alone. Every text
// the browser folded is recorded with its folding, which a native host
// supplies itself.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import {
  seededRandom,
  UuidIdSource,
} from "../../web/src/project/domain/ids.ts";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import { ProjectStore } from "../../web/src/project/store.ts";
import { answerObjectTreeRequest } from "../../web/src/project/objects/objectTreeExchange.ts";
import {
  decodeProjectObjectTreeRequest,
  encodeProjectObjectTreeReply,
  encodeProjectObjectTreeRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

// Every text the browser folds passes through `normalize('NFKD')`; record
// each non-ASCII one with the folding a host performs for it.
const foldings = new Map();
const normalize = String.prototype.normalize;
String.prototype.normalize = function (form) {
  const text = String(this);
  if (form === "NFKD" && /[^\x00-\x7f]/.test(text))
    foldings.set(text, normalize.call(text, "NFKD").toLocaleLowerCase("en-US"));
  return normalize.call(this, form);
};

// --- States -----------------------------------------------------------------------
const fixture = createProjectFixture();
const ids = new UuidIdSource(seededRandom(0x7ee5));
const leaf = (value) => ({
  kind: "leaf",
  state:
    value === undefined ? { kind: "unpainted" } : { kind: "assigned", value },
});

const scene = clone(fixture.state);
{
  const [physical0, physical1] = scene.filaments.physical;
  const mixed = scene.filaments.mixed[0];
  const plate = scene.plates[0];
  plate.order = 5;
  plate.name = "ΟΔΥΣΣΕΥΣ plate";
  const object = plate.objects[0];
  object.name = "İstanbul Café ＢＯＤＹ";
  object.filamentId = mixed.id;
  object.config = { 10: 1, 2: 2, température: 210, wall_loops: 3 };
  const body = object.volumes[0];
  body.name = "  wide　 name﻿ ";
  body.annotations.refinement = {
    support: {
      version: 2,
      triangleCount: 1,
      splits: [
        {
          triangle: 0,
          node: {
            kind: "split",
            splitSides: 1,
            specialSide: 0,
            children: [leaf("enforce"), leaf()],
          },
        },
      ],
    },
  };
  body.annotations.support = [];
  object.volumes.push(
    {
      ...clone(body),
      id: ids.next("volume"),
      name: "ﬁle\tpart\nline",
      role: "model",
      filamentId: physical1.id,
      config: {},
      annotations: {
        ...clone(fixture.state.plates[0].objects[0].volumes[0].annotations),
        color: [{ triangles: [0], value: physical0.id }],
      },
    },
    {
      ...clone(body),
      id: ids.next("volume"),
      name: "部品 🧩",
      role: "parameter-modifier",
      config: { infill_density: 30 },
      annotations: {
        ...clone(fixture.state.plates[0].objects[0].volumes[0].annotations),
        color: [],
      },
    },
    {
      ...clone(body),
      id: ids.next("volume"),
      name: "",
      role: "negative-volume",
      config: {},
      annotations: {
        ...clone(fixture.state.plates[0].objects[0].volumes[0].annotations),
        color: [],
      },
    },
  );
  object.instances[0].name = "   ";
  object.instances.push(
    {
      ...clone(object.instances[0]),
      id: ids.next("instance"),
      name: " Rear copy ",
      printable: false,
    },
    { ...clone(object.instances[0]), id: ids.next("instance"), name: "" },
    { ...clone(object.instances[0]), id: ids.next("instance") },
  );
  delete object.instances[3].name;
  object.layerRanges = [
    {
      id: ids.next("layer-range"),
      minZMm: 7.300000000000001,
      maxZMm: 123456.789,
      config: {},
    },
    {
      id: ids.next("layer-range"),
      minZMm: 0.0625,
      maxZMm: 1.9999,
      config: { layer_height: 0.1 },
      filamentId: physical1.id,
    },
    { id: ids.next("layer-range"), minZMm: 1e-7, maxZMm: 0.0625, config: {} },
  ];
  const second = {
    ...clone(plate),
    id: ids.next("plate"),
    name: "",
    order: 2,
    printable: false,
    config: {},
    objects: [
      {
        ...clone(object),
        id: ids.next("object"),
        name: "Second été",
        filamentId: undefined,
        config: {},
        volumes: [
          {
            ...clone(fixture.state.plates[0].objects[0].volumes[0]),
            id: ids.next("volume"),
            filamentId: undefined,
          },
        ],
        instances: [
          {
            ...clone(object.instances[0]),
            id: ids.next("instance"),
            printable: true,
          },
        ],
        layerRanges: [],
      },
    ],
  };
  delete second.objects[0].filamentId;
  delete second.objects[0].volumes[0].filamentId;
  const third = {
    ...clone(second),
    id: ids.next("plate"),
    name: "Third",
    order: 0,
    objects: [],
  };
  scene.plates.push(second, third);
}

// Stable imported IDs may carry lone surrogates, and names may too.
const surrogates = clone(fixture.state);
{
  const object = surrogates.plates[0].objects[0];
  object.id = "import:test:\ud800";
  object.name = "Lone \udc00 name";
  object.volumes[0].id = "import:test:􏿿";
  object.instances[0].id = "import:test:x\ud800y";
  object.instances[0].name = "\ud800";
  surrogates.plates[0].id = "import:test:\udfff";
  surrogates.activePlateId = surrogates.plates[0].id;
}

// One plate of 40 objects (about 200 rows by default), for paging.
const large = clone(fixture.state);
{
  const template = large.plates[0].objects[0];
  large.plates[0].objects = Array.from({ length: 40 }, (_, n) => ({
    ...clone(template),
    id: ids.next("object"),
    name: `Part ${String(n).padStart(3, "0")}`,
    volumes: [{ ...clone(template.volumes[0]), id: ids.next("volume") }],
    instances: [{ ...clone(template.instances[0]), id: ids.next("instance") }],
    layerRanges:
      n % 10 === 0
        ? [{ ...clone(template.layerRanges[0]), id: ids.next("layer-range") }]
        : [],
  }));
}

const empty = createProjectFixture({ withObject: false }).state;
empty.plates[0].name = "";

const browserStates = Object.entries({
  fixture: fixture.state,
  scene,
  surrogates,
  large,
  empty,
}).map(([name, state]) => {
  const snapshot = new ProjectStore(state).getSnapshot();
  return {
    name,
    state: snapshot.state,
    revision: snapshot.revision,
    hash: snapshot.hash,
  };
});
// The model vectors' trees, less the distribution variants, whose trees are
// the complete schema's.
const models = JSON.parse(
  read("testdata/cross-platform/project-model-vectors.json"),
);
const modelStates = models.cases
  .filter((c) => !c.name.startsWith("distribution-"))
  .map((c) => ({ name: `model/${c.name}`, state: JSON.parse(c.stateJson) }));

// --- Requests -------------------------------------------------------------------------
const absent = { absent: {} };
const text = (value) =>
  value === undefined ? absent : { value: units(value) };
const entity = (kind, id) => ({
  [kind === "layer-range" ? "layerRange" : kind]: units(id),
});
function request({
  expansion = { default: {} },
  filter = "",
  selection = [],
  primary,
  focused,
  operation,
}) {
  return decodeProjectObjectTreeRequest(
    encodeProjectObjectTreeRequest({
      expansion,
      filterQuery: units(filter),
      selection,
      primary: primary ? { value: primary } : absent,
      focusedKey: text(focused),
      operation,
    }),
  );
}
const page = (start, count) => ({ page: { start, count } });

const cases = [];
function record(stateIndex, state, options) {
  const wire = request(options);
  const requestJson = encodeProjectObjectTreeRequest(wire);
  let expected;
  try {
    expected = {
      replyJson: encodeProjectObjectTreeReply(
        answerObjectTreeRequest(state, wire),
      ),
    };
  } catch (error) {
    assert.equal(error.code, "invalid_request", String(error));
    expected = { refusal: error.code };
  }
  cases.push({ state: stateIndex, requestJson, ...expected });
  return expected.replyJson ? JSON.parse(expected.replyJson) : undefined;
}
/** Every page of one view, then a page past its end and an empty page. */
function pages(stateIndex, state, view) {
  let total = Infinity;
  const rows = [];
  for (let start = 0; start < total; start += 64) {
    const reply = record(stateIndex, state, {
      ...view,
      operation: page(start, 64),
    });
    total = reply.page.totalRows;
    rows.push(...reply.page.rows);
  }
  record(stateIndex, state, { ...view, operation: page(total + 5, 3) });
  record(stateIndex, state, { ...view, operation: page(1, 0) });
  return rows;
}

const states = [...browserStates, ...modelStates];
const keyText = (row) => String.fromCharCode(...row.key);
for (const [index, { name, state }] of states.entries()) {
  const big = name === "large";
  const projectRows = pages(index, state, {});
  if (!big) pages(index, state, { expansion: { keys: [] } });
  // Every row with children open, found without recording the walks.
  let everything = projectRows;
  for (let round = 0; round < 4; round += 1) {
    const expandable = everything
      .filter((row) => row.expansion !== "leaf")
      .map((row) => row.key);
    const view = { expansion: { keys: expandable } };
    const total = answerObjectTreeRequest(
      state,
      request({ ...view, operation: page(0, 0) }),
    ).page.totalRows;
    everything = [];
    for (let start = 0; start < total; start += 64)
      everything.push(
        ...answerObjectTreeRequest(
          state,
          request({ ...view, operation: page(start, 64) }),
        ).page.rows,
      );
  }
  // The large plate pages only its default view; its full walk is ~400 rows.
  if (!big)
    pages(index, state, {
      expansion: {
        keys: everything
          .filter((row) => row.expansion !== "leaf")
          .map((row) => row.key),
      },
    });
  const objectRows = everything.filter((row) => row.kind === "object");
  const words = (row) =>
    String.fromCharCode(...row.label)
      .split(/\s+/)
      .filter(Boolean);
  const filters = big
    ? ["part 007", "instance", "zzzz-no-match"]
    : [
        "instance",
        "SETTINGS overrides",
        "  plate\u3000 ",
        "\u0301",
        "   ",
        "zzzz-no-match",
        "range layer",
        "wall_loops",
        ...objectRows.slice(0, 2).flatMap(words).slice(0, 3),
        "\u0130STANBUL",
        "cafe body",
        "\u03bf\u03b4\u03c5\u03c3\u03c3\u03b5\u03c5\u03c2",
        "\ufb01le",
        "\ud800",
      ];
  for (const filter of [...new Set(filters)]) pages(index, state, { filter });
  if (!big)
    pages(index, state, { filter: "instance", expansion: { keys: [] } });
  const withEntity = everything.filter((row) => "value" in row.entity);
  const pick = (n) =>
    withEntity[n % Math.max(1, withEntity.length)]?.entity.value;
  const selections = [
    { selection: [] },
    {
      selection: [
        pick(1),
        { project: {} },
        pick(3),
        { filament: units(state.filaments.physical[0]?.id ?? "x") },
      ].filter(Boolean),
      primary: pick(3),
    },
    {
      selection: [pick(2)].filter(Boolean),
      primary: { filament: units("import:test:filament") },
    },
    { selection: [pick(1), pick(1)].filter(Boolean), primary: pick(1) },
  ];
  const keys = everything.map(keyText);
  for (const selection of selections) {
    for (const focused of [
      undefined,
      keys[2],
      keys.at(-1),
      "settings:nowhere",
      "",
    ])
      record(index, state, { ...selection, focused, operation: page(0, 16) });
    record(index, state, {
      ...selection,
      filter: "instance",
      operation: page(0, 16),
    });
  }
  // Selection: every mode on a spread of rows, unfiltered and filtered.
  const shown = projectRows.map(keyText);
  const targets = [
    ...new Set([
      ...shown.slice(0, 4),
      ...keys.filter((_, i) => i % 9 === 4).slice(0, 4),
      "object:not-a-row",
    ]),
  ];
  const anchors = [undefined, shown[1], keys.at(-2), "", "plate:hidden"];
  for (const view of big ? [{}] : [{}, { filter: "instance" }]) {
    // A row that selects nothing (hidden, unknown or entity-less) is asked once.
    const ignored = new Set();
    for (const [s, selection] of selections.entries()) {
      if ((view.filter || big) && s % 2 === 1) continue;
      for (const key of targets) {
        for (const mode of ["replace", "toggle", "range"]) {
          for (const anchor of mode === "range"
            ? anchors
            : [anchors[s % anchors.length]]) {
            if (ignored.has(key)) continue;
            const reply = record(index, state, {
              ...view,
              ...selection,
              operation: {
                select: {
                  key: units(key ?? ""),
                  mode,
                  anchorKey: text(anchor),
                },
              },
            });
            if ("ignored" in reply) ignored.add(key);
          }
        }
      }
    }
  }
  // A page larger than the contract allows.
  record(index, state, { operation: page(0, 65) });
}

String.prototype.normalize = normalize;
const sources = [
  "tools/cross-platform/object-tree-vectors.mjs",
  "web/src/project/objects/objectTreeExchange.ts",
  "web/src/project/objects/projection.ts",
  "web/src/project/objects/view.ts",
  "web/src/project/objects/selectionRequest.ts",
  "web/src/project/__tests__/fixtures.ts",
  "testdata/cross-platform/project-model-vectors.json",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    // Texts and foldings as UTF-16 units: several hold lone surrogates.
    foldings: [...foldings]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([from, to]) => [units(from), units(to)]),
    states: states.map(({ name, state, revision, hash }) => ({
      name,
      stateJson: json(state),
      ...(revision === undefined ? {} : { revision, hash }),
    })),
    assets: [
      {
        descriptorJson: json(fixture.asset.descriptor),
        bytes: Array.from(fixture.asset.bytes),
      },
    ],
    cases,
  }) + "\n";
const path = new URL("testdata/cross-platform/object-tree-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Objects tree reference drift",
  );
const tally = (filter) => cases.filter(filter).length;
console.log(
  `Objects tree: ${cases.length} requests over ${states.length} states (${tally((c) => c.replyJson?.startsWith('{"page"'))} pages, ${tally((c) => c.replyJson?.startsWith('{"selected"'))} selections, ${tally((c) => c.replyJson?.startsWith('{"ignored"'))} ignored, ${tally((c) => c.refusal)} refused); ${foldings.size} foldings`,
);
