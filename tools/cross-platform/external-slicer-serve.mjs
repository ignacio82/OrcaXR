// The real external slicer server (`external-slicer-server-worker.mjs`) for an
// out-of-process client (an emulator's app): prints its URL, answers `summary`
// on stdin with what it received, holds every later job until it is cancelled
// from `hold` to `release`, and stops on `close` or end of input. Its first argument is the
// options as JSON: the bearer `token`, and `gcodeFile`, the G-code each job
// writes (relative to the repository).
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";

const root = new URL("../../", import.meta.url);
const options = JSON.parse(process.argv[2] ?? "{}");
const gcode = await readFile(new URL(options.gcodeFile, root), "utf8");
const worker = new Worker(new URL("./external-slicer-server-worker.mjs", import.meta.url), {
  workerData: { token: options.token, gcode },
});
const next = () =>
  new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
console.log(await next());
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line === "summary") {
    worker.postMessage("summary");
    console.log(JSON.stringify(await next()));
  } else if (line === "hold" || line === "release") {
    worker.postMessage(line);
    console.log(await next());
  } else if (line === "close") break;
}
worker.postMessage("close");
await new Promise((resolve) => worker.once("exit", resolve));
process.exit(0);
