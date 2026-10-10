// The real external slicer server (`server/server.js`) on a thread of its own,
// headless: the JNI bridge blocks the main thread while the JVM runs, and the
// server must keep serving. Its CLI engine attests from a provenance manifest
// of the pinned build (this repository's `server/patches/`, a stand-in binary
// hashed from disk), and an injected runner stands in for Snapmaker Orca: it
// keeps what each job uploaded and writes one fixed G-code, or holds until
// cancelled, or fails, as the test override `orcaxr_test` asks.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const root = new URL("../../", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = await mkdtemp(path.join(tmpdir(), "orcaxr-external-slicer-"));
const binary = path.join(scratch, "snapmaker-orca");
await writeFile(binary, "#!/bin/sh\nexit 0\n");
await chmod(binary, 0o700);
const pinned = JSON.parse(await readFile(new URL("contracts/pinned-engine-provenance.json", root), "utf8"));
const patchDirectory = new URL("server/patches/", root);
const patches = [];
for (const name of (await readdir(patchDirectory)).filter((n) => n.endsWith(".patch")).sort())
  patches.push({ name, sha256: sha256(await readFile(new URL(name, patchDirectory))) });
const manifest = path.join(scratch, "engine-provenance.json");
await writeFile(
  manifest,
  JSON.stringify({
    schemaVersion: 1,
    engine: { name: "snapmaker-orca", version: pinned.cliVersion, commit: pinned.commit },
    patches,
    binary: { path: binary, sha256: sha256(await readFile(binary)) },
  }),
);
// Read once, when the server module loads.
process.env.ORCAXR_CLI_PROVENANCE = manifest;
const { createSlicerService } = await import(new URL("server/server.js", root));
const { loadServerConfig } = await import(new URL("server/security.mjs", root));

const gcode = workerData.gcode;
const jobs = [];
const requests = [];
const authorizations = [];
const service = createSlicerService({
  engine: "cli",
  logger: { log() {}, info() {}, warn() {}, error() {} },
  uploadDirectory: scratch,
  config: {
    ...loadServerConfig({}),
    host: "127.0.0.1",
    token: workerData.token,
    maxConcurrentJobs: 1,
    maxQueuedJobs: 2,
    maxStoredJobs: 8,
    maxRequestsPerWindow: 1000,
    maxSliceRequestsPerWindow: 100,
    sliceTimeoutMs: 60_000,
    queueTimeoutMs: 60_000,
    childKillGraceMs: 50,
    jobTtlMs: 60_000,
  },
  runner: async ({ modelPath, outputPath, overrides, onProgress, signal }) => {
    const model = await readFile(modelPath);
    const job = { sha256: sha256(model), bytes: model.length, zip: model[0] === 0x50 && model[1] === 0x4b, overrides, outcome: "running" };
    jobs.push(job);
    const mode = overrides.orcaxr_test;
    onProgress(25, mode === "hold" ? "Holding for cancellation" : "Generating G-code");
    if (mode === "hold") {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      job.outcome = "cancelled";
      return;
    }
    // Long enough for the client's 700 ms poll to see the progress.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (mode === "fail") {
      job.outcome = "failed";
      throw new Error("PRIVATE engine failure text");
    }
    await writeFile(outputPath, gcode);
    job.outcome = "done";
  },
});
const server = service.start(0);
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
server.on("request", (req) => {
  requests.push(`${req.method} ${req.url.replace(/\/jobs\/[^/?]+/, "/jobs/:id")}`);
  authorizations.push(req.headers.authorization ?? "");
});
parentPort.postMessage(`http://127.0.0.1:${server.address().port}`);
parentPort.on("message", async (message) => {
  if (message === "summary") {
    parentPort.postMessage({ jobs, requests, authorizations: [...new Set(authorizations)], patches });
  } else if (message === "close") {
    await service.shutdown();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await rm(scratch, { recursive: true, force: true });
    parentPort.close();
  }
});
