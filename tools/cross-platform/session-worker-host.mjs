// A Node worker hosting the shared Rust project session, for
// `session-worker-recovery.mjs`. Two test faults stand in for real ones:
// "hang" stops answering (a stuck core) and "exit" ends the worker (a crash).
import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
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
const { hostRustProjectSession } =
  await import("../../web/src/project/RustProjectSessionHost.ts");
const layout = JSON.parse(
  await readFile(new URL("contracts/project-host.json", root), "utf8"),
);
const handle = hostRustProjectSession(core, layout, (reply, transfer) =>
  parentPort.postMessage(reply, transfer),
);
let hung = false;
parentPort.on("message", (request) => {
  if (request === "hang") hung = true;
  else if (request === "exit") process.exit(70);
  else if (!hung) handle(request);
});
