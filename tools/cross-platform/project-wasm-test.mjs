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
import { projectBoundaries } from "./project-wasm-boundaries.mjs";
import { replayProjectQueries } from "./project-query-replay.mjs";
import { replayStagedProject } from "./project-staged-replay.mjs";
import { projectStagedBoundaries } from "./project-staged-boundaries.mjs";
import { projectClipboardBoundaries } from "./project-clipboard-boundaries.mjs";
import { replayArchives, archiveCases } from "./archive-wasm-replay.mjs";
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
    // Capability pages over live sessions, selected and edited.
    assert.deepEqual(
      [result.capabilityPages, result.capabilityRefusals],
      [366, 183],
    );
    // Render deltas over live sessions, edited and paged.
    assert.deepEqual(
      [result.renderPages, result.renderRefusals, result.renderRequests],
      [259, 57, 209],
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
      ],
      [11, 18, 5, 11, 11, 44],
    );
    // Ray picking over a live session, in both scenes.
    assert.deepEqual([result.picks, result.pickRefusals], [486, 1]);
    // Placement planning over a live session.
    assert.equal(result.placements, 67);
    // Arrangement and bed fill over a live session.
    assert.equal(result.arrangements, 28);
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
      [16, 6, 19, 5, 6],
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
    // Live preflights through the binding, reply for reply.
    assert.deepEqual(
      [result.preflightCases, result.preflightItems, result.preflightRefusals],
      [7, 59, 42],
    );
    // The browser's model import transactions, including undo/redo.
    assert.deepEqual([result.models.cases, result.models.committed], [21, 15]);
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
      owned,
    },
    [owned.buffer, queries.ownedQueryText.buffer],
  );
}
