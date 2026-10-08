// Randomized differential replay: seeded command traces run through the
// TypeScript session (the authority) and the Rust session over WASM, side by
// side, and are compared after every step — the reply, the canonical state
// and its semantic hash, the asset fingerprint, selection, history, history
// revision, the registry facts the session decides and the renderer deltas
// a host following each session would apply. Each step is generated
// from the authority's current state, mostly valid and sometimes not, so
// refusals are compared too. The fixed seeds run in CI;
// ORCAXR_DIFFERENTIAL_SEEDS=<count> widens the search locally.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EditorSession } from "../../web/src/project/session.ts";
import { AsyncEditorSession } from "../../web/src/project/AsyncEditorSession.ts";
import {
  ProjectSessionEndpoint,
  wireSessionGuard,
} from "../../web/src/project/ProjectSessionEndpoint.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { canonicalUiFacts } from "../../web/src/actions/canonicalUiFacts.ts";
import {
  RenderFeed,
  RenderRefusal,
  renderPageWire,
  renderRequestFromWire,
} from "../../web/src/project/renderProjection.ts";
import {
  decodeProjectRenderRequest,
  encodeProjectCapabilityRequest,
  encodeProjectRenderPage,
  encodeProjectRenderRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));
const SEEDS = Number(process.env.ORCAXR_DIFFERENTIAL_SEEDS ?? 12);
const STEPS = Number(process.env.ORCAXR_DIFFERENTIAL_STEPS ?? 100);

const core = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      await readFile(new URL("core/dist/project-wasm/orcaxr_core.js", root)),
    ).toString("base64")
);
await core.default({
  module_or_path: await readFile(
    new URL("core/dist/project-wasm/orcaxr_core_bg.wasm", root),
  ),
});
const layout = await json("contracts/project-host.json");
const sessions = await json(
  "testdata/cross-platform/project-session-vectors.json",
);
const nonce = sessions.generation;
const distinct = [];
for (const trace of sessions.traces)
  if (
    !distinct.some((d) => d.stateJson === trace.stateJson) &&
    JSON.parse(trace.stateJson).id.length < 1024
  )
    distinct.push(trace);

const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const decode = new TextDecoder("utf-8", { fatal: true });
const normalize = (v) =>
  Array.isArray(v)
    ? v.map(normalize)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, normalize(v[k])]),
        )
      : v;
const same = (wire) => JSON.stringify(normalize(JSON.parse(wire)));

