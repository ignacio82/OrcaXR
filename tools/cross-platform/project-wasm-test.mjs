import { replayProjectDocuments } from "./project-document-replay.mjs";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isMainThread, Worker, parentPort } from "node:worker_threads";
import { replayProject } from "./project-wasm-replay.mjs";
import { projectBoundaries } from "./project-wasm-boundaries.mjs";
import { replayProjectQueries } from "./project-query-replay.mjs";
import { replayStagedProject } from "./project-staged-replay.mjs";
import { projectStagedBoundaries } from "./project-staged-boundaries.mjs";
import { projectClipboardBoundaries } from "./project-clipboard-boundaries.mjs";
const root = new URL("../../", import.meta.url);
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("Project WASM worker deadline exceeded")),
        120_000,
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(Error(`Project worker exited ${code}`));
      });
    });
    await worker.terminate();
    assert.ok(result.owned instanceof Uint8Array);
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
  parentPort.postMessage(
    { ...metrics, ...staged, ...boundaries, ...queries, owned },
    [owned.buffer, queries.ownedQueryText.buffer],
  );
}
