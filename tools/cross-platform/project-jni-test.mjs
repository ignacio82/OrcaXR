import { replayProjectDocuments } from "./project-document-replay.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { startProjectJni, projectJniCore } from "./project-jni-bridge.mjs";
import { replayProject } from "./project-wasm-replay.mjs";
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
  assert.equal(actorPreparationChecks, 16);
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