function random(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

// Native reads, as plain values.
function readUnits(length, read, chunk) {
  const out = [];
  for (let p = 0; p < length; p += chunk)
    out.push(...read(p, Math.min(chunk, length - p)));
  return out;
}
function nativeObserve(session) {
  const capture = session.snapshot();
  let state, revision, hash;
  try {
    const exported = capture.export_json(8 * 1024 * 1024);
    try {
      const out = new Uint8Array(exported.length());
      for (let p = 0; p < out.length; p += layout.maxChunkBytes)
        out.set(
          exported.read(p, Math.min(layout.maxChunkBytes, out.length - p)),
          p,
        );
      state = decode.decode(out);
    } finally {
      exported.free();
    }
    revision = capture.revision();
    hash = capture.hash();
  } finally {
    capture.free();
  }
  const selectionCapture = session.selection();
  let selection;
  try {
    const refs = Array.from({ length: selectionCapture.count() }, (_, i) => ({
      kind: layout.selectionKinds[selectionCapture.kind(i)],
      ...(selectionCapture.kind(i) === 0
        ? {}
        : {
            id: String.fromCharCode(
              ...readUnits(
                selectionCapture.id_length(i),
                (p, n) => selectionCapture.id(i, p, n),
                layout.maxTextChunkUnits,
              ),
            ),
          }),
    }));
    const primary = selectionCapture.primary_index();
    selection = { refs, primary: primary === -1 ? null : refs[primary] };
  } finally {
    selectionCapture.free();
  }
  const historyCapture = session.history();
  let history;
  try {
    const label = (undo) =>
      historyCapture.has_label(undo)
        ? String.fromCharCode(
            ...readUnits(
              historyCapture.label_length(undo),
              (p, n) => historyCapture.label_text(undo, p, n),
              layout.maxTextChunkUnits,
            ),
          )
        : null;
    const categories = historyCapture.dirty_categories();
    history = {
      undoCount: historyCapture.undo_count(),
      redoCount: historyCapture.redo_count(),
      undoLabel: label(true),
      redoLabel: label(false),
      dirtyCategories: categories === "" ? [] : categories.split(","),
    };
  } finally {
    historyCapture.free();
  }
  return {
    revision,
    hash,
    state,
    selection,
    history,
    historyRevision: session.history_revision(),
    assets: session.asset_fingerprint(),
  };
}
function referenceObserve(session, assets) {
  const snapshot = session.project.getSnapshot();
  const selection = session.selection.getSnapshot();
  const history = session.commands.getHistorySnapshot();
  return {
    revision: snapshot.revision,
    hash: snapshot.hash,
    state: canonicalStringify(snapshot.state),
    selection: {
      refs: [...selection.refs],
      primary: selection.primary ?? null,
    },
    history: {
      undoCount: history.undoCount,
      redoCount: history.redoCount,
      undoLabel: history.undoLabel ?? null,
      redoLabel: history.redoLabel ?? null,
      dirtyCategories: [...history.dirtyCategories],
    },
    historyRevision: session.commands.getHistoryRevision(),
    assets: assets.bundleFingerprint(),
  };
}

// One generated step from the authority's state.
function generate(rng, state, ids, counter, snapshot) {
  const plates = state.plates;
  const objects = plates.flatMap((plate) =>
    plate.objects.map((object) => ({ plate, object })),
  );
  const instances = objects.flatMap(({ object }) =>
    object.instances.map((instance) => ({ object, instance })),
  );
  const volumes = objects.flatMap(({ object }) =>
    object.volumes.map((volume) => ({ object, volume })),
  );
  const filaments = [...state.filaments.physical, ...state.filaments.mixed];
  const name = () =>
    rng.pick([
      "Part",
      "Bracket ✓",
      "",
      " padded ",
      "Ünïcødé 😀",
      "x".repeat(rng.chance(0.1) ? 300 : 3),
    ]);
  const id = (kind) => `import:differential:${kind}-${ids.n++}`;
  const existing = (list, missing) =>
    list.length && !rng.chance(0.08) ? rng.pick(list) : missing;
  const quaternion = () => {
    const v = [
      rng.next() - 0.5,
      rng.next() - 0.5,
      rng.next() - 0.5,
      rng.next() - 0.5,
    ];
    const n = Math.hypot(...v) || 1;
    return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
  };
  const choices = [
    () => ({ renameProject: { name: units(name()) } }),
    () => {
      const o = existing(objects, {
        object: { id: "import:missing:object" },
      }).object;
      return { renameObject: { objectId: units(o.id), name: units(name()) } };
    },
    () => {
      const v = existing(volumes, {
        volume: { id: "import:missing:volume" },
      }).volume;
      return { renameVolume: { volumeId: units(v.id), name: units(name()) } };
    },
    () => {
      const i = existing(instances, {
        instance: { id: "import:missing:instance" },
      }).instance;
      return {
        setInstancePrintable: {
          instanceId: units(i.id),
          printable: rng.chance(0.5),
        },
      };
    },
    () => {
      const i = existing(instances, {
        instance: { id: "import:missing:instance" },
      }).instance;
      return {
        setInstanceTransform: {
          instanceId: units(i.id),
          transform: {
            translationMm: [rng.int(200) - 50, rng.int(200) - 50, rng.int(20)],
            rotation: quaternion(),
            scale: rng.chance(0.05)
              ? [0, 1, 1]
              : [1 + rng.int(3) / 2, 1, rng.chance(0.2) ? -1 : 1],
          },
          gestureId: units(rng.chance(0.5) ? "gesture" : `gesture-${counter}`),
        },
      };
    },
    () => ({
      addPlate: {
        plateId: units(id("plate")),
        name: units(rng.pick(["Plate", "Second", "😀"])),
        order: Math.max(-1, ...plates.map((p) => p.order)) + 1 + rng.int(3),
        activate: rng.chance(0.5),
      },
    }),
    () => ({
      activatePlate: {
        plateId: units(existing(plates, { id: "import:missing:plate" }).id),
      },
    }),
    () => ({
      deletePlate: {
        plateId: units(existing(plates, { id: "import:missing:plate" }).id),
      },
    }),
    () => ({
      renamePlate: {
        plateId: units(existing(plates, { id: "import:missing:plate" }).id),
        name: units(name()),
      },
    }),
    () => ({
      setPlatePrintable: {
        plateId: units(existing(plates, { id: "import:missing:plate" }).id),
        printable: rng.chance(0.5),
      },
    }),
    () => ({
      reorderPlates: {
        plateIds: [...plates]
          .sort(() => rng.next() - 0.5)
          .map((p) => units(p.id)),
      },
    }),
    () => {
      const i = existing(instances, {
        instance: { id: "import:missing:instance" },
      }).instance;
      return { deleteInstance: { instanceId: units(i.id) } };
    },
    () => {
      const o = existing(objects, {
        object: { id: "import:missing:object" },
      }).object;
      return {
        moveObjectToPlate: {
          objectId: units(o.id),
          destinationPlateId: units(
            existing(plates, { id: "import:missing:plate" }).id,
          ),
        },
      };
    },
    () => {
      const o = existing(objects, {
        object: { id: "import:missing:object" },
      }).object;
      const top = Math.max(0, ...(o.layerRanges ?? []).map((r) => r.maxZMm));
      return {
        addLayerRange: {
          objectId: units(o.id),
          layerRangeId: units(id("range")),
          minZMm: rng.chance(0.2) ? top - 1 : top,
          maxZMm: top + 1 + rng.int(4),
        },
      };
    },
    () => {
      const ranges = objects.flatMap(({ object }) =>
        (object.layerRanges ?? []).map((range) => ({ object, range })),
      );
      const pick = existing(ranges, {
        object: { id: "import:missing:object" },
        range: { id: "import:missing:range" },
      });
      return {
        deleteLayerRange: {
          objectId: units(pick.object.id),
          layerRangeId: units(pick.range.id),
        },
      };
    },
    () => ({
      addLayerEvent: {
        customGcodeId: units(id("event")),
        plateId: units(state.activePlateId),
        eventType: rng.pick(["pause", "colorChange", "custom"]),
        topZMm: rng.int(30) + 0.5,
        toolIndex: { absent: {} },
        filamentId: { absent: {} },
        color: { absent: {} },
        message: rng.chance(0.5)
          ? { value: units("Insert ✓") }
          : { absent: {} },
        code: { value: units("M117 differential") },
      },
    }),
    () => {
      const o = existing(objects, {
        object: { id: "import:missing:object" },
      }).object;
      const filament =
        filaments.length && rng.chance(0.7)
          ? { value: units(rng.pick(filaments).id) }
          : { absent: {} };
      return {
        setObjectFilament: { objectId: units(o.id), filamentId: filament },
      };
    },
    () => {
      const v = existing(volumes, {
        volume: { id: "import:missing:volume" },
      }).volume;
      return {
        convertVolumeRole: {
          volumeId: units(v.id),
          role: rng.pick([
            "model",
            "negativeVolume",
            "parameterModifier",
            "supportBlocker",
            "supportEnforcer",
          ]),
        },
      };
    },
    () => {
      const o = existing(objects, {
        object: { id: "import:missing:object" },
      }).object;
      return {
        addBrimEar: {
          objectId: units(o.id),
          ear: {
            positionMm: [rng.int(10), rng.int(10), 0],
            headFrontRadiusMm: rng.chance(0.1) ? -1 : 3,
          },
        },
      };
    },
    () => {
      const i = existing(instances, {
        instance: { id: "import:missing:instance" },
      }).instance;
      return {
        renameInstance: { instanceId: units(i.id), name: units(name()) },
      };
    },
    () => {
      const o = existing(objects, {
        object: {
          id: "import:missing:object",
          volumes: [],
          instances: [],
          layerRanges: [],
        },
      }).object;
      return {
        duplicateObject: {
          sourceObjectId: units(o.id),
          ids: {
            objectId: units(id("object")),
            volumeIds: o.volumes.map(() => units(id("volume"))),
            instanceIds: o.instances.map(() => units(id("instance"))),
            layerRangeIds: (o.layerRanges ?? []).map(() => units(id("range"))),
          },
          destinationPlateId: rng.chance(0.5)
            ? { value: units(rng.pick(plates).id) }
            : { absent: {} },
          name: rng.chance(0.5) ? { value: units(name()) } : { absent: {} },
        },
      };
    },
    () => {
      const pick = existing(instances, {
        object: { volumes: [], layerRanges: [] },
        instance: { id: "import:missing:instance" },
      });
      return {
        convertInstanceToObject: {
          instanceId: units(pick.instance.id),
          ids: {
            objectId: units(id("object")),
            volumeIds: pick.object.volumes.map(() => units(id("volume"))),
            instanceId: units(id("instance")),
            layerRangeIds: (pick.object.layerRanges ?? []).map(() =>
              units(id("range")),
            ),
          },
          name: { absent: {} },
        },
      };
    },
    () => {
      const ranges = objects.flatMap(({ object }) =>
        (object.layerRanges ?? []).map((range) => ({ object, range })),
      );
      const pick = existing(ranges, {
        object: { id: "import:missing:object" },
        range: { id: "import:missing:range", minZMm: 0, maxZMm: 2 },
      });
      return {
        splitLayerRange: {
          objectId: units(pick.object.id),
          layerRangeId: units(pick.range.id),
          splitZMm: rng.chance(0.8)
            ? (pick.range.minZMm + pick.range.maxZMm) / 2
            : pick.range.maxZMm + 1,
          upperRangeId: units(id("range")),
        },
      };
    },
    () => {
      const events = state.customGcode.filter((entry) => entry.layerEvent);
      const event = existing(events, { id: "import:missing:event" });
      const patch = () => rng.pick([{ keep: {} }, { clear: {} }]);
      return rng.chance(0.3)
        ? { deleteLayerEvent: { customGcodeId: units(event.id) } }
        : {
            editLayerEvent: {
              customGcodeId: units(event.id),
              eventType: rng.chance(0.5)
                ? { value: rng.pick(["pause", "custom"]) }
                : { absent: {} },
              topZMm: rng.chance(0.5)
                ? { value: rng.int(40) + 0.25 }
                : { absent: {} },
              toolIndex: patch(),
              filamentId: patch(),
              color: rng.chance(0.3) ? { value: units("#00FF00") } : patch(),
              message: rng.chance(0.3) ? { value: units("Swap") } : patch(),
              code: { absent: {} },
            },
          };
    },
    () =>
      filaments.length
        ? {
            remapFilaments: {
              sourceIds: [units(rng.pick(filaments).id)],
              destinationId: units(rng.pick(filaments).id),
            },
          }
        : { renameProject: { name: units("No filaments") } },
    () => {
      const config = {
        layer_height: rng.pick([0.12, 0.2, 0.28]),
        wall_loops: rng.int(5),
      };
      return {
        setProjectSettingsOverrides: {
          guard: rng.chance(0.6)
            ? {
                sourceRevision: snapshot.revision,
                sourceHash: units(snapshot.hash),
              }
            : { sourceRevision: 0, sourceHash: units("stale") },
          inheritedConfigJson: units(
            JSON.stringify(state.settingsBaseConfig ?? state.config),
          ),
          overridesJson: units(JSON.stringify(config)),
        },
      };
    },
    () => {
      const o = existing(objects, {
        object: { id: "import:missing:object" },
      }).object;
      return rng.chance(0.5)
        ? { removeBrimEar: { objectId: units(o.id), index: rng.int(3) } }
        : { clearBrimEars: { objectId: units(o.id) } };
    },
  ];
  return rng.pick(choices)();
}

let comparedSteps = 0,
  refusedSteps = 0,
  renderPages = 0,
  renderChanges = 0;
const text = (u) => String.fromCharCode(...u);
const cursorWire = (cursor) =>
  cursor
    ? {
        value: {
          revision: cursor.revision,
          semanticHash: units(cursor.semanticHash),
        },
      }
    : { absent: {} };
// One render request through both sessions, compared as text. Refusals must
// agree on their code.
function renderBoth(feed, native, request, where) {
  const wireRequest = encodeProjectRenderRequest({
    base: cursorWire(request.base),
    target: cursorWire(request.target),
    start: request.start,
    count: request.count,
  });
  let expected, refusal;
  try {
    expected = encodeProjectRenderPage(
      renderPageWire(
        feed.page(
          renderRequestFromWire(decodeProjectRenderRequest(wireRequest), text),
        ),
        units,
      ),
    );
  } catch (error) {
    if (!(error instanceof RenderRefusal)) throw error;
    refusal = error.code.replace("-", "_");
  }
  let actual, nativeRefusal;
  try {
    actual = native.render(wireRequest);
  } catch (error) {
    nativeRefusal = String(error?.message ?? error);
  }
  if (refusal || nativeRefusal) {
    if (!refusal || !nativeRefusal?.includes(refusal))
      throw Error(`${where}: render refusal ${refusal} vs ${nativeRefusal}`);
    return undefined;
  }
  if (actual !== expected)
    throw Error(
      `${where}: render page differs\nTS   ${expected.slice(0, 600)}\nRust ${actual.slice(0, 600)}`,
    );
  renderPages++;
  return JSON.parse(expected);
}
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const fixture of distinct) {
    const rng = random(seed * 7919 + distinct.indexOf(fixture));
    const label = `seed ${seed} ${fixture.name}`;
    // The authority.
    const assets = new InMemoryAssetRepository();
    assets.put(
      JSON.parse(fixture.asset.descriptorJson),
      Uint8Array.from(fixture.asset.bytes),
    );
    const reference = new EditorSession({
      initialState: JSON.parse(fixture.stateJson),
      assets,
      history: fixture.options,
      serializer: {
        async serialize() {
          throw Error("unused");
        },
        async deserialize() {
          throw Error("unused");
        },
      },
    });
    const facade = new AsyncEditorSession(reference);
    const endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
    // The port.
    const source = new TextEncoder().encode(fixture.stateJson);
    const options = {
      documentBytes: source.length,
      documentNodes: 1_000_000,
      documentTextUnits: 2_000_000,
      numberBytes: 1024,
      depth: 128,
      assets: 100,
      assetBytes: 16 * 1024 * 1024,
      totalAssetBytes: 32 * 1024 * 1024,
      historyEntries: fixture.options.maxEntries ?? 100,
      historyBytes: fixture.options.maxEstimatedBytes ?? 32 * 1024 * 1024,
    };
    const upload = new core.ProjectUpload(
      layout.version,
      source.length,
      Float64Array.from(layout.options.map((k) => options[k])),
    );
    for (let p = 0; p < source.length; p += layout.maxChunkBytes)
      upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
    upload.seal_document();
    const bytes = Uint8Array.from(fixture.asset.bytes);
    upload.begin_asset(0);
    upload.append_asset(0, bytes);
    upload.finish_asset();
    const native = upload.open(Float64Array.from(nonce));
    // A host following each session's renderer deltas from what it shows,
    // paging with its own seeded sizes, sometimes from a base neither
    // session served and sometimes asking for an oversized page.
    const feed = new RenderFeed(() => reference.project.getSnapshot());
    const renderRng = random(seed * 104729 + distinct.indexOf(fixture));
    let shown;
    const renderSync = (where) => {
      if (renderRng.chance(0.02))
        renderBoth(feed, native, { base: shown, start: 0, count: 65 }, where);
      const base = renderRng.chance(0.03)
        ? { revision: 9_007_199_254_740_991, semanticHash: "fnv1a64:0" }
        : shown;
      const count = 1 + renderRng.int(64);
      const first = renderBoth(feed, native, { base, start: 0, count }, where);
      const target = {
        revision: first.target.revision,
        semanticHash: text(first.target.semanticHash),
      };
      renderChanges += first.changes.length;
      for (let start = count; start < first.total; start += count)
        renderChanges += renderBoth(
          feed,
          native,
          { base, target, start, count },
          where,
        ).changes.length;
      shown = target;
    };
    let sequence = 0;
    const ids = { n: 0 };
    const exchange = async (operation, step) => {
      // Raw JSON, not the generated encoder: a request the contract refuses
      // must be refused identically by both sessions' own decoders.
      const request = JSON.stringify({
        protocolVersion: 1,
        generation: nonce,
        requestId: ++sequence,
        operation,
      });
      const expected = await endpoint.handle(request);
      const reply = native.submit(request) ?? native.run_next();
      const actual = reply.wire();
      if (same(actual) !== same(expected))
        throw Error(
          `${label} step ${step}: reply differs\n${JSON.stringify(operation).slice(0, 400)}\nTS   ${expected}\nRust ${actual}`,
        );
      if (JSON.parse(expected).result.error) refusedSteps++;
    };
    try {
      await exchange(
        {
          hello: {
            minProtocolVersion: 1,
            maxProtocolVersion: 1,
            projectSchemaVersion: 1,
            intentVersion: 1,
          },
        },
        0,
      );
      for (let step = 1; step <= STEPS; step++) {
        const snapshot = reference.project.getSnapshot();
        const state = snapshot.state;
        const guard = wireSessionGuard(facade.captureGuard());
        const roll = rng.next();
        let operation;
        if (roll < 0.1) operation = { undo: guard };
        else if (roll < 0.16) operation = { redo: guard };
        else if (roll < 0.2) {
          // A stale guard is refused identically.
          operation = {
            execute: {
              guard: { ...guard, historyRevision: guard.historyRevision + 1 },
              intent: {
                version: 1,
                command: generate(rng, state, ids, step, snapshot),
              },
            },
          };
        } else if (roll < 0.27) {
          operation = {
            transaction: {
              guard,
              batch: {
                version: 1,
                label: units("Differential batch"),
                commands: [
                  generate(rng, state, ids, step, snapshot),
                  generate(rng, state, ids, step, snapshot),
                ],
              },
            },
          };
        } else if (roll < 0.33) {
          // A host selection, applied to both.
          const instances = state.plates.flatMap((p) =>
            p.objects.flatMap((o) => o.instances),
          );
          const refs = instances
            .slice(0, 1 + rng.int(2))
            .map((i) => ({ kind: "instance", id: i.id }));
          const choice =
            refs.length && rng.chance(0.8) ? refs : [{ kind: "project" }];
          reference.selection.set(choice, choice[0]);
          const nativeGuard = native.capture_guard(),
            input = new core.ProjectSelectionInput();
          try {
            for (const ref of choice)
              input.add(
                layout.selectionKinds.indexOf(ref.kind),
                Uint16Array.from(units(ref.id ?? "")),
              );
            native.select(nativeGuard, input, 0).free();
          } finally {
            nativeGuard.free();
          }
        } else
          operation = {
            execute: {
              guard,
              intent: {
                version: 1,
                command: generate(rng, state, ids, step, snapshot),
              },
            },
          };
        if (operation) await exchange(operation, step);
        renderSync(`${label} step ${step}`);
        const want = referenceObserve(reference, assets);
        const got = nativeObserve(native);
        for (const key of Object.keys(want))
          if (
            JSON.stringify(normalize(want[key])) !==
            JSON.stringify(normalize(got[key]))
          )
            throw Error(
              `${label} step ${step}: ${key} differs after ${JSON.stringify(operation ?? "selection").slice(0, 300)}`,
            );
        // The registry facts the session decides.
        const page = JSON.parse(
          native.capabilities(
            encodeProjectCapabilityRequest({
              surface: "domMenu",
              host: {
                initialization: { absent: {} },
                mode: "prepare",
                simplifyPreviewing: false,
                calibrationSessionOpen: false,
                projectionHealthy: true,
                hasClipboard: false,
                isSlicing: false,
                gcodeReady: false,
                preflightBlocked: false,
                printerJobState: "disconnected",
              },
              query: { page: { start: 0, count: 1 } },
            }),
          ),
        );
        assert.deepEqual(
          page.facts,
          {
            ...canonicalUiFacts(
              reference.project.getSnapshot().state,
              reference.selection.getSnapshot(),
              reference.commands.getHistorySnapshot(),
            ),
          },
          `${label} step ${step}: facts differ`,
        );
        comparedSteps++;
      }
    } finally {
      native.free();
      reference.dispose();
    }
  }
}
console.log(
  JSON.stringify({
    seeds: SEEDS,
    states: distinct.length,
    steps: comparedSteps,
    refusals: refusedSteps,
    renderPages,
    renderChanges,
  }),
);
