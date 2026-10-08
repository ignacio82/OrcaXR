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
import { projectJniBoundaries } from "./project-jni-boundaries.mjs";
import { replayProjectQueries } from "./project-query-replay.mjs";
import { replayStagedProject } from "./project-staged-replay.mjs";
import { projectStagedBoundaries } from "./project-staged-boundaries.mjs";
import { projectClipboardBoundaries } from "./project-clipboard-boundaries.mjs";
import { stagedCommandJson } from "./project-staged-replay.mjs";
import { replayArchives, archiveCases } from "./archive-wasm-replay.mjs";
import { replayModelImports } from "./model-import-replay.mjs";
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
  );
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
    { clipboardOwnerChecks, actorClipboardChecks, actorClipboardReplays, documentOwnerChecks, actorChecks, actorPreparationChecks, actorExportChecks, actorCapturedChecks },
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
    [259, 57, 209],
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
  assert.equal(renderChecks, 41);
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
    [strokes.paintStrokeOpens, strokes.paintStrokeSamples, strokes.paintStrokeOverlays, strokes.paintStrokeCommits, strokes.paintStrokeRefusals, strokes.paintOverlayPackets],
    [11, 18, 5, 11, 11, 44],
  );
  const unitsText = (u) => String.fromCharCode(...u);
  const paintStrokeChecks = jvm.call(
    "paintStrokeChecks",
    strokeFixture.stateJson,
    Uint8Array.from(strokeFixture.assets[0].bytes),
    Uint8Array.from(strokeFixture.assets[1].bytes),
    strokeFixture.steps
      .map((s) =>
        "preview" in s
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
  assert.equal(paintStrokeChecks, 151);
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
