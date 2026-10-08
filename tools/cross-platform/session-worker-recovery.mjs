// A project session hosted by the shared Rust core in a real worker, under
// the browser's supervisor: edits are acknowledged across the worker
// boundary, a checkpoint is adopted only at an acknowledged identity, and
// when the worker hangs or exits every operation in flight is rejected as of
// unknown outcome. Recovery opens a new generation from the acknowledged
// checkpoint — not the later edits — and the old incarnation stays dead;
// disposal stops the worker. Every distinct session-trace state runs once.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ProjectSessionClientError } from "../../web/src/project/ProjectSessionClient.ts";
import {
  ProjectSessionSupervisor,
  ProjectSessionSupervisorError,
} from "../../web/src/project/ProjectSessionWorker.ts";

const root = new URL("../../", import.meta.url);
const sessions = JSON.parse(
  await readFile(
    new URL("testdata/cross-platform/project-session-vectors.json", root),
    "utf8",
  ),
);
const loader = fileURLToPath(
  new URL("web/node_modules/tsx/dist/loader.mjs", root),
);
const host = new URL("session-worker-host.mjs", import.meta.url);
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const text = (u) => String.fromCharCode(...u);
const LIMITS = {
  documentNodes: 1_000_000,
  documentTextUnits: 2_000_000,
  numberBytes: 1024,
  depth: 128,
  assetBytes: 16 * 1024 * 1024,
  totalAssetBytes: 32 * 1024 * 1024,
  historyEntries: 100,
  historyBytes: 32 * 1024 * 1024,
};

let nonce = 0x5e55;
const workers = [];
function spawn() {
  const worker = new Worker(host, { execArgv: ["--import", loader] });
  workers.push(worker);
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    listen({ message, failure }) {
      worker.on("message", message);
      worker.on("messageerror", () => failure("an undeliverable message"));
      worker.on("error", (error) => failure(error.message));
      worker.on("exit", (code) => failure(`the worker exited (${code})`));
    },
    terminate: () => void worker.terminate(),
  };
}
const unknown = (error) =>
  error instanceof ProjectSessionClientError && error.code === "outcomeUnknown";
async function rejected(promise, test, label) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error && test(error), `${label}: ${error}`);
}

const distinct = [];
for (const trace of sessions.traces)
  if (
    !distinct.some((d) => d.stateJson === trace.stateJson) &&
    JSON.parse(trace.stateJson).id.length < 1024
  )
    distinct.push(trace);

let recoveries = 0,
  unknownOutcomes = 0,
  acknowledged = 0;
for (const [index, fixture] of distinct.entries()) {
  const label = fixture.name;
  const supervisor = new ProjectSessionSupervisor({
    spawn,
    generation: () => [index, ++nonce, 0x80000000, 0xffffffff],
    schemaVersion: 1,
    limits: {
      ...LIMITS,
      historyEntries: fixture.options.maxEntries ?? 100,
      historyBytes: fixture.options.maxEstimatedBytes ?? 32 * 1024 * 1024,
    },
  });
  await supervisor.start({
    revision: fixture.initial.snapshot.revision,
    semanticHash: fixture.initial.snapshot.hash,
    assetFingerprint: fixture.initial.assets,
    stateJson: fixture.stateJson,
    assets: [Uint8Array.from(fixture.asset.bytes)],
  });
  const query = async () => {
    const receipt = await supervisor.submit({ query: {} }).result;
    return receipt.acknowledged.guard;
  };
  const rename = async (name) => {
    const receipt = await supervisor.submit({
      execute: {
        guard: await query(),
        intent: {
          version: 1,
          command: { renameProject: { name: units(name) } },
        },
      },
    }).result;
    assert.ok(receipt.acknowledged.changed, `${label}: ${name} applies`);
    acknowledged++;
    return receipt.acknowledged.guard;
  };

  // An acknowledged edit, then a checkpoint at its identity.
  const kept = await rename("Before the checkpoint ✓");
  const identity = await supervisor.checkpoint();
  assert.deepEqual(
    [identity.revision, identity.semanticHash],
    [kept.revision, text(kept.semanticHash)],
  );
  // A later acknowledged edit the checkpoint does not hold.
  const later = await rename("After the checkpoint");
  assert.notEqual(text(later.semanticHash), identity.semanticHash);

  // The worker fails with three operations in flight: hanging, then
  // stopped by its owner, or exiting on its own.
  const worker = workers.at(-1);
  const fault = index % 2 ? "exit" : "hang";
  const pending = [];
  if (fault === "hang") worker.postMessage("hang");
  for (let n = 0; n < 3; n++)
    pending.push(
      supervisor.submit({
        execute: {
          guard: later,
          intent: {
            version: 1,
            command: { renameProject: { name: units(`Lost ${n}`) } },
          },
        },
      }).result,
    );
  const before = supervisor.generation;
  if (fault === "exit") worker.postMessage("exit");
  else worker.terminate();
  for (const result of pending)
    await rejected(result, unknown, `${label}: in flight after ${fault}`);
  assert.ok(supervisor.failed);
  await rejected(
    supervisor.submit({ query: {} }).result,
    unknown,
    `${label}: a failed worker takes no work`,
  );
  await rejected(
    supervisor.checkpoint(),
    (e) => unknown(e) || e?.name === "SessionWorkerFailure",
    `${label}: no checkpoint from a failed worker`,
  );

  // Recovery: a new generation, from the acknowledged checkpoint only.
  const report = await supervisor.recover();
  recoveries++;
  unknownOutcomes += report.unknownOutcomes;
  assert.equal(report.unknownOutcomes, 3, `${label}: unknown outcomes`);
  assert.notDeepEqual(report.generation, before);
  assert.equal(report.checkpoint.semanticHash, identity.semanticHash);
  const recovered = await query();
  assert.equal(text(recovered.semanticHash), identity.semanticHash);
  await supervisor.checkpoint();
  assert.equal(
    JSON.parse(supervisor.acknowledgedCheckpoint().stateJson).name,
    "Before the checkpoint ✓",
    `${label}: the recovered document is the acknowledged one`,
  );
  // The recovered session edits normally.
  await rename("After recovery");

  // A recovery without a failure refuses; disposal stops the worker and
  // rejects anything after it.
  await rejected(
    supervisor.recover(),
    (e) =>
      e instanceof ProjectSessionSupervisorError && e.code === "not-failed",
    `${label}: recovery needs a failure`,
  );
  const live = workers.at(-1);
  const exited = new Promise((resolve) => live.once("exit", resolve));
  await supervisor.dispose();
  await exited;
  await rejected(
    supervisor.submit({ query: {} }).result,
    (e) => e instanceof ProjectSessionSupervisorError && e.code === "disposed",
    `${label}: disposed`,
  );
}
for (const worker of workers) await worker.terminate();
console.log(
  JSON.stringify({
    states: distinct.length,
    recoveries,
    unknownOutcomes,
    acknowledged,
  }),
);
