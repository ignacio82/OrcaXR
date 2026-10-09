// The Android Moonraker host end to end on this machine's JVM: the shared
// core's transport (JNI) driven over OkHttp by `MoonrakerClient`, against the
// Moonraker simulator (a real HTTP and WebSocket server). The Kotlin checks
// assert what the client sees; this asserts what the printer received.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { startProjectJni } from "./project-jni-bridge.mjs";

const worker = new Worker(
  new URL("./moonraker-simulator-worker.mjs", import.meta.url),
);
const next = () =>
  new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
const endpoint = await next();
const jvm = startProjectJni();
try {
  assert.equal(jvm.call("moonrakerClientChecks", endpoint), 21);
  worker.postMessage("summary");
  const printer = await next();
  assert.deepEqual(printer.stored, ["android.gcode", "held.gcode"]);
  assert.equal(printer.started, "android.gcode");
  assert.deepEqual(printer.commands, ["start", "firmware-restart"]);
  // Every request carried the session's key, and only it.
  assert.deepEqual(printer.apiKeys, ["android-key"]);
  // The mutation refused as a GET and the hand-set credential never left.
  assert.ok(!printer.requests.includes("GET /printer/print/start"));
  console.log(
    JSON.stringify({
      moonrakerClientChecks: 21,
      requests: printer.requests.length,
    }),
  );
} finally {
  await jvm.close();
  worker.postMessage("close");
}
