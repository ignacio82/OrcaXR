import { replayProjectDocuments } from "./project-document-replay.mjs";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isMainThread, Worker, parentPort } from "node:worker_threads";
import { replayProject } from "./project-wasm-replay.mjs";
import { replayPreflights } from "./project-preflight-replay.mjs";
import { replayCatalogs } from "./catalog-replay.mjs";
import { replayLibrary } from "./library-replay.mjs";
import { replayEditor } from "./editor-replay.mjs";
import { replayProjection } from "./projection-replay.mjs";
import { replaySettingsPanel } from "./settings-panel-replay.mjs";
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
import { replayObjectTree } from "./object-tree-replay.mjs";
import { replayPrintJobStatus } from "./print-job-status-replay.mjs";
import { replayPrinterControl } from "./printer-control-replay.mjs";
import { replayPrinterTools } from "./printer-tools-replay.mjs";
import { replayPrinterPreparation } from "./printer-preparation-replay.mjs";
import { replayPrinterWorkflow } from "./printer-workflow-replay.mjs";
import { replayPrinterSession } from "./printer-session-replay.mjs";
import { replayMoonrakerPolicy } from "./moonraker-policy-replay.mjs";
import { replayMoonrakerTransport } from "./moonraker-transport-replay.mjs";
import { replayPrinterStorage } from "./printer-storage-replay.mjs";
import { replayPrintHistory } from "./printer-history-replay.mjs";
import { replayPrinterConsole } from "./printer-console-replay.mjs";
import { replayPrinterCamera } from "./printer-camera-replay.mjs";
import { replayPrinterDirectory } from "./printer-directory-replay.mjs";
import { replayRememberedCredentials } from "./printer-credentials-replay.mjs";
import { replayExternalSlicer } from "./external-slicer-replay.mjs";
import { plateProjectionCases, replayPlateProjection } from "./plate-projection-replay.mjs";
import { replaySlicingConfiguration } from "./slicing-configuration-replay.mjs";
import { replayWorkspaceBeds } from "./workspace-bed-replay.mjs";
import { SLICE_SIDECAR_ANSWERS, replaySliceOutputs } from "./slice-output-replay.mjs";
import { replayTransformFields } from "./transform-field-replay.mjs";
import { replayTransformGizmo } from "./transform-gizmo-replay.mjs";
import { replayActionPresentation } from "./action-presentation-replay.mjs";
import { replayPaintTool } from "./paint-tool-replay.mjs";
import { replayPrimitives } from "./primitive-replay.mjs";
import { replaySplitSources } from "./split-source-replay.mjs";
import { replayFilamentAssignment } from "./filament-assignment-replay.mjs";
import { replayVirtualFilaments } from "./virtual-filament-replay.mjs";
import { replayAssembly } from "./assembly-replay.mjs";
import { projectBoundaries } from "./project-wasm-boundaries.mjs";
import { replayProjectQueries } from "./project-query-replay.mjs";
import { replayStagedProject } from "./project-staged-replay.mjs";
import { projectStagedBoundaries } from "./project-staged-boundaries.mjs";
import { projectClipboardBoundaries } from "./project-clipboard-boundaries.mjs";
import { replayArchives, archiveCases, replayHostileArchives } from "./archive-wasm-replay.mjs";
import { replayModelImports } from "./model-import-replay.mjs";
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("Project WASM worker deadline exceeded")),
        900_000,
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(Error(`Project worker exited ${code}`));
      });
    });
    await worker.terminate();
    assert.ok(result.owned instanceof Uint8Array);
    // Browser-derived Open expectations plus native Save round trips; the
    // replay checks every case and the Save refusal set itself.
    assert.deepEqual(
      [result.archives.cases, result.archives.accepted, result.archives.saves],
      [1341, 1225, 1223],
    );
    // Every plate of every opened archive projected through the export
    // capture as the state-document exchange projects it (unprintable ones
    // refused), and one plate archive per project reopened.
    assert.deepEqual(
      [result.archives.plates, result.archives.plateRefusals, result.archives.plateExchanges, result.archives.plateArchives],
      [1403, 185, 1403, 1225],
    );
    assert.deepEqual(result.archives.plateArchiveRefusals, []);
    // Hostile archives: the browser's acceptance, format, warnings and state;
    // no refusal reaches an edited live session.
    assert.deepEqual(
      [result.hostile.hostileArchives, result.hostile.hostileAccepted, result.hostile.hostileRefused, result.hostile.hostileUntouched],
      [469, 55, 414, 414],
    );
    assert.deepEqual(
      [result.catalogReplies, result.catalogRefusals],
      [506, 12],
    );
    assert.deepEqual(
      [result.libraryReplies, result.libraryRefusals],
      [425, 184],
    );
    assert.deepEqual(
      [result.editorReplies, result.editorRefusals],
      [14938, 78],
    );
    assert.deepEqual(
      [result.projectionReplies, result.projectionRefusals],
      [281, 36],
    );
    // The generated settings panel over captured projects' editors, the
    // scoped panel's target texts and the height-range editor.
    assert.deepEqual(
      [
        result.panelViews,
        result.panelRows,
        result.panelEdits,
        result.panelStates,
        result.panelApplies,
        result.panelIntents,
        result.targetTexts,
        result.rangeProjections,
        result.rangeChecks,
        result.panelRefusals,
      ],
      [103, 154, 230, 72, 90, 31, 22, 15, 510, 20],
    );
    // Capability pages over live sessions, selected and edited.
    assert.deepEqual(
      [result.capabilityPages, result.capabilityRefusals],
      [384, 192],
    );
    // Render deltas over live sessions, edited and paged.
    assert.deepEqual(
      [result.renderPages, result.renderRefusals, result.renderRequests],
      [331, 60, 278],
    );
    // Facet region selection over a live session.
    assert.deepEqual(
      [result.facetRegionReplies, result.facetRegionRefusals],
      [136, 2],
    );
    // Paint strokes over a live session, staged and executed.
    assert.deepEqual(
      [
        result.paintStrokeOpens,
        result.paintStrokeSamples,
        result.paintStrokeOverlays,
        result.paintStrokeCommits,
        result.paintStrokeRefusals,
        result.paintOverlayPackets,
        result.paintFacetCaptures,
      ],
      [14, 22, 5, 14, 13, 51, 51],
    );
    // Ray picking over a live session, in both scenes.
    assert.deepEqual([result.picks, result.pickRefusals], [486, 1]);
    // Placement planning over a live session.
    assert.equal(result.placements, 90);
    // Arrangement and bed fill over a live session.
    assert.equal(result.arrangements, 35);
    // Wipe-tower auto-placement over a live session.
    assert.equal(result.wipeTowers, 27);
    // Volume splits over a live session, staged and executed.
    assert.deepEqual(
      [
        result.volumeSplitPreparations,
        result.volumeSplitRefusals,
        result.volumeSplitStages,
        result.volumeSplitsApplied,
        result.volumeSplitHistory,
      ],
      [19, 6, 22, 7, 6],
    );
    // Mesh simplification over a live session, staged and executed.
    assert.deepEqual(
      [
        result.simplifyPrepared,
        result.simplifyUnchanged,
        result.simplifyRefused,
        result.simplifyMeshes,
        result.simplifyStages,
        result.simplifyApplied,
        result.simplifyHistory,
      ],
      [34, 12, 8, 34, 9, 3, 3],
    );
    // Surface measurement over a live session: captures, picks and pairs.
    assert.deepEqual(
      [
        result.measureCaptures,
        result.measureCaptureRefusals,
        result.measurePicks,
        result.measurePickRefusals,
        result.measurePairs,
        result.measurePairRefusals,
      ],
      [6, 1, 1260, 10, 679, 1],
    );
    // Brim-ear detection and stranded checks over a live session.
    assert.deepEqual(
      [result.brimEarDetections, result.brimEarStrandedChecks],
      [40, 9],
    );
    // Text embossing: cuts, their meshes, and stages over a live session.
    assert.deepEqual(
      [
        result.embossPrepared,
        result.embossRefused,
        result.embossMeshes,
        result.embossStages,
        result.embossApplied,
        result.embossHistory,
      ],
      [21, 8, 21, 8, 3, 3],
    );
    // SVG parts: drawings cut from their file bytes, their meshes, and
    // stages over a live session.
    assert.deepEqual(
      [
        result.svgPrepared,
        result.svgRefused,
        result.svgMeshes,
        result.svgStages,
        result.svgApplied,
        result.svgHistory,
      ],
      [11, 11, 11, 15, 7, 4],
    );
    // Mesh renderer packets: replies and paged bytes off a live session.
    assert.deepEqual(
      [
        result.meshPacketsPrepared,
        result.meshPacketsRefused,
        result.meshPacketChunks,
      ],
      [53, 3, 8307],
    );
    // Assembly alignment: availability, alignments and explosions.
    assert.deepEqual(
      [
        result.assemblyAvailability,
        result.assemblyAlignments,
        result.assemblyPlanned,
        result.assemblyExplosions,
      ],
      [55, 525, 246, 7],
    );
    // The Objects tree: pages, selections and refusals on captured projects.
    assert.deepEqual(
      [
        result.objectTreeStates,
        result.objectTreePages,
        result.objectTreeSelections,
        result.objectTreeIgnored,
        result.objectTreeRefusals,
      ],
      [5, 367, 546, 21, 9],
    );
    // The print job status model: every trace step and the snapshot after it.
    assert.deepEqual(
      [result.printJobSnapshots, result.printJobIgnored, result.printJobRefusals],
      [790, 76, 7],
    );
    // Printer control: availability, plans, failures, summaries, guarded actions, holds.
    assert.deepEqual(
      [
        result.printerAvailability,
        result.printerChecks,
        result.printerFailures,
        result.printerSummaries,
        result.printerGuarded,
        result.printerHoldSteps,
      ],
      [45, 1125, 100, 1173, 540, 35],
    );
    // Tool usage scanned in appends, filament slots and tool mapping.
    assert.deepEqual(
      [result.printerToolUsages, result.printerSlotReplies, result.printerMappings],
      [100, 20, 1552],
    );
    // Print preparation and submission checks.
    assert.equal(result.printerPreparationAnswers, 929);
    // The submission workflow, step for step.
    assert.deepEqual(
      [result.printerWorkflowScenarios, result.printerWorkflowSteps, result.printerWorkflowRefusals],
      [402, 19688, 13],
    );
    // The printer session, step, view and reply for each.
    assert.deepEqual(
      [
        result.printerSessionScenarios,
        result.printerSessionSteps,
        result.printerSessionReplies,
        result.printerSessionRefusals,
      ],
      [80, 3254, 557, 8],
    );
    // The Moonraker transport policy.
    assert.equal(result.moonrakerPolicyAnswers, 805);
    // The Moonraker transport, step and state or reply for each input.
    assert.deepEqual(
      [
        result.moonrakerTransportScenarios,
        result.moonrakerTransportSteps,
        result.moonrakerTransportReplies,
        result.moonrakerTransportRefusals,
        result.moonrakerTransportTexts,
      ],
      [88, 2533, 94, 20, 64],
    );
    // Printer storage: plans, finished exchanges, replies read and sizes.
    assert.deepEqual(result.printerStorageAnswers, [218, 1460, 326, 64]);
    // Print history: plans, finishes, reads and what a panel shows.
    assert.deepEqual(result.printHistoryAnswers, [290, 1363, 258, 55, 55, 76, 23, 39]);
    // The printer console: assessments, plans, reads, invocations and lines.
    assert.deepEqual(result.printerConsoleAnswers, [408, 44, 284, 51, 76, 33, 34, 28]);
    // Printer cameras: listings, frame routes and failures, and descriptions.
    assert.deepEqual(result.printerCameraAnswers, [62, 12, 462, 462, 616, 308, 154, 154]);
    // The printer directory: loads, saves and every edit.
    assert.deepEqual(result.printerDirectoryAnswers, [37, 25, 160, 60, 44, 41, 15]);
    // Remembered credentials: stored records loaded and records saved.
    assert.deepEqual(result.rememberedCredentialsAnswers, [79, 63]);
    // The external slicer: endpoints, attestations, job plans, submissions,
    // polls, cancellations, artifacts and whether a download is fetched again.
    assert.deepEqual(result.externalSlicerAnswers, [72, 230, 156, 247, 196, 44, 49, 102]);
    // One plate for an external slicer: projected, refused, and its overrides.
    assert.deepEqual(result.plateProjectionAnswers, [16, 3, 19]);
    // Catalog profiles chosen and turned into the project's slicing
    // configuration: replies, refusals, session commits, their undos, every
    // commit case (refused and unchanged ones included), filament slot edits
    // and the slots captured projects describe.
    assert.deepEqual(result.slicingConfigurationAnswers, [377, 27, 43, 43, 46, 96, 27]);
    // Filament assignment: selections resolved, assignments planned, those
    // refused in the browser's words, and malformed requests.
    assert.deepEqual(result.filamentAssignmentAnswers, [36, 18, 15, 16]);
    // The virtual filament library: libraries shown, dialogs opened, their
    // validations, triangle points and Match searches, library edits planned,
    // those refused in the browser's words, and malformed requests.
    assert.deepEqual(result.virtualFilamentAnswers, [6, 27, 197, 12, 12, 51, 13, 20]);
    // The workspace bed: configurations, refusals and opened projects' plates.
    assert.deepEqual([result.beds, result.bedRefusals, result.projectBeds], [85, 14, 12]);
    // A slice's outputs: thumbnail lists, blocks, injections, cameras, slice
    // plans, refusals, and a session's plate drawn with Rust's own bytes.
    assert.deepEqual(result.sliceOutputAnswers, [68, 19, 100, 132, 44, 26, 3]);
    // What binds a slice's output: every plate's profile snapshot, output
    // bindings, external routes, refusals, a captured project's snapshots
    // and sidecars bound to them on this device's route.
    assert.deepEqual(result.sliceSidecarAnswers, SLICE_SIDECAR_ANSWERS);
    // The transform inspector's fields: reads, rotations, edits and refusals.
    assert.deepEqual(
      [result.fieldReads, result.rotations, result.fieldEdits, result.fieldRefusals],
      [101, 1720, 94, 19],
    );
    // The transform gizmo: geometry, pointer sequences and their steps, drag changes, refusals.
    assert.deepEqual(
      [result.gizmoGeometry, result.gizmoSequences, result.gizmoSteps, result.gizmoChanges, result.gizmoRefusals],
      [1, 564, 14161, 198, 34],
    );
    // How the shells arrange actions: palette searches, menu sections and toolbar runs, refusals.
    assert.deepEqual(
      [result.paletteSearches, result.actionArrangements, result.presentationRefusals],
      [1827, 92, 23],
    );
    // The painter's settings and paint colours: samples and refusals, malformed requests, colour sets.
    assert.deepEqual(
      [result.paintToolSamples, result.paintToolRefusals, result.paintColorSets],
      [427, 34, 775],
    );
    // Primitives and helper volumes: meshes (seven byte for byte), refusals,
    // plans in recorded states and malformed plans.
    assert.deepEqual(
      [result.primitiveMeshes, result.exactPrimitiveMeshes, result.primitiveMeshRefusals, result.primitivePlans, result.primitivePlanRefusals],
      [48, 7, 11, 37, 16],
    );
    // What a split would split: every instance under both splits and several
    // limits (61 refused in the workspace's words), and malformed requests.
    assert.deepEqual([result.splitSources, result.splitSourceRefusals], [118, 12]);
    // Live preflights through the binding, reply for reply.
    assert.deepEqual(
      [result.preflightCases, result.preflightItems, result.preflightRefusals],
      [7, 59, 42],
    );
    // The browser's model import transactions, including undo/redo.
    assert.deepEqual([result.models.cases, result.models.committed], [23, 17]);
    assert.ok(
      result.ownedQueryText instanceof Uint16Array &&
        result.ownedQueryText.length > 0,
    );
    assert.deepEqual(
      Array.from(result.ownedQueryText),
      result.ownedQueryExpected,
    );
    const fixture = JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/project-session-vectors.json", root),
      ),
    );
    assert.deepEqual(
      Array.from(result.owned),
      fixture.traces.at(-1).asset.bytes,
    );
    const { owned, ownedQueryText, ownedQueryExpected, ...values } = result;
    const report = {
      ...values,
      ownedBytes: owned.byteLength,
      ownedQueryTextUnits: ownedQueryText.length,
      node: process.version,
      wasmSha256: createHash("sha256")
        .update(
          await readFile(
            new URL("core/dist/project-wasm/orcaxr_core_bg.wasm", root),
          ),
        )
        .digest("hex"),
    };
    await mkdir(new URL("tools/cross-platform/results/", root), {
      recursive: true,
    });
    await writeFile(
      new URL("tools/cross-platform/results/project-wasm-node.json", root),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
} else {
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
  const fixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/project-session-vectors.json", root),
    ),
  );
  const layout = JSON.parse(
    await readFile(new URL("contracts/project-host.json", root)),
  );
  const { owned, ...metrics } = await replayProject(core, fixture, layout);
  metrics.archives = await replayArchives(
    core,
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
  metrics.hostile = await replayHostileArchives(
    core,
    layout,
    JSON.parse(await readFile(new URL("contracts/project-archive.json", root))),
    JSON.parse(await readFile(new URL("testdata/cross-platform/hostile-archive-vectors.json", root))),
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (text) => new Uint8Array(Buffer.from(text, "base64")),
  );
  const json = async (path) => JSON.parse(await readFile(new URL(path, root)));
  metrics.models = await replayModelImports(
    core,
    layout,
    await json("contracts/project-model-import.json"),
    await json("testdata/cross-platform/model-transaction-vectors.json"),
    await json("testdata/cross-platform/model-stage-vectors.json"),
    await json("testdata/cross-platform/model-import-vectors.json"),
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (path) => new Uint8Array(readFileSync(new URL(path, root))),
    (text) => new Uint8Array(Buffer.from(text, "base64")),
  );
  const queryLayout = JSON.parse(
    await readFile(new URL("contracts/project-query.json", root)),
  );
  const staged = await replayStagedProject(
    core,
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
      core,
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
    projectClipboardBoundaries(
      core,
      JSON.parse(
        await readFile(
          new URL(
            "testdata/cross-platform/project-staged-session-vectors.json",
            root,
          ),
        ),
      ),
      layout,
      JSON.parse(
        await readFile(new URL("contracts/project-staging.json", root)),
      ),
      queryLayout,
    ),
    projectStagedBoundaries(
      core,
      fixture.traces[0],
      layout,
      JSON.parse(
        await readFile(new URL("contracts/project-staging.json", root)),
      ),
    ),
  );
  const model = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/project-model-vectors.json", root),
    ),
  );
  const timestamps = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/validation-value-vectors.json", root),
    ),
  );
  const boundaries = projectBoundaries(
    core,
    JSON.parse(model.factories[0].stateJson),
    layout,
    timestamps.timestamps,
  );
  const queryFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/project-query-vectors.json", root),
    ),
  );
  const queries = replayProjectQueries(core, queryFixture, queryLayout);
  const preflights = replayPreflights(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/slice-profile-vectors.json", root),
      ),
    ),
    layout,
    fixture.generation,
  );
  const catalogFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/preset-catalog-vectors.json", root),
    ),
  );
  const catalogBytes = new Uint8Array(
    await readFile(new URL("web/public/profiles/catalog.json", root)),
  );
  // The bundled catalog through the browser's own collation callback.
  const english = new Intl.Collator("en");
  const text = (units) => String.fromCharCode(...units);
  const collator = {
    compare: (left, right) => english.compare(text(left), text(right)),
  };
  const catalogs = replayCatalogs(core, catalogFixture, catalogBytes, collator);
  // Every preset library scenario, from catalog and stored bytes.
  const libraryFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/preset-library-vectors.json", root),
    ),
  );
  const libraries = replayLibrary(core, libraryFixture, catalogBytes, [
    collator,
  ]);
  // The settings editor through the browser's own collation and folding.
  const editorFixture = JSON.parse(
    await readFile(
      new URL("testdata/cross-platform/settings-editor-vectors.json", root),
    ),
  );
  const projections = replayProjection(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/settings-projection-vectors.json", root),
      ),
    ),
    layout,
    fixture.generation,
    [collator, {
      fold: (units) => {
        const s = String.fromCharCode(...units)
          .normalize("NFKD")
          .toLocaleLowerCase("en-US");
        return Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
      },
    }],
  );
  const settingsPanel = replaySettingsPanel(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/settings-panel-vectors.json", root)),
    ),
    layout,
    fixture.generation,
    [collator, {
      fold: (units) => {
        const s = String.fromCharCode(...units)
          .normalize("NFKD")
          .toLocaleLowerCase("en-US");
        return Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
      },
    }],
  );
  const capabilities = replayCapabilities(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/capability-exchange-vectors.json", root),
      ),
    ),
    layout,
  );
  const renders = replayRender(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/render-delta-vectors.json", root),
      ),
    ),
    layout,
  );
  const regions = replayFacetRegions(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/facet-region-exchange-vectors.json", root),
      ),
    ),
    layout,
  );
  const strokes = await replayPaintStrokes(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/paint-stroke-vectors.json", root),
      ),
    ),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root)))
      .version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  const picks = replayPicks(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/pick-vectors.json", root)),
    ),
    layout,
  );
  const placed = replayPlacements(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/placement-vectors.json", root),
      ),
    ),
    layout,
  );
  const arranged = replayArrangements(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/arrange-vectors.json", root)),
    ),
    layout,
  );
  const towers = replayWipeTowers(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/wipe-tower-vectors.json", root),
      ),
    ),
    layout,
  );
  const splits = await replayVolumeSplits(
    core,
    JSON.parse(
      await readFile(
        new URL("testdata/cross-platform/volume-split-vectors.json", root),
      ),
    ),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root)))
      .version,
  );
  const simplified = await replaySimplify(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/simplify-vectors.json", root)),
    ),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root)))
      .version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  const measured = replayMeasure(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/measure-vectors.json", root)),
    ),
    layout,
  );
  const brimEars = replayBrimEars(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/brim-ear-vectors.json", root)),
    ),
    layout,
  );
  const embossed = await replayEmboss(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/emboss-vectors.json", root)),
    ),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root)))
      .version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  const svgParts = await replaySvgParts(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/svg-part-vectors.json", root)),
    ),
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root)))
      .version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (text) => Uint8Array.from(Buffer.from(text, "base64")),
  );
  const packets = await replayMeshPackets(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/mesh-packet-vectors.json", root)),
    ),
    layout,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  const assembled = replayAssembly(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/assembly-vectors.json", root)),
    ),
  );
  const trees = replayObjectTree(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/object-tree-vectors.json", root)),
    ),
    layout,
    fixture.generation,
    {
      fold: (units) => {
        const s = String.fromCharCode(...units)
          .normalize("NFKD")
          .toLocaleLowerCase("en-US");
        return Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
      },
    },
  );
  const printJobs = replayPrintJobStatus(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/print-job-status-vectors.json", root)),
    ),
  );
  const printerControl = replayPrinterControl(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-control-vectors.json", root)),
    ),
  );
  const printerTools = replayPrinterTools(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-tools-vectors.json", root)),
    ),
  );
  const printerPreparation = replayPrinterPreparation(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-preparation-vectors.json", root)),
    ),
  );
  const printerWorkflow = replayPrinterWorkflow(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-workflow-vectors.json", root)),
    ),
  );
  const printerSession = replayPrinterSession(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-session-vectors.json", root)),
    ),
  );
  const moonrakerPolicy = replayMoonrakerPolicy(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/moonraker-policy-vectors.json", root)),
    ),
  );
  const moonrakerTransport = replayMoonrakerTransport(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/moonraker-transport-vectors.json", root)),
    ),
  );
  const printerStorage = replayPrinterStorage(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-storage-vectors.json", root)),
    ),
  );
  const printHistory = replayPrintHistory(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-history-vectors.json", root)),
    ),
  );
  const printerConsole = replayPrinterConsole(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-console-vectors.json", root)),
    ),
  );
  const printerCamera = replayPrinterCamera(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-camera-vectors.json", root)),
    ),
  );
  const printerDirectory = replayPrinterDirectory(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-directory-vectors.json", root)),
    ),
  );
  const rememberedCredentials = replayRememberedCredentials(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/printer-credentials-vectors.json", root)),
    ),
  );
  const externalSlicer = replayExternalSlicer(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/external-slicer-vectors.json", root)),
    ),
  );
  const plateProjection = replayPlateProjection(
    core,
    plateProjectionCases(
      JSON.parse(await readFile(new URL("testdata/cross-platform/plate-projection-vectors.json", root))),
      JSON.parse(await readFile(new URL("testdata/cross-platform/project-model-vectors.json", root))),
    ),
  );
  const slicingConfiguration = await replaySlicingConfiguration(
    core,
    JSON.parse(
      await readFile(new URL("testdata/cross-platform/slicing-configuration-vectors.json", root)),
    ),
    catalogBytes,
    collator,
    layout,
    JSON.parse(await readFile(new URL("contracts/project-staging.json", root))).version,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  const workspaceBeds = replayWorkspaceBeds(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/workspace-bed-vectors.json", root))),
    layout,
  );
  const sliceOutputs = await replaySliceOutputs(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/slice-output-vectors.json", root))),
    JSON.parse(await readFile(new URL("testdata/cross-platform/slice-sidecar-vectors.json", root))),
    JSON.parse(await readFile(new URL("testdata/cross-platform/placement-vectors.json", root))),
    layout,
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    (text) => Buffer.from(text, "base64"),
  );
  const transformFields = replayTransformFields(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/transform-field-vectors.json", root))),
  );
  const transformGizmo = await replayTransformGizmo(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/transform-gizmo-vectors.json", root))),
    async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  );
  const actionPresentation = replayActionPresentation(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/action-presentation-vectors.json", root))),
  );
  const paintTool = replayPaintTool(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/paint-tool-vectors.json", root))),
  );
  const primitives = replayPrimitives(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/primitive-vectors.json", root))),
    layout,
    (text) => Uint8Array.from(Buffer.from(text, "base64")),
  );
  const splitSources = replaySplitSources(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/model-tool-vectors.json", root))),
    layout,
    (text) => Uint8Array.from(Buffer.from(text, "base64")),
  );
  const filamentAssignment = replayFilamentAssignment(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/filament-assignment-vectors.json", root))),
    layout,
    fixture.generation,
  );
  const virtualFilaments = replayVirtualFilaments(
    core,
    JSON.parse(await readFile(new URL("testdata/cross-platform/virtual-filament-vectors.json", root))),
    layout,
    fixture.generation,
  );
  const editors = replayEditor(core, editorFixture, [collator, {
    fold: (units) => {
      const s = String.fromCharCode(...units)
        .normalize("NFKD")
        .toLocaleLowerCase("en-US");
      return Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
    },
  }]);
  parentPort.postMessage(
    {
      ...metrics,
      ...staged,
      ...boundaries,
      ...queries,
      ...preflights,
      ...catalogs,
      ...libraries,
      ...editors,
      ...projections,
      ...capabilities,
      ...renders,
      ...regions,
      ...strokes,
      ...picks,
      ...placed,
      ...arranged,
      ...towers,
      ...splits,
      ...simplified,
      ...measured,
      ...brimEars,
      ...embossed,
      ...svgParts,
      ...packets,
      ...assembled,
      ...trees,
      ...printJobs,
      ...printerControl,
      ...printerTools,
      ...printerPreparation,
      ...printerWorkflow,
      ...printerSession,
      ...moonrakerPolicy,
      ...moonrakerTransport,
      ...printerStorage,
      ...printHistory,
      ...printerConsole,
      ...printerCamera,
      ...printerDirectory,
      ...rememberedCredentials,
      ...externalSlicer,
      ...plateProjection,
      ...slicingConfiguration,
      ...workspaceBeds,
      ...sliceOutputs,
      ...transformFields,
      ...transformGizmo,
      ...actionPresentation,
      ...settingsPanel,
      ...paintTool,
      ...primitives,
      ...splitSources,
      ...filamentAssignment,
      ...virtualFilaments,
      owned,
    },
    [owned.buffer, queries.ownedQueryText.buffer],
  );
}
