// Renderer projection references from the production browser: a host that
// follows a real TypeScript session through its render feed — a full sync
// from empty, deltas after acknowledged edits (moves, plates, colours —
// an object's physical and mixed filaments, a part's own filament over its
// object's, and a height range's filament, which colours nothing drawn —
// duplicates, deletions), paging across a newer edit, an unknown base, a
// stale target and an oversized page — in the shared contract's encoding.
// Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { EditorSession } from "../../web/src/project/session.ts";
import { AsyncEditorSession } from "../../web/src/project/AsyncEditorSession.ts";
import {
  ProjectSessionEndpoint,
  wireSessionGuard,
} from "../../web/src/project/ProjectSessionEndpoint.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import {
  RenderFeed,
  RenderRefusal,
  projectRender,
  renderPageWire,
  renderRequestFromWire,
} from "../../web/src/project/renderProjection.ts";
import {
  decodeProjectRenderRequest,
  encodeProjectRenderPage,
  encodeProjectRenderRequest,
  encodeProjectSessionRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
process.env.TZ = "UTC";
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const text = (u) => String.fromCharCode(...u);
const sessions = JSON.parse(
  read("testdata/cross-platform/project-session-vectors.json"),
);
const nonce = sessions.generation;
const REFUSALS = { "invalid-request": "invalid_request", stale: "stale" };

// Every distinct trace state whose IDs fit an intent, opened as a session.
const distinct = [];
for (const trace of sessions.traces)
  if (
    !distinct.some((d) => d.stateJson === trace.stateJson) &&
    JSON.parse(trace.stateJson).id.length < 1024
  )
    distinct.push(trace);

let rotation = 0;
const states = [];
for (const fixture of distinct) {
  const assets = new InMemoryAssetRepository();
  assets.put(
    JSON.parse(fixture.asset.descriptorJson),
    Uint8Array.from(fixture.asset.bytes),
  );
  const session = new EditorSession({
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
  const facade = new AsyncEditorSession(session);
  const endpoint = new ProjectSessionEndpoint(facade, nonce, 1);
  const feed = new RenderFeed(() => session.project.getSnapshot());
  const script = [];
  const cursorWire = (cursor) =>
    cursor
      ? {
          value: {
            revision: cursor.revision,
            semanticHash: units(cursor.semanticHash),
          },
        }
      : { absent: {} };
  const render = ({ base, target, start, count }) => {
    const requestJson = encodeProjectRenderRequest({
      base: cursorWire(base),
      target: cursorWire(target),
      start,
      count,
    });
    try {
      const page = feed.page(
        renderRequestFromWire(decodeProjectRenderRequest(requestJson), text),
      );
      script.push({
        render: requestJson,
        page: encodeProjectRenderPage(renderPageWire(page, units)),
      });
      return page;
    } catch (error) {
      if (!(error instanceof RenderRefusal)) throw error;
      script.push({ render: requestJson, refusal: REFUSALS[error.code] });
      return undefined;
    }
  };
  // The host pages the whole delta from what it shows, then shows its target.
  let shown;
  const sync = () => {
    const count = [3, 7, 64][rotation++ % 3];
    const first = render({ base: shown, start: 0, count });
    for (let start = count; start < first.total; start += count)
      render({ base: shown, target: first.target, start, count });
    shown = first.target;
    return first;
  };
  let sequence = 0;
  const wire = (operation) =>
    encodeProjectSessionRequest({
      protocolVersion: 1,
      generation: nonce,
      requestId: ++sequence,
      operation,
    });
  const exchange = async (operation) => {
    const request = wire(operation);
    const reply = await endpoint.handle(request);
    script.push({ request, reply });
    return JSON.parse(reply);
  };
  const execute = (command) =>
    exchange({
      execute: {
        guard: wireSessionGuard(facade.captureGuard()),
        intent: { version: 1, command },
      },
    });
  const state = () => session.project.getSnapshot().state;
  const fits = (id) => id.length < 1024;
  let fresh = 0;
  const newId = () => units(`import:render:${++fresh}`);

  await exchange({
    hello: {
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      projectSchemaVersion: 1,
      intentVersion: 1,
    },
  });
  sync();
  // Nothing changed: an empty delta from the target the host shows.
  sync();

  const objects = () =>
    state()
      .plates.flatMap((p) => p.objects)
      .filter((o) => fits(o.id));
  const instance = objects()
    .flatMap((o) => o.instances)
    .find((i) => fits(i.id));
  if (instance) {
    const t = instance.transform;
    await execute({
      setInstanceTransform: {
        instanceId: units(instance.id),
        transform: {
          translationMm: [
            t.translationMm[0] + 5,
            t.translationMm[1],
            t.translationMm[2],
          ],
          rotation: [...t.rotation],
          scale: [...t.scale],
        },
        gestureId: units("render-probe"),
      },
    });
    sync();
  }
  const original = state().activePlateId;
  if (fits(original)) {
    await execute({
      addPlate: {
        plateId: newId(),
        name: units("Render plate"),
        order: Math.max(...state().plates.map((p) => p.order)) + 1,
        activate: true,
      },
    });
    sync();
    await execute({ activatePlate: { plateId: units(original) } });
    sync();
  }
  const physical = state().filaments.physical.find((f) => fits(f.id));
  const object = objects()[0];
  if (physical && object) {
    await execute({
      setObjectFilament: {
        objectId: units(object.id),
        filamentId: { value: units(physical.id) },
      },
    });
    sync();
  }
  // Each volume draws in the colour of the filament it resolves to: a mixed
  // recipe's display colour, a part's own filament over its object's; a
  // height range's filament colours nothing drawn, as in the browser.
  const colours = () =>
    new Map(projectRender(state()).volumes.map((v) => [v.volumeId, v.color]));
  const recipe = state().filaments.mixed.find((f) => fits(f.id) && f.enabled);
  if (recipe && object) {
    const reply = await execute({
      setObjectFilament: {
        objectId: units(object.id),
        filamentId: { value: units(recipe.id) },
      },
    });
    assert.ok(!reply.error, JSON.stringify(reply));
    const drawn = colours();
    for (const volume of object.volumes.filter((v) => !v.filamentId))
      assert.equal(drawn.get(volume.id), recipe.displayColor);
    sync();
  }
  const own = state()
    .filaments.physical.filter((f) => fits(f.id) && f.enabled)
    .at(-1);
  const part = object?.volumes.find((v) => fits(v.id));
  if (own && part) {
    const reply = await execute({
      setVolumeFilament: {
        objectId: units(object.id),
        volumeId: units(part.id),
        filamentId: { value: units(own.id) },
      },
    });
    assert.equal(colours().get(part.id), own.color, JSON.stringify(reply));
    sync();
  }
  const range = object?.layerRanges.find((r) => fits(r.id));
  if (own && range) {
    const before = colours();
    await execute({
      setLayerRangeFilament: {
        objectId: units(object.id),
        layerRangeId: units(range.id),
        filamentId: { value: units(own.id) },
      },
    });
    assert.deepEqual(colours(), before);
    assert.equal(sync().total, 0);
  }
  if (object) {
    await execute({
      duplicateObject: {
        sourceObjectId: units(object.id),
        ids: {
          objectId: newId(),
          volumeIds: object.volumes.map(newId),
          instanceIds: object.instances.map(newId),
          layerRangeIds: object.layerRanges.map(newId),
        },
        destinationPlateId: { absent: {} },
        name: { absent: {} },
      },
    });
    sync();
  }

  // Paging across a newer edit: the retained target still answers.
  const target = objects()
    .flatMap((o) => o.instances)
    .find((i) => fits(i.id));
  if (target) {
    await execute({
      setInstancePrintable: {
        instanceId: units(target.id),
        printable: !target.printable,
      },
    });
    const first = render({ base: shown, start: 0, count: 1 });
    await execute({
      setInstancePrintable: {
        instanceId: units(target.id),
        printable: target.printable,
      },
    });
    for (let start = 1; start < first.total; start += 1)
      render({ base: shown, target: first.target, start, count: 1 });
    shown = first.target;
    sync();
  }
  if (object) {
    await execute({ deleteObject: { objectId: units(object.id) } });
    sync();
  }

  // Edits that change nothing a renderer shows still advance the target:
  // empty deltas, and enough served snapshots to release the opening one.
  for (const name of ["Render probe A", "Render probe B"]) {
    await execute({ renameProject: { name: units(name) } });
    sync();
  }

  // A base the feed never served starts from empty, with no base.
  const reset = render({
    base: { revision: 9_007_199_254_740_991, semanticHash: "fnv1a64:0" },
    start: 0,
    count: 64,
  });
  assert.equal(reset.base, undefined);
  // An unknown target and an oversized page refuse.
  render({
    target: { revision: 0, semanticHash: "fnv1a64:0" },
    start: 0,
    count: 1,
  });
  render({ base: shown, start: 0, count: 65 });
  // The opening snapshot as a target, released after eight newer served ones.
  render({
    base: shown,
    target: {
      revision: fixture.initial.snapshot.revision,
      semanticHash: fixture.initial.snapshot.hash,
    },
    start: 0,
    count: 64,
  });

  states.push({
    name: fixture.name,
    options: fixture.options,
    stateJson: fixture.stateJson,
    asset: fixture.asset,
    script,
  });
  session.dispose();
}

const sources = [
  "tools/cross-platform/render-delta-vectors.mjs",
  "web/src/project/renderProjection.ts",
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
      generation: nonce,
      states,
    },
    null,
    1,
  ) + "\n";
const path = new URL("testdata/cross-platform/render-delta-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Render delta reference drift",
  );
const count = (key) =>
  states.reduce((n, s) => n + s.script.filter((e) => key in e).length, 0);
console.log(
  `render deltas: ${states.length} states, ${count("page")} pages, ${count("refusal")} refusals, ${count("request")} session requests`,
);
