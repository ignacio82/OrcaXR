// The Android Moonraker hosts end to end on this machine's JVM: the shared
// core's transport and session (JNI) driven by `MoonrakerClient` (OkHttp) and
// `PrinterSessionClient`, each against a fresh Moonraker simulator (a real
// HTTP and WebSocket server). The Kotlin checks assert what the client sees;
// this asserts what the printer received.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { startProjectJni } from "./project-jni-bridge.mjs";

/** A simulator on its own thread: the JNI bridge blocks this one while the JVM runs. */
async function simulator(workerData = {}) {
  const worker = new Worker(
    new URL("./moonraker-simulator-worker.mjs", import.meta.url),
    { workerData },
  );
  const next = () =>
    new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  const url = await next();
  return {
    url,
    async summary() {
      worker.postMessage("summary");
      return next();
    },
    close() {
      worker.postMessage("close");
    },
  };
}

const jvm = startProjectJni();
const printers = [];
try {
  const transport = await simulator({ holdFirstUpload: true });
  printers.push(transport);
  assert.equal(jvm.call("moonrakerClientChecks", transport.url), 21);
  const received = await transport.summary();
  assert.deepEqual(received.stored, ["android.gcode", "held.gcode"]);
  assert.equal(received.started, "android.gcode");
  assert.deepEqual(received.commands, ["start", "firmware-restart"]);
  // Every request carried the session's key, and only it.
  assert.deepEqual(received.apiKeys, ["android-key"]);
  // The mutation refused as a GET and the hand-set credential never left.
  assert.ok(!received.requests.includes("GET /printer/print/start"));

  const session = await simulator();
  printers.push(session);
  assert.equal(jvm.call("printerSessionClientChecks", session.url), 17);
  const commanded = await session.summary();
  // Exactly the commands the session's guards let through, in order.
  assert.deepEqual(commanded.commands, [
    "start",
    "pause",
    "resume",
    "cancel",
    "emergency-stop",
  ]);
  assert.deepEqual(commanded.apiKeys, ["android-key"]);
  console.log(
    JSON.stringify({
      moonrakerClientChecks: 21,
      printerSessionClientChecks: 17,
      requests: received.requests.length + commanded.requests.length,
    }),
  );
} finally {
  await jvm.close();
  for (const printer of printers) printer.close();
}
