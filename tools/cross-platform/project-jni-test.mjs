import { replayProjectDocuments } from "./project-document-replay.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { startProjectJni, projectJniCore } from "./project-jni-bridge.mjs";
import { replayProject } from "./project-wasm-replay.mjs";
import { replayPreflights } from "./project-preflight-replay.mjs";
import { replayCatalogs } from "./catalog-replay.mjs";
import { replayLibrary } from "./library-replay.mjs";
import { replayEditor } from "./editor-replay.mjs";
import { replayProjection } from "./projection-replay.mjs";
import { replayCapabilities } from "./capability-replay.mjs";
import { replayRender } from "./render-replay.mjs";
import { replayFacetRegions } from "./facet-region-replay.mjs";
import { replayPaintStrokes } from "./paint-stroke-replay.mjs";
import { replayPicks } from "./pick-replay.mjs";
import { replayPlacements } from "./placement-replay.mjs";
import { replayArrangements } from "./arrange-replay.mjs";
import { replayWipeTowers } from "./wipe-tower-replay.mjs";
import { replayVolumeSplits } from "./volume-split-replay.mjs";
import { replaySimplify } from "./simplify-replay.mjs";
import { replayMeasure } from "./measure-replay.mjs";
import { replayBrimEars } from "./brim-ear-replay.mjs";
import { replayEmboss } from "./emboss-replay.mjs";
import { replaySvgParts } from "./svg-part-replay.mjs";
import { replayMeshPackets } from "./mesh-packet-replay.mjs";
import { replayAssembly } from "./assembly-replay.mjs";
import { projectJniBoundaries } from "./project-jni-boundaries.mjs";
import { replayProjectQueries } from "./project-query-replay.mjs";
import { replayStagedProject } from "./project-staged-replay.mjs";
import { projectStagedBoundaries } from "./project-staged-boundaries.mjs";
import { projectClipboardBoundaries } from "./project-clipboard-boundaries.mjs";
import { stagedCommandJson } from "./project-staged-replay.mjs";
import { replayArchives, archiveCases, replayHostileArchives } from "./archive-wasm-replay.mjs";
import { replayModelImports } from "./model-import-replay.mjs";
import { replayObjectTree } from "./object-tree-replay.mjs";
import { replayPrintJobStatus } from "./print-job-status-replay.mjs";
import { replayPrinterControl } from "./printer-control-replay.mjs";
import { replayPrinterTools } from "./printer-tools-replay.mjs";
import { replayPrinterPreparation } from "./printer-preparation-replay.mjs";
import { replayPrinterWorkflow } from "./printer-workflow-replay.mjs";
import { replayPrinterSession } from "./printer-session-replay.mjs";
import { replayMoonrakerTransport } from "./moonraker-transport-replay.mjs";
import { replayMoonrakerPolicy } from "./moonraker-policy-replay.mjs";
import { replayPrinterStorage, storageBytes } from "./printer-storage-replay.mjs";
import { historyNumber, replayPrintHistory } from "./printer-history-replay.mjs";
import { replayPrinterConsole } from "./printer-console-replay.mjs";
import { replayPrinterCamera } from "./printer-camera-replay.mjs";
import { replayPrinterDirectory } from "./printer-directory-replay.mjs";
import { replayRememberedCredentials } from "./printer-credentials-replay.mjs";
import { replayExternalSlicer } from "./external-slicer-replay.mjs";
import { plateProjectionCases, plateProjectionCode, replayPlateProjection } from "./plate-projection-replay.mjs";
import { replaySlicingConfiguration } from "./slicing-configuration-replay.mjs";
import { replayWorkspaceBeds } from "./workspace-bed-replay.mjs";
import { replayTransformFields } from "./transform-field-replay.mjs";
import { replayPrimitives } from "./primitive-replay.mjs";
import { replayFilamentAssignment } from "./filament-assignment-replay.mjs";
import { replayPaintTool } from "./paint-tool-replay.mjs";
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
/** Authored two-plate BBS archive shared with the instrumented actor test. */
const ACTOR_ARCHIVE_CASE = "bbs-model/16/plates-2-16";
const fixture = JSON.parse(
  await readFile(
    new URL("testdata/cross-platform/project-session-vectors.json", root),
  ),
);
const layout = JSON.parse(
  await readFile(new URL("contracts/project-host.json", root)),
);
const model = JSON.parse(
  await readFile(
    new URL("testdata/cross-platform/project-model-vectors.json", root),
  ),
);
const times = JSON.parse(
  await readFile(
    new URL("testdata/cross-platform/validation-value-vectors.json", root),
  ),
);
assert.ok(process.argv.slice(2).every((arg) => arg === "--release"));
const profile = process.argv.includes("--release") ? "release" : "debug";
const jvm = startProjectJni(profile);
try {
  const { owned, ...result } = await replayProject(
    projectJniCore(jvm.call),
    fixture,
    layout,
  );
  const boundaries = projectJniBoundaries(
    jvm.call,
    JSON.parse(model.factories[0].stateJson),
    times,
    fixture.generation,
  );
  const stagingOwnerChecks = jvm.call(
    "stagingChecks",
    model.factories[0].stateJson,
    stagedCommandJson(
      {
        single: {
          intent: {
            addPlate: {
              plateId: Array.from("import:plate:kotlin-upload", (c) =>
                c.charCodeAt(0),
              ),
              name: [78, 101, 119],
              order: 1,
              activate: true,
            },
          },
        },
      },
      JSON.parse(
        await readFile(new URL("contracts/project-staging.json", root)),
      ),
    ),
  );
  assert.equal(stagingOwnerChecks, 7);
  const stagedFixture = JSON.parse(
    await readFile(
      new URL(
        "testdata/cross-platform/project-staged-session-vectors.json",
        root,
      ),
    ),
  );
  const stagingLayout = JSON.parse(
    await readFile(new URL("contracts/project-staging.json", root)),
  );
  const clipboardTrace = stagedFixture.traces.find(
    (t) => t.name === "clipboard:roundtrip",
  );
  const clipboardWork = clipboardTrace.steps
    .flatMap((g) => g.actions)
    .find((a) => a.kind === "stage").work;
  const clipboardOwnerChecks = jvm.call(
    "clipboardChecks",
    clipboardTrace.stateJson,
    stagedCommandJson(clipboardWork, stagingLayout),
    Uint8Array.from(clipboardTrace.assets[0].bytes),
    Uint8Array.from(clipboardTrace.assets[1].bytes),
  );
  assert.equal(clipboardOwnerChecks, 6);
  const actorClipboardChecks = jvm.call("actorClipboardChecks", clipboardTrace.stateJson,
    stagedCommandJson(clipboardWork, stagingLayout), Uint8Array.from(clipboardTrace.assets[0].bytes), Uint8Array.from(clipboardTrace.assets[1].bytes));
  assert.equal(actorClipboardChecks, 13);
  let actorClipboardReplays = 0;
  for (const name of ["clipboard:roundtrip", "clipboard:sorted-projection"]) {
    const trace = stagedFixture.traces.find(t => t.name === name);
    const copy = trace.steps[0].actions.find(a => a.kind === "copy");
    const work = trace.steps.flatMap(g => g.actions).find(a => a.kind === "stage").work;
    const expected = trace.steps.find(g => g.replies.some(r => r.result.acknowledged));
    actorClipboardReplays += jvm.call("actorClipboardReplay", trace.stateJson, stagedCommandJson(work, stagingLayout),
      Uint8Array.from(trace.assets[0].bytes), Uint8Array.from(trace.assets[1].bytes), copy.queryPlate ?? copy.plate,
      JSON.stringify(expected.replies[0]), expected.effects.map(effect => layout.effects.indexOf(effect.kind)));
  }
  assert.equal(actorClipboardReplays, 2);
  const queryLayout = JSON.parse(
    await readFile(new URL("contracts/project-query.json", root)),
  );
  const documentOwnerChecks = jvm.call(
    "documentChecks",
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/project-model-vectors.json", root),
      ),
    ).factories[0].stateJson,
  );
  assert.equal(documentOwnerChecks, 7);
  const actorChecks = jvm.call("actorChecks", JSON.parse(await readFile(new URL("testdata/cross-platform/project-model-vectors.json",root))).factories[0].stateJson);
  assert.equal(actorChecks, 12);
  // New projects: the browser's empty project and "New project" from every model state.
  const fresh = JSON.parse(await readFile(new URL("testdata/cross-platform/project-fresh-vectors.json", root)));
  const states = new Map([
    ...model.factories.map((each) => [`factory:${each.seed}`, each.stateJson]),
    ...model.cases.map((each) => [`case:${each.name}`, each.stateJson]),
  ]);
  let newProjectChecks = jvm.call("newProjectChecks");
  assert.equal(newProjectChecks, 8);
  for (const { words, now, stateJson } of fresh.empty) newProjectChecks += jvm.call("newProjectCase", now, words, null, stateJson);
  // A source opens as a session from its document alone when it references no asset.
  const openable = fresh.fresh
    .map((each) => ({ ...each, sourceJson: each.sourceJson ?? states.get(each.source) }))
    .filter(({ sourceJson }) => JSON.parse(sourceJson).sourceAssets.length === 0);
  assert.equal(openable.length, 8);
  for (const { sourceJson, words, now, stateJson } of openable) {
    newProjectChecks += jvm.call("newProjectCase", now, words, sourceJson, stateJson);
  }
  assert.equal(newProjectChecks, 8 + fresh.empty.length + 2 * openable.length);
  const actorPreparationChecks = jvm.call("actorPreparationChecks", model.factories[0].stateJson);
  assert.equal(actorPreparationChecks, 17);
  const exportFixture = JSON.parse(await readFile(new URL("testdata/cross-platform/project-export-vectors.json", root)));
  const actorExportChecks = jvm.call("actorExportChecks", exportFixture.source, exportFixture.canonical,
    Uint8Array.from(exportFixture.assets[0].bytes), Uint8Array.from(exportFixture.assets[1].bytes), exportFixture.empty, exportFixture.large, exportFixture.largeCanonical);
  assert.equal(actorExportChecks, 13);
  const capturedActorTrace = stagedFixture.traces.find(t => t.name === "captured:capture-batches-exceed-small-wire-command-count");
  const capturedActorWork = capturedActorTrace.steps.flatMap(g => g.actions).find(a => a.kind === "stage").work;
  const capturedActorExpected = capturedActorTrace.steps.find(g => g.replies.some(r => r.result.acknowledged));
  const actorCapturedChecks = jvm.call("actorCapturedChecks", capturedActorTrace.stateJson, stagedCommandJson(capturedActorWork, stagingLayout),
    Uint8Array.from(capturedActorTrace.asset.bytes), JSON.stringify(capturedActorExpected.replies[0]),
    capturedActorExpected.effects.map(effect => layout.effects.indexOf(effect.kind)));
  assert.equal(actorCapturedChecks, 1);
  // The Kotlin writer (`ProjectStagedRecords`) writes every work whose
  // commands the app stages — instance copies, clipboard pastes, added parts
  // and objects with payloads — as typed values; the replay stages those
  // bytes and compares replies, effects and states with the browser's.
  let kotlinStagedWorks = 0;
  const staged = await replayStagedProject(
    projectJniCore(jvm.call),
    JSON.parse(
      await readFile(
        new URL(
          "testdata/cross-platform/project-staged-session-vectors.json",
          root,
        ),
      ),
    ),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root))),
    queryLayout,
    (work) => {
      const records = jvm.call("stagedRecords", JSON.stringify(work));
      if (records !== undefined) kotlinStagedWorks++;
      return records;
    },
  );
  assert.equal(kotlinStagedWorks, 102);
  // The writer's bytes are the browser's own wherever its records survive a
  // JSON round trip (no integer-like keys) and no intent is re-encoded.
  const escaped = (text) => text.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const verbatim = (json) => JSON.stringify(JSON.parse(json)) === json;
  const recordLines = stagedFixture.traces
    .flatMap((trace) => trace.steps.flatMap((group) => group.actions))
    .filter((action) => action.kind === "stage")
    .map((action) => action.work)
    .filter((work) => {
      const commands = work.single ? [work.single] : (work.commands ?? []);
      if (!work.single && !work.commands) return false;
      return commands.every(
        (c) =>
          !c.intent &&
          (c.clipboard || ["instance", "addVolume", "addObjectWithAsset"].includes(c.kind)) &&
          (c.index == null || (Number.isInteger(c.index) && Math.abs(c.index) < 2 ** 31)) &&
          (c.recordJson === undefined || verbatim(c.recordJson)) &&
          (c.asset === undefined || verbatim(c.asset.descriptorJson)),
      );
    })
    .map((work) => `W\t${JSON.stringify(work)}\t${escaped(stagedCommandJson(work, stagingLayout))}`);
  assert.equal(recordLines.length, 102);
  const stagedRecordChecks = jvm.call("stagedRecordChecks", recordLines.join("\n"));
  assert.equal(stagedRecordChecks, recordLines.length + 14);
  Object.assign(
    staged,
    replayProjectDocuments(
      projectJniCore(jvm.call),
      JSON.parse(
        await readFile(
          new URL(
            "testdata/cross-platform/project-document-vectors.json",
            root,
          ),
        ),
      ),
      layout,
    ),
    { clipboardOwnerChecks, actorClipboardChecks, actorClipboardReplays, documentOwnerChecks, actorChecks, actorPreparationChecks, newProjectChecks, actorExportChecks, actorCapturedChecks },
    projectClipboardBoundaries(
      projectJniCore(jvm.call),
      stagedFixture,
      layout,
      stagingLayout,
      queryLayout,
    ),
    projectStagedBoundaries(
      projectJniCore(jvm.call),
      fixture.traces[0],
      layout,
      JSON.parse(
        await readFile(new URL("contracts/project-staging.json", root)),
      ),
    ),
  );
  const queryFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/project-query-vectors.json", root),
    ),
  );
  const { ownedQueryText, ownedQueryExpected, ...queries } =
    replayProjectQueries(projectJniCore(jvm.call), queryFixture, queryLayout);
  // The browser-equivalent archive corpus through the real JNI exports: Open via
  // the upload/import/document slots, Save via an immutable export capture.
  const archives = await replayArchives(
    projectJniCore(jvm.call),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-archive.json", root))),
    archiveCases(
      JSON.parse(await readFile(new URL("testdata/cross-platform/canonical-complete-vectors.json", root))),
      JSON.parse(await readFile(new URL("testdata/cross-platform/foreign-import-vectors.json", root))),
      (path) => new Uint8Array(readFileSync(new URL(path, root))),
      (text) => new Uint8Array(Buffer.from(text, "base64")),
    ),
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual([archives.cases, archives.accepted, archives.saves], [1341, 1225, 1223]);
  // Every plate projected through the export capture's JNI exports as the
  // state-document exchange projects it, and one plate archive per project.
  assert.deepEqual(
    [archives.plates, archives.plateRefusals, archives.plateExchanges, archives.plateArchives],
    [1403, 185, 1403, 1225],
  );
  assert.deepEqual(archives.plateArchiveRefusals, []);
  // Hostile archives through the real JNI exports; no refusal reaches an
  // edited live session.
  const hostile = await replayHostileArchives(
    projectJniCore(jvm.call),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-archive.json", root))),
    JSON.parse(await readFile(new URL("testdata/cross-platform/hostile-archive-vectors.json", root))),
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (text) => new Uint8Array(Buffer.from(text, "base64")),
  );
  assert.deepEqual(
    [hostile.hostileArchives, hostile.hostileAccepted, hostile.hostileRefused, hostile.hostileUntouched],
    [469, 55, 414, 414],
  );
  // The browser's model import transactions through the real JNI exports.
  const json = async (path) => JSON.parse(await readFile(new URL(path, root)));
  const models = await replayModelImports(
    projectJniCore(jvm.call),
    layout,
    await json("contracts/project-model-import.json"),
    await json("testdata/cross-platform/model-transaction-vectors.json"),
    await json("testdata/cross-platform/model-stage-vectors.json"),
    await json("testdata/cross-platform/model-import-vectors.json"),
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (path) => new Uint8Array(readFileSync(new URL(path, root))),
    (text) => new Uint8Array(Buffer.from(text, "base64")),
  );
  assert.deepEqual([models.cases, models.committed], [21, 15]);
  const decodeRows = new Map((await json("testdata/cross-platform/model-import-vectors.json")).cases.map((c) => [c.name, c]));
  const decodeBytes = (name) => Buffer.from(decodeRows.get(name).bytesBase64, "base64");
  const actorImportChecks = jvm.call(
    "actorImportChecks",
    model.factories[0].stateJson,
    decodeBytes("stl-binary/cube"),
    decodeBytes("obj/mtllib-unresolved"),
    decodeBytes("detect/step"),
  );
  assert.equal(actorImportChecks, 7);
  // The Project area's session: start, import, undo/redo, Save/Open, New project, recent documents.
  const projectWorkspaceChecks = jvm.call("projectWorkspaceChecks", decodeBytes("stl-binary/cube"), decodeBytes("obj/mtllib-unresolved"));
  assert.equal(projectWorkspaceChecks, 27);
  // Selection and object edits: the selection store, tree rows, capabilities, every edit's step and label, plates.
  const projectEditChecks = jvm.call("projectEditChecks", decodeBytes("stl-binary/cube"));
  assert.equal(projectEditChecks, 73);
  // Recovery of unsaved work: the store, the browser's capture timing, checked restore.
  const projectRecoveryChecks = jvm.call("projectRecoveryChecks", decodeBytes("stl-binary/cube"));
  assert.equal(projectRecoveryChecks, 24);
  // One writer per document, and changes made outside detected by digest.
  const documentOwnersChecks = jvm.call("documentOwnersChecks", decodeBytes("stl-binary/cube"));
  assert.equal(documentOwnersChecks, 14);
  // A catalog choice becomes the project's configuration, undoably, and its preflight passes.
  const slicingChoiceChecks = jvm.call(
    "slicingChoiceChecks",
    decodeBytes("stl-binary/cube"),
    await readFile(new URL("web/public/profiles/catalog.json", root)),
  );
  assert.equal(slicingChoiceChecks, 11);
  // The local slicing route on a real session: a plate staged as the external
  // route's own upload, the engine's documents and every way a job ends, and
  // output claimed, verified and published only for the state it came from.
  const localSliceChecks = jvm.call(
    "localSliceChecks",
    decodeBytes("stl-binary/cube"),
    await readFile(new URL("testdata/parity/fixtures/reference.gcode", root)),
  );
  assert.equal(localSliceChecks, 77);
  // What the status line says of a finished slice (the browser's
  // `SliceStatus.ts`), streamed through the core's tally over JNI in several
  // chunkings and worded by the Kotlin owner, for every artifact of the corpus.
  const statusFixture = await json("testdata/cross-platform/slice-status-vectors.json");
  const statusBytes = (parts) =>
    Buffer.concat(
      parts.map((part) =>
        part.text !== undefined
          ? Buffer.from(part.text, "utf8")
          : part.repeat !== undefined
            ? Buffer.from(part.repeat.repeat(part.times), "utf8")
            : Buffer.from(part.bytes),
      ),
    );
  const sliceStatusChecks = jvm.call(
    "sliceStatusChecks",
    statusFixture.cases
      .map((c) =>
        [
          c.name,
          statusBytes(c.parts).toString("base64"),
          c.bytes,
          c.kilobytes,
          c.lines,
          c.layers,
          c.statedLayers ?? "-",
          c.layerMarkers,
          c.status.elapsedMs,
          c.status.warnings,
          Buffer.from(c.status.text, "utf8").toString("base64"),
        ].join("\t"),
      )
      .join("\n"),
  );
  assert.equal(sliceStatusChecks, 563);
  // The workspace bed through the JNI exports, then the Kotlin wrapper.
  const bedFixture = await json("testdata/cross-platform/workspace-bed-vectors.json");
  const workspaceBeds = replayWorkspaceBeds(projectJniCore(jvm.call), bedFixture, layout);
  assert.deepEqual([workspaceBeds.beds, workspaceBeds.bedRefusals, workspaceBeds.projectBeds], [74, 14, 12]);
  const workspaceBedChecks = jvm.call(
    "workspaceBedChecks",
    [
      ...bedFixture.cases.map((c) => `B\t${c.request}\t${c.reply}`),
      ...bedFixture.refusals.map((r) => `R\t${r.request}`),
      ...bedFixture.states.flatMap((p) => [`P\t${p.stateJson}`, ...p.beds.map((b) => `Q\t${b.request}\t${b.reply}`)]),
    ].join("\n"),
  );
  assert.equal(workspaceBedChecks, 178);
  // The transform inspector's fields through the JNI exports, then the Kotlin wrapper.
  const fieldFixture = await json("testdata/cross-platform/transform-field-vectors.json");
  const transformFields = replayTransformFields(projectJniCore(jvm.call), fieldFixture);
  assert.deepEqual(Object.values(transformFields), [101, 1720, 94, 19]);
  const transformFieldChecks = jvm.call(
    "transformFieldChecks",
    [
      ...fieldFixture.reads.map((c) => `F\t${c.request}\t${c.reply}`),
      ...fieldFixture.edits.map((c) => `E\t${c.request}\t${c.reply}`),
      ...fieldFixture.conversions.map((c) => `Q\t${c.request}\t${c.reply}`),
      ...fieldFixture.refusals.map((r) => `X\t${r.exchange}\t${r.request}`),
    ].join("\n"),
  );
  assert.equal(transformFieldChecks, 1936);
  // The painter's settings and paint colours through the JNI exports, then the Kotlin wrapper.
  const paintToolFixture = await json("testdata/cross-platform/paint-tool-vectors.json");
  const paintTool = replayPaintTool(projectJniCore(jvm.call), paintToolFixture);
  assert.deepEqual(Object.values(paintTool), [427, 34, 775]);
  const paintToolChecks = jvm.call(
    "paintToolChecks",
    [
      ...[...paintToolFixture.samples, ...paintToolFixture.errors].map((c) => `S\t${c.request}\t${c.reply}`),
      ...paintToolFixture.malformed.map((request) => `X\t${request}`),
      ...paintToolFixture.colors.map((c) => `C\t${c.request}\t${c.reply}`),
      ...paintToolFixture.colorRefusals.map((request) => `Y\t${request}`),
    ].join("\n"),
  );
  assert.equal(paintToolChecks, 1661);
  // Primitives and helper volumes through the JNI exports, then the Kotlin wrapper.
  const primitiveFixture = await json("testdata/cross-platform/primitive-vectors.json");
  const primitives = replayPrimitives(projectJniCore(jvm.call), primitiveFixture, layout, (text) => Uint8Array.from(Buffer.from(text, "base64")));
  assert.deepEqual(Object.values(primitives), [48, 7, 11, 35, 13]);
  const primitiveChecks = jvm.call(
    "primitiveChecks",
    [
      ...primitiveFixture.meshes.map((m) => `M\t${m.request}\t${m.byteLength}\t${m.digest}\t${m.payload ?? "-"}`),
      ...primitiveFixture.meshRefusals.map((r) => `X\t${r.request}`),
      ...primitiveFixture.states.flatMap((s) => [
        `S\t${s.name}\t${s.stateJson}`,
        ...JSON.parse(s.stateJson).sourceAssets.map((declared) => {
          const asset = s.assets.find((a) => JSON.parse(a.descriptorJson).id === declared.id);
          return `A\t${asset.descriptorJson}\t${asset.bytes}`;
        }),
        ...s.plans.map((p) => `P\t${p.kind}\t${p.request}\t${p.reply}`),
        ...primitiveFixture.planRefusals.filter((r) => (r.state ?? "empty") === s.name).map((r) => `R\t${r.kind}\t${r.request}`),
      ]),
    ].join("\n"),
  );
  assert.equal(primitiveChecks, 214);
  // Creation through ProjectWorkspace on a real session: the browser's hash,
  // undo label and count after every primitive, helper volume, instance, fill,
  // copy, cut and paste, then undo back to the opened project.
  const createEditChecks = jvm.call(
    "createEditChecks",
    JSON.stringify({
      seed: primitiveFixture.journey.seed,
      skippedIds: primitiveFixture.journey.skippedIds,
      importedAt: primitiveFixture.journey.importedAt,
      opened: primitiveFixture.journey.opened,
      bed: primitiveFixture.journey.bed,
      steps: primitiveFixture.journey.steps,
      undo: primitiveFixture.journey.undo,
    }),
    Buffer.from(primitiveFixture.journey.archive, "base64"),
  );
  assert.equal(createEditChecks, 145);
  // Placement edits through ProjectWorkspace on a real session: the browser's
  // hash, undo label and report after every edit, and undo back to the start.
  const editFixture = await json("testdata/cross-platform/placement-edit-vectors.json");
  const placementEditChecks = jvm.call(
    "placementEditChecks",
    JSON.stringify({
      bed: editFixture.bed,
      opened: editFixture.opened,
      plateId: editFixture.plateId,
      steps: editFixture.steps,
      undo: editFixture.undo,
    }),
    Buffer.from(editFixture.archive, "base64"),
  );
  assert.equal(placementEditChecks, 127);
  // Filament assignment through the JNI exports, then the project's filaments on
  // real sessions: the browser's snapshot, hash and undo label after every
  // assignment of its journey and every undo, and the filament list's slot edits.
  const filamentFixture = await json("testdata/cross-platform/filament-assignment-vectors.json");
  const filamentAssignment = replayFilamentAssignment(projectJniCore(jvm.call), filamentFixture, layout, fixture.generation);
  assert.deepEqual(filamentAssignment.filamentAssignmentAnswers, [36, 18, 15, 16]);
  const filamentChecks = jvm.call(
    "filamentChecks",
    JSON.stringify({
      opened: filamentFixture.journey.opened,
      steps: filamentFixture.journey.steps,
      undo: filamentFixture.journey.undo,
    }),
    Buffer.from(filamentFixture.journey.archive, "base64"),
    decodeBytes("stl-binary/cube"),
    await readFile(new URL("web/public/profiles/catalog.json", root)),
  );
  assert.equal(filamentChecks, 76);
  // The transform inspector on a real session: every field edit of the corpus
  // lands as the browser computed it (or is refused in its words), one undo
  // entry each that never coalesces; the Edit menu's placement on the selection.
  const transformEditChecks = jvm.call(
    "transformEditChecks",
    decodeBytes("stl-binary/cube"),
    fieldFixture.edits.map((c) => `E\t${c.request}\t${c.reply}`).join("\n"),
  );
  assert.equal(transformEditChecks, 509);
  // The renderer's view of a real session: render deltas and mesh packets into the scene.
  const projectSceneChecks = jvm.call("projectSceneChecks", decodeBytes("stl-binary/cube"));
  assert.equal(projectSceneChecks, 13);
  // What the Workspace's 3D view says to TalkBack, from a real session as it changes.
  const accessibilityChecks = jvm.call("accessibilityChecks");
  assert.equal(accessibilityChecks, 18);
  // The painter on a real session: palette, strokes, previews, commits, refusals and Erase all.
  const paintChecks = jvm.call("paintChecks");
  assert.equal(paintChecks, 45);
  // The Workspace's paint as a renderer gets it: changed facets' vertex colours, previews, channels.
  const scenePaintChecks = jvm.call("scenePaintChecks");
  assert.equal(scenePaintChecks, 13);
  // The Workspace's base colours as a renderer gets them: physical, mixed, part over object, modifiers, ranges.
  const sceneColourChecks = jvm.call("sceneColourChecks");
  assert.equal(sceneColourChecks, 9);
  const archiveCase = JSON.parse(
    await readFile(new URL("testdata/cross-platform/foreign-import-vectors.json", root)),
  ).cases.find((c) => c.name === ACTOR_ARCHIVE_CASE);
  const actorArchiveChecks = jvm.call(
    "actorArchiveChecks",
    model.factories[0].stateJson,
    Buffer.from(archiveCase.archiveBase64, "base64"),
    archiveCase.expected.warnings.length,
  );
  assert.equal(actorArchiveChecks, 7);
  const providerDocumentChecks = jvm.call(
    "providerDocumentChecks",
    model.factories[0].stateJson,
    Buffer.from(archiveCase.archiveBase64, "base64"),
    archiveCase.expected.warnings.length,
  );
  assert.equal(providerDocumentChecks, 6);
  // Live preflights through the raw exports, then the Kotlin wrapper and codecs.
  const preflightFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/slice-profile-vectors.json", root),
    ),
  );
  const preflights = replayPreflights(
    projectJniCore(jvm.call),
    preflightFixture,
    layout,
    fixture.generation,
  );
  assert.deepEqual(
    [preflights.preflightCases, preflights.preflightItems, preflights.preflightRefusals],
    [7, 59, 42],
  );
  let actorPreflightChecks = 0;
  for (const c of preflightFixture.attestations) {
    assert.equal(c.assets.length, 1);
    actorPreflightChecks += jvm.call(
      "actorPreflightChecks",
      c.stateJson,
      Uint8Array.from(c.assets[0].bytes),
      c.requestJson,
      [
        c.summaryJson,
        c.issueJsons.join("\n"),
        c.omissionJsons.join("\n"),
        c.instanceJsons.join("\n"),
        c.filamentJsons.join("\n"),
      ].join("\n--\n"),
    );
  }
  assert.equal(actorPreflightChecks, 115);
  // The profile catalog through the raw exports, then the Kotlin wrapper.
  const catalogFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/preset-catalog-vectors.json", root),
    ),
  );
  const catalogBytes = new Uint8Array(
    await readFile(new URL("web/public/profiles/catalog.json", root)),
  );
  const catalogs = replayCatalogs(
    projectJniCore(jvm.call),
    catalogFixture,
    catalogBytes,
    undefined,
  );
  assert.deepEqual(
    [catalogs.catalogReplies, catalogs.catalogRefusals],
    [506, 12],
  );
  const bundled = catalogFixture.exchanges.bundled;
  const catalogChecks = jvm.call(
    "catalogChecks",
    catalogBytes,
    [
      bundled.diagnosticJsons[0],
      bundled.presetJsons[0],
      bundled.profiles[0].profileJson,
      bundled.profiles[0].configJson,
      bundled.selections[0].requestJson,
      bundled.selections[0].resultJson,
      bundled.targets[0].requestJson,
      bundled.targets[0].resultJson,
    ].join("\n"),
  );
  assert.equal(catalogChecks, 15);
  // The preset library through the raw exports, then the Kotlin wrapper.
  const libraryFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/preset-library-vectors.json", root),
    ),
  );
  const libraries = replayLibrary(
    projectJniCore(jvm.call),
    libraryFixture,
    catalogBytes,
    [undefined],
  );
  assert.deepEqual(
    [libraries.libraryReplies, libraries.libraryRefusals],
    [425, 184],
  );
  const scenario = (name) =>
    libraryFixture.scenarios.find((s) => s.name === name).steps;
  const [bundles, custom] = [scenario("acme-bundles"), scenario("acme-custom")];
  const libraryChecks = jvm.call(
    "libraryChecks",
    new TextEncoder().encode(libraryFixture.catalogs.acme),
    [
      bundles[0].wire.operationJson,
      bundles[0].wire.outcomeJson,
      bundles[1].wire.operationJson,
      bundles[1].wire.outcomeJson,
      bundles[5].wire.customJsons[0],
      custom[4].wire.operationJson,
      custom[4].wire.outcomeJson,
      custom[4].wire.issueJsons[0],
      libraryFixture.wire.coerceCases[17].requestJson,
      libraryFixture.wire.coerceCases[17].replyJson,
      libraryFixture.wire.formatCases[10].requestJson,
      libraryFixture.wire.formatCases[10].replyJson,
    ].join("\n"),
  );
  assert.equal(libraryChecks, 25);
  // The settings editor through the raw exports (platform folding), then the
  // Kotlin wrapper.
  const editorFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/settings-editor-vectors.json", root),
    ),
  );
  const editors = replayEditor(projectJniCore(jvm.call), editorFixture, [
    undefined,
    "platform",
  ]);
  assert.deepEqual(
    [editors.editorReplies, editors.editorRefusals],
    [14938, 78],
  );
  const queryAt = editorFixture.queryCases.findIndex((q) => {
    const query = JSON.parse(q.queryJson);
    return query.search === "layer" && query.mode === "develop";
  });
  const project = editorFixture.wire.editors[0];
  const editorChecks = jvm.call(
    "editorChecks",
    [
      project.createJson,
      project.steps[0].requestJson,
      project.steps[0].replyJson,
      editorFixture.wire.queries[queryAt].requestJson,
      String(editorFixture.wire.queries[queryAt].count),
      editorFixture.wire.queries[queryAt].samples[0][1],
      editorFixture.wire.steps[0].requestJson,
      editorFixture.wire.steps[0].replyJson,
      editorFixture.wire.rules[4].requestJson,
      editorFixture.wire.rules[4].replyJson,
      editorFixture.wire.rows[2].createJson,
      editorFixture.wire.rows[2].requestJson,
      String(editorFixture.wire.rows[2].count),
    ].join("\n"),
  );
  assert.equal(editorChecks, 24);
  // Settings projection and sessions on captured projects (platform folding).
  const projections = replayProjection(
    projectJniCore(jvm.call),
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/settings-projection-vectors.json", root),
      ),
    ),
    layout,
    fixture.generation,
    [undefined, "platform"],
  );
  assert.deepEqual(
    [projections.projectionReplies, projections.projectionRefusals],
    [281, 36],
  );
  // Capability pages over live sessions, then the Kotlin wrapper.
  const capabilityFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/capability-exchange-vectors.json", root),
    ),
  );
  const capabilities = replayCapabilities(
    projectJniCore(jvm.call),
    capabilityFixture,
    layout,
  );
  assert.deepEqual(
    [capabilities.capabilityPages, capabilities.capabilityRefusals],
    [366, 183],
  );
  const capabilityState = capabilityFixture.states[0];
  const capabilityChecks = jvm.call(
    "capabilityChecks",
    capabilityState.stateJson,
    Uint8Array.from(capabilityState.asset.bytes),
    capabilityState.phases[0].queries
      .flatMap((q) => [q.requestJson, q.replyJson])
      .join("\n"),
  );
  assert.equal(capabilityChecks, 15);
  // Render deltas over live sessions, then the Kotlin wrapper.
  const renderFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/render-delta-vectors.json", root),
    ),
  );
  const renders = replayRender(projectJniCore(jvm.call), renderFixture, layout);
  assert.deepEqual(
    [renders.renderPages, renders.renderRefusals, renders.renderRequests],
    [313, 57, 265],
  );
  const renderState = renderFixture.states[0];
  const renderChecks = jvm.call(
    "renderChecks",
    renderState.stateJson,
    Uint8Array.from(renderState.asset.bytes),
    renderState.script
      .map((e) =>
        "request" in e
          ? `R\t${e.request}`
          : "page" in e
            ? `P\t${e.render}\t${e.page}`
            : `X\t${e.render}\t${e.refusal}`,
      )
      .join("\n"),
  );
  assert.equal(renderChecks, 50);
  // Facet region selection over a live session, then the Kotlin wrapper.
  const regionFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/facet-region-exchange-vectors.json", root),
    ),
  );
  const regions = replayFacetRegions(projectJniCore(jvm.call), regionFixture, layout);
  assert.deepEqual(
    [regions.facetRegionReplies, regions.facetRegionRefusals],
    [136, 2],
  );
  const facetRegionChecks = jvm.call(
    "facetRegionChecks",
    regionFixture.stateJson,
    Uint8Array.from(regionFixture.assets[0].bytes),
    Uint8Array.from(regionFixture.assets[1].bytes),
    regionFixture.script
      .map((e) => ("refusal" in e ? `X\t${e.request}\t${e.refusal}` : `P\t${e.request}\t${e.reply}`))
      .join("\n"),
  );
  assert.equal(facetRegionChecks, 411);
  // Paint strokes over a live session, staged and executed, then the Kotlin wrapper.
  const strokeFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/paint-stroke-vectors.json", root),
    ),
  );
  const strokes = await replayPaintStrokes(
    projectJniCore(jvm.call),
    strokeFixture,
    layout,
    stagingLayout.version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    [strokes.paintStrokeOpens, strokes.paintStrokeSamples, strokes.paintStrokeOverlays, strokes.paintStrokeCommits, strokes.paintStrokeRefusals, strokes.paintOverlayPackets, strokes.paintFacetCaptures],
    [14, 22, 5, 14, 13, 51, 51],
  );
  const unitsText = (u) => String.fromCharCode(...u);
  const paintStrokeChecks = jvm.call(
    "paintStrokeChecks",
    strokeFixture.stateJson,
    Uint8Array.from(strokeFixture.assets[0].bytes),
    Uint8Array.from(strokeFixture.assets[1].bytes),
    strokeFixture.steps
      .map((s) =>
        "previewFacets" in s
          ? `F\t${s.stroke}\t${s.summary}\t${s.runs}\t${s.leaves}\t${s.runWindow ?? ""}\t${s.leafWindow ?? ""}`
          : "canonicalFacets" in s
            ? `G\t${s.canonicalFacets}\t${s.summary ?? ""}\t${s.runs ?? ""}\t${s.leaves ?? ""}\t${s.runWindow ?? ""}\t${s.leafWindow ?? ""}\t${s.refusal ?? ""}\t${s.count ?? ""}`
            : "preview" in s
          ? `P\t${s.stroke}\t${s.summary}\t${s.packet}\t${s.window ?? ""}`
          : "canonical" in s
            ? `K\t${s.canonical}\t${s.summary ?? ""}\t${s.packet ?? ""}\t${s.window ?? ""}\t${s.refusal ?? ""}\t${s.count ?? ""}`
            : "open" in s
          ? `O\t${s.stroke}\t${s.open}\t${s.refusal ?? ""}`
          : "sample" in s
            ? `S\t${s.stroke}\t${s.sample}\t${s.reply}`
            : "overlay" in s
              ? `V\t${s.stroke}\t${s.overlay}\t${s.reply ?? ""}\t${s.refusal ?? ""}`
              : `C\t${s.stroke}\t${s.commit === null ? "" : unitsText(s.commit)}\t${s.outcome}\t${s.revision}\t${s.hash}\t${s.undoLabel === null ? "" : unitsText(s.undoLabel)}`,
      )
      .join("\n"),
  );
  assert.equal(paintStrokeChecks, 231);
  // Ray picking over a live session, then the Kotlin wrapper.
  const pickFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/pick-vectors.json", root)),
  );
  const picked = replayPicks(projectJniCore(jvm.call), pickFixture, layout);
  assert.deepEqual([picked.picks, picked.pickRefusals], [486, 1]);
  const pickChecks = jvm.call(
    "pickChecks",
    pickFixture.stateJson,
    ...pickFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    [
      ...pickFixture.scenes.flatMap((s) => [`S\t${s.request}`, ...s.picks.map((p) => `R\t${p.ray}\t${p.reply}`)]),
      ...pickFixture.refusals.map((r) => `X\t${r.request}\t${r.refusal}`),
    ].join("\n"),
  );
  assert.equal(pickChecks, 976);
  // Placement planning over a live session, then the Kotlin wrapper.
  const placementFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/placement-vectors.json", root)),
  );
  assert.equal(replayPlacements(projectJniCore(jvm.call), placementFixture, layout).placements, 67);
  const placementChecks = jvm.call(
    "placementChecks",
    placementFixture.stateJson,
    ...placementFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    placementFixture.cases.map((c) => `${c.request}\t${c.reply}`).join("\n"),
  );
  assert.equal(placementChecks, 135);
  // Arrangement and bed fill over a live session, then the Kotlin wrapper.
  const arrangeFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/arrange-vectors.json", root)),
  );
  assert.equal(replayArrangements(projectJniCore(jvm.call), arrangeFixture, layout).arrangements, 28);
  const arrangeChecks = jvm.call(
    "arrangeChecks",
    arrangeFixture.stateJson,
    ...arrangeFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    arrangeFixture.cases
      .map((c) => ("arrange" in c ? `A\t${c.arrange}\t${c.reply}` : `F\t${c.fill}\t${c.reply}`))
      .join("\n"),
  );
  assert.equal(arrangeChecks, 57);
  // Wipe-tower auto-placement over a live session, then the Kotlin wrapper.
  const towerFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/wipe-tower-vectors.json", root)),
  );
  assert.equal(replayWipeTowers(projectJniCore(jvm.call), towerFixture, layout).wipeTowers, 27);
  const wipeTowerChecks = jvm.call(
    "wipeTowerChecks",
    towerFixture.stateJson,
    ...towerFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    towerFixture.cases.map((c) => `${c.request}\t${c.reply}`).join("\n"),
  );
  assert.equal(wipeTowerChecks, 55);
  // Volume splits over a live session, staged and executed, then the Kotlin
  // wrapper.
  const splitFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/volume-split-vectors.json", root)),
  );
  const splits = await replayVolumeSplits(
    projectJniCore(jvm.call),
    splitFixture,
    layout,
    stagingLayout.version,
  );
  assert.deepEqual(
    [
      splits.volumeSplitPreparations,
      splits.volumeSplitRefusals,
      splits.volumeSplitStages,
      splits.volumeSplitsApplied,
      splits.volumeSplitHistory,
    ],
    [16, 6, 19, 5, 6],
  );
  const label = (s) => (s.undoLabel ? String.fromCharCode(...s.undoLabel) : "");
  const volumeSplitChecks = jvm.call(
    "volumeSplitChecks",
    splitFixture.stateJson,
    ...splitFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    splitFixture.steps
      .map((s) =>
        "prepare" in s
          ? `P\t${s.split}\t${s.prepare}\t${s.reply}`
          : "stage" in s
            ? `S\t${s.split}\t${s.stage}\t${s.outcome}\t${s.revision}\t${s.hash}\t${label(s)}`
            : "edit" in s
              ? `E\t${s.edit}\t${s.revision}\t${s.hash}\t${label(s)}`
              : `H\t${s.history}\t${s.revision}\t${s.hash}\t${label(s)}`,
      )
      .join("\n"),
  );
  assert.equal(volumeSplitChecks, 105);
  // Mesh simplification over a live session, staged and executed, then the
  // Kotlin wrapper.
  const simplifyFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/simplify-vectors.json", root)),
  );
  const simplified = await replaySimplify(
    projectJniCore(jvm.call),
    simplifyFixture,
    layout,
    stagingLayout.version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    [
      simplified.simplifyPrepared,
      simplified.simplifyUnchanged,
      simplified.simplifyRefused,
      simplified.simplifyMeshes,
      simplified.simplifyStages,
      simplified.simplifyApplied,
      simplified.simplifyHistory,
    ],
    [34, 12, 8, 34, 9, 3, 3],
  );
  const simplifyChecks = jvm.call(
    "simplifyChecks",
    simplifyFixture.stateJson,
    ...simplifyFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    simplifyFixture.steps
      .map((s) =>
        "prepare" in s
          ? `P\t${s.simplify}\t${s.prepare}\t${s.reply}\t${s.mesh ?? ""}\t${s.window ?? ""}`
          : "stage" in s
            ? `S\t${s.simplify}\t${s.stage}\t${s.outcome}\t${s.revision}\t${s.hash}\t${label(s)}`
            : `H\t${s.history}\t${s.revision}\t${s.hash}\t${label(s)}`,
      )
      .join("\n"),
  );
  assert.equal(simplifyChecks, 177);
  // Surface measurement over a live session, then the Kotlin wrapper.
  const measureFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/measure-vectors.json", root)),
  );
  const measured = replayMeasure(projectJniCore(jvm.call), measureFixture, layout);
  assert.deepEqual(
    [
      measured.measureCaptures,
      measured.measureCaptureRefusals,
      measured.measurePicks,
      measured.measurePickRefusals,
      measured.measurePairs,
      measured.measurePairRefusals,
    ],
    [6, 1, 1260, 10, 679, 1],
  );
  const measureChecks = jvm.call(
    "measureChecks",
    measureFixture.stateJson,
    ...measureFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    measureFixture.steps
      .map((s) =>
        "capture" in s
          ? `C\t${s.volume}\t${s.capture}\t${s.reply}`
          : "feature" in s
            ? `F\t${s.volume}\t${s.feature}\t${s.reply}`
            : `M\t${s.measure}\t${s.reply}`,
      )
      .join("\n"),
  );
  assert.equal(measureChecks, 3915);
  // Brim-ear detection over a live session, then the Kotlin wrapper.
  const brimEarFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/brim-ear-vectors.json", root)),
  );
  assert.deepEqual(replayBrimEars(projectJniCore(jvm.call), brimEarFixture, layout), {
    brimEarDetections: 40,
    brimEarStrandedChecks: 9,
  });
  const brimEarChecks = jvm.call(
    "brimEarChecks",
    brimEarFixture.stateJson,
    ...brimEarFixture.assets.map((a) => Uint8Array.from(a.bytes)),
    brimEarFixture.steps
      .map((s) => ("detect" in s ? `D\t${s.detect}\t${s.reply}` : `S\t${s.stranded}\t${s.reply}`))
      .join("\n"),
  );
  assert.equal(brimEarChecks, 99);
  // Text embossing: cuts and stages, then the Kotlin wrapper.
  const embossFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/emboss-vectors.json", root)),
  );
  const embossed = await replayEmboss(
    projectJniCore(jvm.call),
    embossFixture,
    layout,
    stagingLayout.version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    [
      embossed.embossPrepared,
      embossed.embossRefused,
      embossed.embossMeshes,
      embossed.embossStages,
      embossed.embossApplied,
      embossed.embossHistory,
    ],
    [21, 8, 21, 8, 3, 3],
  );
  const embossChecks = jvm.call(
    "embossChecks",
    embossFixture.stateJson,
    Uint8Array.from(embossFixture.assets[0].bytes),
    embossFixture.steps
      .map((s) =>
        "prepare" in s
          ? `P\t${s.emboss}\t${s.prepare}\t${s.reply}\t${s.mesh ?? ""}\t${s.window ?? ""}`
          : "stage" in s
            ? `S\t${s.emboss}\t${s.stage}\t${s.outcome}\t${s.revision}\t${s.hash}\t${label(s)}`
            : `H\t${s.history}\t${s.revision}\t${s.hash}\t${label(s)}`,
      )
      .join("\n"),
  );
  assert.equal(embossChecks, 111);
  // SVG parts: drawings cut from their file bytes and staged, then the Kotlin
  // wrapper.
  const svgFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/svg-part-vectors.json", root)),
  );
  const svgParts = await replaySvgParts(
    projectJniCore(jvm.call),
    svgFixture,
    layout,
    stagingLayout.version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (text) => Uint8Array.from(Buffer.from(text, "base64")),
  );
  assert.deepEqual(
    [
      svgParts.svgPrepared,
      svgParts.svgRefused,
      svgParts.svgMeshes,
      svgParts.svgStages,
      svgParts.svgApplied,
      svgParts.svgHistory,
    ],
    [11, 11, 11, 15, 7, 4],
  );
  const svgPartChecks = jvm.call(
    "svgPartChecks",
    svgFixture.stateJson,
    Uint8Array.from(svgFixture.assets[0].bytes),
    svgFixture.steps
      .map((s) =>
        "prepare" in s
          ? `P\t${s.svg}\t${s.prepare}\t${s.drawing}\t${s.reply}\t${s.mesh ?? ""}\t${s.window ?? ""}`
          : "stage" in s
            ? `S\t${s.svg}\t${s.stage}\t${s.outcome}\t${s.revision}\t${s.hash}\t${label(s)}`
            : `H\t${s.history}\t${s.revision}\t${s.hash}\t${label(s)}`,
      )
      .join("\n"),
  );
  assert.equal(svgPartChecks, 111);
  // Mesh renderer packets: replies and paged bytes, then the Kotlin wrapper.
  const packetFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/mesh-packet-vectors.json", root)),
  );
  const packets = await replayMeshPackets(
    projectJniCore(jvm.call),
    packetFixture,
    layout,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    [
      packets.meshPacketsPrepared,
      packets.meshPacketsRefused,
      packets.meshPacketChunks,
    ],
    [53, 3, 8307],
  );
  const packetChecks = jvm.call(
    "meshPacketChecks",
    packetFixture.stateJson,
    Uint8Array.from(packetFixture.assets.flatMap((a) => a.bytes)),
    packetFixture.assets.map((a) => a.bytes.length).join(","),
    packetFixture.steps
      .map((s) => `P\t${s.request}\t${s.reply}\t${s.bytes ?? ""}\t${s.window ?? ""}`)
      .join("\n"),
  );
  assert.equal(packetChecks, 219);
  // Assembly alignment: availability, alignments and explosions, then the
  // Kotlin wrapper.
  const assemblyFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/assembly-vectors.json", root)),
  );
  const assembled = replayAssembly(projectJniCore(jvm.call), assemblyFixture);
  assert.deepEqual(
    [
      assembled.assemblyAvailability,
      assembled.assemblyAlignments,
      assembled.assemblyPlanned,
      assembled.assemblyExplosions,
    ],
    [55, 525, 246, 7],
  );
  const assemblyChecks = jvm.call(
    "assemblyChecks",
    assemblyFixture.steps
      .map((s) =>
        "availability" in s
          ? `A\t${s.availability}\t${s.reply}`
          : "alignment" in s
            ? `L\t${s.alignment}\t${s.reply}`
            : `E\t${s.explosion}\t${s.reply}`,
      )
      .join("\n"),
  );
  assert.equal(assemblyChecks, 1174);
  // The Objects tree on captured projects (platform folding), then the Kotlin
  // wrapper over the browser's richest state.
  const treeFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/object-tree-vectors.json", root)),
  );
  const trees = replayObjectTree(
    projectJniCore(jvm.call),
    treeFixture,
    layout,
    fixture.generation,
    "platform",
  );
  assert.deepEqual(
    [
      trees.objectTreeStates,
      trees.objectTreePages,
      trees.objectTreeSelections,
      trees.objectTreeIgnored,
      trees.objectTreeRefusals,
    ],
    [5, 367, 546, 21, 9],
  );
  const scene = treeFixture.states.findIndex((s) => s.name === "scene");
  const treeChecks = jvm.call(
    "objectTreeChecks",
    treeFixture.states[scene].stateJson,
    Uint8Array.from(treeFixture.assets[0].bytes),
    treeFixture.cases
      .filter((c) => c.state === scene)
      .map((c) =>
        c.replyJson !== undefined
          ? `T\t${c.requestJson}\t${c.replyJson}`
          : `R\t${c.requestJson}\t${c.refusal}`,
      )
      .join("\n"),
  );
  assert.equal(treeChecks, 605);
  // The print job status model through the real JNI exports, then the Kotlin
  // wrapper over every trace.
  const printJobFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/print-job-status-vectors.json", root)),
  );
  const printJobs = replayPrintJobStatus(projectJniCore(jvm.call), printJobFixture);
  assert.deepEqual(
    [printJobs.printJobSnapshots, printJobs.printJobIgnored, printJobs.printJobRefusals],
    [790, 76, 7],
  );
  const printJobChecks = jvm.call(
    "printJobStatusChecks",
    printJobFixture.traces
      .flatMap((trace) => [
        "T",
        ...trace.steps.map((s) =>
          [
            { query: "Q", notify: "N", reset: "X" }[s.op],
            String(s.nowMs ?? 0),
            s.text ?? "",
            s.refusal !== undefined ? "R" : s.ignored ? "I" : "S",
            s.refusal ?? s.snapshotJson ?? "",
            s.currentJson,
          ].join("\t"),
        ),
      ])
      .join("\n"),
  );
  assert.equal(printJobChecks, 1747);
  // Printer control through the real JNI exports, then the Kotlin wrappers.
  const controlFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-control-vectors.json", root)),
  );
  const control = replayPrinterControl(projectJniCore(jvm.call), controlFixture);
  assert.deepEqual(
    [
      control.printerAvailability,
      control.printerChecks,
      control.printerFailures,
      control.printerSummaries,
      control.printerGuarded,
      control.printerHoldSteps,
    ],
    [45, 1125, 100, 1173, 540, 35],
  );
  const tag = { availability: "A", checks: "C", failures: "F", summaries: "S", guarded: "G" };
  const controlChecks = jvm.call(
    "printerControlChecks",
    [
      ...Object.entries(tag).flatMap(([section, letter]) =>
        controlFixture[section].map((c) => `${letter}\t${c.requestJson}\t${c.replyJson}`),
      ),
      ...controlFixture.holds.flatMap((trace) => [
        "T",
        ...trace.steps.map((s) => [s.op, String(s.nowMs), s.actionJson ?? "", s.replyJson].join("\t")),
      ]),
    ].join("\n"),
  );
  assert.equal(controlChecks, 3019);
  // Tool usage, filament slots and tool mapping through the real JNI exports,
  // then the Kotlin wrappers.
  const toolsFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-tools-vectors.json", root)),
  );
  const tools = replayPrinterTools(projectJniCore(jvm.call), toolsFixture);
  assert.deepEqual(
    [tools.printerToolUsages, tools.printerSlotReplies, tools.printerMappings],
    [100, 20, 1552],
  );
  const toolsChecks = jvm.call(
    "printerToolsChecks",
    [
      ...toolsFixture.usage.map((c) => `U\t${c.bytesBase64}\t${c.usageJson}`),
      ...toolsFixture.slots.map((c) => `S\t${c.text}\t${c.replyJson}`),
      ...toolsFixture.mapping.map((c) => `M\t${c.requestJson}\t${c.replyJson}`),
    ].join("\n"),
  );
  assert.equal(toolsChecks, 1672);
  // Print preparation and submission checks through the real JNI exports,
  // then the Kotlin wrapper.
  const preparationFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-preparation-vectors.json", root)),
  );
  assert.equal(
    replayPrinterPreparation(projectJniCore(jvm.call), preparationFixture).printerPreparationAnswers,
    929,
  );
  const preparationScript = [
    ...preparationFixture.capabilities.map((c) => [c.kind, c.text, "", c.replyJson]),
    ...["options", "plans", "sends", "readinessFailures", "filenames", "failures"].flatMap((section) =>
      preparationFixture[section].map((c) => [section, c.requestJson, "", c.replyJson]),
    ),
    ...preparationFixture.readiness.map((c) => ["readiness", c.text, "", c.replyJson]),
    ...preparationFixture.identities.map((c) => ["identities", c.text, c.requestJson, c.replyJson]),
  ];
  assert.equal(
    jvm.call("printPreparationChecks", preparationScript.map((row) => row.join("\t")).join("\n")),
    929,
  );
  // The submission workflow through the real JNI exports, then the Kotlin
  // wrapper, step for step.
  const workflowFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-workflow-vectors.json", root)),
  );
  assert.deepEqual(
    Object.values(replayPrinterWorkflow(projectJniCore(jvm.call), workflowFixture)),
    [402, 19688, 13],
  );
  const workflowScript = workflowFixture.scenarios.flatMap((scenario) => [
    "N",
    ...scenario.records.map(({ input, step, refused }) => {
      const [kind, value] = Object.entries(input)[0];
      const [id, argument] =
        kind === "resolve"
          ? [value.id, value.outcome]
          : kind === "reply"
            ? [value.id, Buffer.from(value.text, "utf8").toString("base64")]
            : kind === "run" || kind === "stored"
              ? ["", value]
              : ["", ""];
      return [kind, id, argument, step ?? `!${refused}`].join("\t");
    }),
  ]);
  assert.equal(jvm.call("printWorkflowChecks", workflowScript.join("\n")), 19689);
  // The printer session through the real JNI exports, then the Kotlin
  // wrapper: step, view and reply for each input.
  const sessionFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-session-vectors.json", root)),
  );
  assert.deepEqual(
    Object.values(replayPrinterSession(projectJniCore(jvm.call), sessionFixture)),
    [80, 3254, 557, 8],
  );
  const base64 = (text) => Buffer.from(text, "utf8").toString("base64");
  const sessionScript = sessionFixture.scenarios.flatMap((scenario) => [
    "N",
    ...scenario.records.map((record) => {
      const [kind, value] = Object.entries(record.input)[0];
      const columns =
        kind === "state"
          ? [value.transport, value.signal, "", ""]
          : kind === "notification"
            ? [value.transport, base64(value.method), base64(value.params), value.now]
            : kind === "resolve"
              ? [value.id, value.outcome, "", ""]
              : kind === "reply"
                ? [value.id, "", base64(value.text), value.now]
                : kind === "confirm"
                  ? [value, "", "", ""]
                  : typeof value === "string"
                    ? ["", value, "", ""]
                    : ["", "", "", ""];
      const expected =
        record.refused !== undefined
          ? `!${record.refused}`
          : (record.step ?? record.intent ?? record.token ?? record.lease ?? String(record.current));
      return [kind, ...columns, expected, record.view ?? ""].join("\t");
    }),
  ]);
  assert.equal(jvm.call("printerSessionChecks", sessionScript.join("\n")), 3820);
  // The Moonraker transport policy through the real JNI exports, then the
  // Kotlin wrapper.
  const policyFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/moonraker-policy-vectors.json", root)),
  );
  assert.equal(replayMoonrakerPolicy(projectJniCore(jvm.call), policyFixture).moonrakerPolicyAnswers, 805);
  const policyScript = [
    ...["endpoints", "paths", "credentials", "errors", "handshakes", "policies", "subscriptions", "methods"].flatMap(
      (section) => policyFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
    ...policyFixture.delays.map((c) => ["delays", c.requestJson, String(c.delayMs)].join("\t")),
  ];
  assert.equal(jvm.call("moonrakerPolicyChecks", policyScript.join("\n")), 805);
  // Printer storage through the real JNI exports, then the Kotlin wrapper.
  const storageFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-storage-vectors.json", root)),
  );
  assert.deepEqual(
    replayPrinterStorage(projectJniCore(jvm.call), storageFixture).printerStorageAnswers,
    [218, 1460, 326, 64],
  );
  const storageScript = [
    ...["plans", "finishes"].flatMap((section) =>
      storageFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
    ...storageFixture.reads.map((c) =>
      ["reads", c.operationJson, c.reply, c.replyJson, c.paths ?? "-"].join("\t"),
    ),
    ...storageFixture.sizes.map((c) => ["sizes", String(storageBytes(c.bytes)), c.replyJson].join("\t")),
  ];
  assert.equal(jvm.call("printerStorageChecks", storageScript.join("\n")), 2068);
  // Print history through the real JNI exports, then the Kotlin wrapper.
  const historyFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-history-vectors.json", root)),
  );
  assert.deepEqual(
    replayPrintHistory(projectJniCore(jvm.call), historyFixture).printHistoryAnswers,
    [290, 1363, 258, 55, 55, 76, 23, 39],
  );
  const historyScript = [
    ...["plans", "finishes", "jobViews", "totalsTexts", "pageViews"].flatMap((section) =>
      historyFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
    ...historyFixture.reads.map((c) => ["reads", c.operationJson, c.reply, c.replyJson, c.ids].join("\t")),
    ...historyFixture.durations.map((c) =>
      ["durations", String(historyNumber(c.seconds)), c.replyJson].join("\t"),
    ),
    ...historyFixture.filaments.map((c) =>
      ["filaments", String(historyNumber(c.millimetres)), c.replyJson].join("\t"),
    ),
  ];
  assert.equal(jvm.call("printHistoryChecks", historyScript.join("\n")), 2159);
  // The printer console through the real JNI exports, then the Kotlin wrapper.
  const consoleFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-console-vectors.json", root)),
  );
  assert.deepEqual(
    replayPrinterConsole(projectJniCore(jvm.call), consoleFixture).printerConsoleAnswers,
    [408, 44, 284, 51, 76, 33, 34, 28],
  );
  const consoleScript = [
    ...["assessments", "plans", "finishes", "invocations", "lines", "recents"].flatMap((section) =>
      consoleFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
    ...consoleFixture.reads.map((c) => ["reads", c.operationJson, c.reply, c.replyJson].join("\t")),
    ...consoleFixture.notifications.map((c) =>
      ["notifications", c.requestJson, c.params, c.replyJson].join("\t"),
    ),
  ];
  assert.equal(jvm.call("printerConsoleChecks", consoleScript.join("\n")), 958);
  // Printer cameras through the real JNI exports, then the Kotlin wrapper.
  const cameraFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-camera-vectors.json", root)),
  );
  assert.deepEqual(
    replayPrinterCamera(projectJniCore(jvm.call), cameraFixture).printerCameraAnswers,
    [62, 12, 462, 462, 616, 308, 154, 154],
  );
  const cameraScript = [
    ["listPlan", "", cameraFixture.listPlan.replyJson].join("\t"),
    ...["listFinishes", "snapshotPlans", "snapshotFailures", "mechanisms", "describes", "frameUrls"].flatMap(
      (section) => cameraFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
    ...cameraFixture.listReads.map((c) => ["listReads", c.requestJson, c.reply, c.replyJson].join("\t")),
    ...cameraFixture.pollIntervals.map((c) => ["pollIntervals", c.requestJson, String(c.intervalMs)].join("\t")),
  ];
  assert.equal(jvm.call("printerCameraChecks", cameraScript.join("\n")), 2231);
  // The printer directory through the real JNI exports, then the Kotlin wrapper.
  const directoryFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-directory-vectors.json", root)),
  );
  assert.deepEqual(
    replayPrinterDirectory(projectJniCore(jvm.call), directoryFixture).printerDirectoryAnswers,
    [37, 25, 160, 60, 44, 41, 15],
  );
  const directoryScript = [
    ...directoryFixture.loads.map((c) => ["loads", c.stored ?? "-", c.replyJson].join("\t")),
    ...directoryFixture.saves.map((c) => ["saves", c.requestJson, c.stored].join("\t")),
    ...["adds", "updates", "removes", "defaults", "adopts"].flatMap((section) =>
      directoryFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
  ];
  assert.equal(jvm.call("printerDirectoryChecks", directoryScript.join("\n")), 382);
  // Remembered credentials through the real JNI exports, then the Kotlin
  // wrapper and the sealed vault over a software key.
  const credentialsFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/printer-credentials-vectors.json", root)),
  );
  assert.deepEqual(
    replayRememberedCredentials(projectJniCore(jvm.call), credentialsFixture).rememberedCredentialsAnswers,
    [79, 63],
  );
  const credentialsScript = [
    ...credentialsFixture.loads.map((c) => ["loads", c.stored ?? "-", c.replyJson].join("\t")),
    ...credentialsFixture.saves.map((c) => ["saves", c.requestJson, c.stored ?? "-"].join("\t")),
  ];
  assert.equal(jvm.call("credentialsChecks", credentialsScript.join("\n")), 142);
  assert.equal(jvm.call("credentialVaultChecks"), 22);
  // The external slicer's policy through the real JNI exports, then the Kotlin wrapper.
  const slicerFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/external-slicer-vectors.json", root)),
  );
  assert.deepEqual(
    replayExternalSlicer(projectJniCore(jvm.call), slicerFixture).externalSlicerAnswers,
    [72, 230, 156, 247, 196, 44, 49],
  );
  const slicerScript = [
    ...slicerFixture.endpoints.map((c) =>
      ["endpoints", c.requestJson, c.endpointJson, c.attestationPlanJson, c.submitPlanJson].join("\t"),
    ),
    ...["attestations", "jobPlans", "submissions", "polls", "cancels", "artifacts"].flatMap((section) =>
      slicerFixture[section].map((c) => [section, c.requestJson, c.replyJson].join("\t")),
    ),
  ];
  assert.equal(jvm.call("externalSlicerChecks", slicerScript.join("\n")), 996);
  // One plate for an external slicer through the real JNI exports, then the Kotlin wrapper.
  const plateCases = plateProjectionCases(
    JSON.parse(await readFile(new URL("testdata/cross-platform/plate-projection-vectors.json", root))),
    model,
  );
  assert.deepEqual(replayPlateProjection(projectJniCore(jvm.call), plateCases).plateProjectionAnswers, [16, 3, 19]);
  const plateScript = plateCases.map((c) =>
    [
      c.stateJson,
      c.plateIdJson,
      c.omittedJson,
      JSON.stringify(
        c.result.error === undefined
          ? { stateJson: c.result.stateJson, sourceHash: c.result.sourceHash, assetIds: JSON.parse(c.result.assetIdsJson) }
          : { error: plateProjectionCode(c.result.error), message: JSON.parse(c.result.messageJson) },
      ),
      c.overridesJson,
    ].join("\t"),
  );
  assert.equal(jvm.call("plateProjectionChecks", plateScript.join("\n")), 57);
  // Catalog profiles turned into the project's slicing configuration through
  // the raw exports, then the Kotlin wrapper against those verified replies.
  const slicingFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/slicing-configuration-vectors.json", root)),
  );
  const verified = { configurations: [], nextStates: [] };
  const sliced = await replaySlicingConfiguration(
    projectJniCore(jvm.call),
    slicingFixture,
    catalogBytes,
    undefined,
    layout,
    stagingLayout.version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    verified,
  );
  assert.deepEqual(sliced.slicingConfigurationAnswers, [377, 27, 43, 43, 46, 96, 27]);
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  /** What the Kotlin wrapper must answer: a payload by its digest, or the reply itself. */
  const expect = (reply, payload, key) => {
    const value = JSON.parse(reply);
    if (typeof value[payload] === "string") return JSON.stringify({ [key]: digest(value[payload]) });
    if (payload in value) return JSON.stringify({ none: true });
    return reply;
  };
  const slicingScript = [
    ...Object.entries(slicingFixture.states).map(([name, state]) => `T\t${name}\t${state}`),
    ...slicingFixture.choices.map((c) => `C\t${c.catalog}\t${c.requestJson}\t${c.replyJson}`),
    ...slicingFixture.matches.map((c) => `M\t${c.requestJson}\t${c.replyJson}`),
    ...slicingFixture.selections.map((c) => `S\t${c.catalog}\t${c.kind}\t${c.requestJson}\t${c.replyJson}`),
    ...slicingFixture.configurations.map(
      (c, i) =>
        `G\t${c.catalog}\t${JSON.stringify(c.live)}\t${c.state}\t${expect(verified.configurations[i], "configurationJson", "configurationSha256")}`,
    ),
    ...slicingFixture.nextStates.map(
      (c, i) =>
        `N\t${"state" in c ? `state:${c.state}` : `after:${c.after}`}\t${"configuration" in c ? `index:${c.configuration}` : `json:${c.configurationJson}`}\t${JSON.stringify(c.autoPairs)}\t${JSON.stringify(c.words)}\t${expect(verified.nextStates[i], "stateJson", "stateSha256")}`,
    ),
    ...slicingFixture.commits.map(
      (c) =>
        `K\t${c.catalog}\t${c.state}\t${JSON.stringify(c.live)}\t${JSON.stringify(c.autoPairs)}\t${JSON.stringify(c.words)}\t${c.expectedJson}`,
    ),
    ...slicingFixture.slotEdits.map((c) => `E\t${c.catalog}\t${c.requestJson}\t${c.replyJson}`),
    ...slicingFixture.projectSlots.map((c) => `P\t${c.state}\t${c.requestJson}\t${c.replyJson}`),
  ];
  assert.equal(
    jvm.call("slicingConfigurationChecks", catalogBytes, slicingFixture.syntheticCatalogJson, slicingScript.join("\n")),
    591,
  );
  // The Moonraker transport through the real JNI exports, then the Kotlin
  // wrapper: step and state, or reply, for each input.
  const transportFixture = JSON.parse(
    await readFile(new URL("testdata/cross-platform/moonraker-transport-vectors.json", root)),
  );
  assert.deepEqual(
    Object.values(replayMoonrakerTransport(projectJniCore(jvm.call), transportFixture)),
    [88, 2533, 94, 20, 64],
  );
  const transportScript = transportFixture.scenarios.flatMap((scenario) =>
    scenario.records.map((record) => {
      const [kind, value] = Object.entries(record.input)[0];
      const columns =
        kind === "connect"
          ? ["", value.signal, ""]
          : kind === "resolve"
            ? [value.id, value.outcome, ""]
            : kind === "text"
              ? [value.id, "", base64(value.text)]
              : kind === "socketMessage"
                ? [value.socket, "", base64(value.text)]
                : typeof value === "number"
                  ? [value, "", ""]
                  : typeof value === "string"
                    ? ["", value, ""]
                    : value === null
                      ? ["", "null", ""]
                      : ["", "", ""];
      const subscribing = kind === "subscription" && value !== null;
      const expected =
        kind === "credentials"
          ? (record.refused ?? "")
          : subscribing
            ? record.refused !== undefined
              ? `{"refused":${record.refused}}`
              : `{"step":${record.step}}`
            : record.refused !== undefined
              ? `!${record.refused}`
              : (record.reply ?? record.step ?? "");
      const state =
        record.hasApiKey !== undefined ? `${record.hasApiKey},${record.hasBearerToken}` : (record.state ?? "");
      const results = (record.results ?? []).map(({ task, text }) => `${task}:${base64(text)}`).join(",");
      const params = (record.params ?? []).map(base64).join(",");
      return [kind, ...columns, record.now, expected, state, results, params].join("\t");
    }),
  );
  assert.equal(jvm.call("moonrakerTransportChecks", transportScript.join("\n")), 2648);
  const savedQueryText = Array.from(ownedQueryText);
  await jvm.close();
  assert.deepEqual(Array.from(ownedQueryText), savedQueryText);
  assert.deepEqual(savedQueryText, ownedQueryExpected);
  assert.deepEqual(Array.from(owned), fixture.traces.at(-1).asset.bytes);
  const report = {
    profile,
    ...result,
    ...staged,
    stagingOwnerChecks,
    ...boundaries,
    ...queries,
    archives,
    models,
    actorImportChecks,
    projectWorkspaceChecks,
    projectEditChecks,
    projectRecoveryChecks,
    documentOwnersChecks,
    slicingChoiceChecks,
    localSliceChecks,
    sliceStatusChecks,
    workspaceBeds,
    workspaceBedChecks,
    transformFields,
    transformFieldChecks,
    placementEditChecks,
    transformEditChecks,
    ...primitives,
    primitiveChecks,
    ...paintTool,
    paintToolChecks,
    createEditChecks,
    filamentAssignment,
    filamentChecks,
    kotlinStagedWorks,
    stagedRecordChecks,
    projectSceneChecks,
    accessibilityChecks,
    paintChecks,
    scenePaintChecks,
    sceneColourChecks,
    actorArchiveChecks,
    providerDocumentChecks,
    ...preflights,
    actorPreflightChecks,
    ...catalogs,
    catalogChecks,
    ...libraries,
    libraryChecks,
    ...editors,
    editorChecks,
    ...projections,
    ...capabilities,
    capabilityChecks,
    ...renders,
    renderChecks,
    ...regions,
    facetRegionChecks,
    ownedQueryTextUnits: ownedQueryText.length,
    ownedBytes: owned.byteLength,
    hostJniSha256: createHash("sha256")
      .update(
        await readFile(
          new URL(`core/target/${profile}/liborcaxr_android.so`, root),
        ),
      )
      .digest("hex"),
  };
  await writeFile(
    new URL(
      `tools/cross-platform/results/project-jni-host-${profile}.json`,
      root,
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await jvm.close();
}
