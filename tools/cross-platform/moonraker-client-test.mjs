// The Android Moonraker hosts end to end on this machine's JVM: the shared
// core's transport, session and send workflow (JNI) driven by `MoonrakerClient`
// (OkHttp), `PrinterSessionClient` and `PrintWorkflowClient`, each against a
// fresh Moonraker simulator (a real
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
  assert.equal(jvm.call("moonrakerClientChecks", transport.url), 22);
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
  const sends = await simulator();
  printers.push(sends);
  assert.equal(jvm.call("printWorkflowClientChecks", sends.url), 12);
  const sent = await sends.summary();
  // The unique-name upload, then the overwrite; the declined and refused sends left nothing.
  assert.equal(sent.stored.length, 2);
  assert.ok(sent.stored.includes("part.gcode"));
  assert.match(
    sent.stored.find((path) => path !== "part.gcode"),
    /^part_[0-9a-f]{32}\.gcode$/,
  );
  assert.equal(sent.started, "part.gcode");
  assert.deepEqual(sent.commands, ["start"]);
  const lan = await simulator();
  printers.push(lan);
  assert.equal(jvm.call("lanPolicyChecks", lan.url), 21);
  // The public-address client sent nothing; the private one, its handshake
  // (whose two requests may arrive in either order).
  assert.deepEqual((await lan.summary()).requests.toSorted(), [
    "GET /printer/info",
    "GET /server/info",
  ]);
  const nearby = await simulator();
  printers.push(nearby);
  assert.equal(jvm.call("localNetworkChecks", nearby.url), 28);
  // Denied clients sent nothing; the granted one its handshake (whose two
  // requests may arrive in either order), nothing while revoked, and its
  // request once granted again.
  assert.deepEqual((await nearby.summary()).requests.toSorted(), [
    "GET /printer/info",
    "GET /printer/info",
    "GET /server/info",
  ]);
  const workshop = await simulator();
  printers.push(workshop);
  assert.equal(jvm.call("deviceWorkspaceChecks", workshop.url), 28);
  // The simulator printer's own key reached it and no other key ever did;
  // the printer without one sent none.
  assert.deepEqual([...new Set((await workshop.summary()).apiKeys.filter(Boolean))], ["sim-key-1234"]);
  console.log(
    JSON.stringify({
      deviceWorkspaceChecks: 28,
      lanPolicyChecks: 21,
      localNetworkChecks: 28,
      moonrakerClientChecks: 22,
      printerSessionClientChecks: 17,
      printWorkflowClientChecks: 12,
      requests:
        received.requests.length +
        commanded.requests.length +
        sent.requests.length,
    }),
  );
} finally {
  await jvm.close();
  for (const printer of printers) printer.close();
}
