// The Android Moonraker hosts end to end on this machine's JVM: the shared
// core's transport, session and send workflow (JNI) driven by `MoonrakerClient`
// (OkHttp), `PrinterSessionClient`, `PrintWorkflowClient` and the Device
// area's workspace (its sends too), each against a
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
  assert.equal(jvm.call("moonrakerClientChecks", transport.url), 23);
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
  assert.equal(jvm.call("deviceWorkspaceChecks", workshop.url), 30);
  const worked = await workshop.summary();
  // The simulator printer's own key reached it and no other key ever did;
  // the printer without one sent none.
  assert.deepEqual([...new Set(worked.apiKeys.filter(Boolean))], ["sim-key-1234"]);
  // The firmware restart reached it before any connection; then the cancel.
  assert.deepEqual(worked.commands, ["firmware-restart", "start", "cancel"]);
  // One filament loaded: the send's tool-mapping blocker and colour warning come from it.
  const toolchanger = await simulator({ options: { slots: [{ color: "FF0000", material: "PLA" }] } });
  printers.push(toolchanger);
  assert.equal(jvm.call("deviceSendChecks", toolchanger.url), 28);
  const delivered = await toolchanger.summary();
  // The upload cancelled in flight (the simulator had stored it), the
  // upload-only send under a unique name, and the print under its exact name;
  // the refused and declined sends left nothing.
  assert.equal(delivered.stored.length, 3);
  assert.equal(delivered.stored.filter((path) => /^Bracket_Plate_1_[0-9a-f]{32}\.gcode$/.test(path)).length, 2);
  assert.ok(delivered.stored.includes("Bracket_Plate_2.gcode"));
  assert.equal(delivered.started, "Bracket_Plate_2.gcode");
  // The options the operator chose, timelapse before levelling, then the start: nothing else moved the printer.
  assert.deepEqual(delivered.commands, ["timelapse:true", "gcode:BED_MESH_CALIBRATE", "start"]);
  assert.deepEqual([...new Set(delivered.apiKeys.filter(Boolean))], ["send-key"]);
  const shop = await simulator({
    cameras: true,
    options: {
      history: [1, 2, 3].map((n) => ({
        job_id: `00000${n}`,
        filename: `job-${n}.gcode`,
        status: "completed",
        start_time: 1_800_000_000 + n * 4000,
        end_time: 1_800_003_600 + n * 4000,
        print_duration: 3500,
        total_duration: 3600,
        filament_used: 1234.5,
        exists: n !== 3,
        metadata: { estimated_time: 3400 },
      })),
      historyTotals: { total_jobs: 3, total_time: 10_800, total_print_time: 10_500, total_filament_used: 3703.5 },
      configSettings: {
        "gcode_macro load_filament": { gcode: "M109 S{params.TEMP}\nG1 E50", description: "Loads filament" },
      },
    },
  });
  printers.push(shop);
  assert.equal(jvm.call("printerExchangesChecks", shop.url), 20);
  const exchanged = await shop.summary();
  // The script reached the printer; the refused traversal and empty script did not.
  assert.ok(exchanged.commands.includes("gcode:M105"));
  assert.ok(!exchanged.requests.some((request) => request.includes("..") || request.includes("printer.cfg")));
  assert.deepEqual([...new Set(exchanged.apiKeys.filter(Boolean))], ["exchange-key"]);
  // Discovery: an open printer and one asking for a key, probed with no key.
  const found = await simulator();
  const locked = await simulator({ options: { requiredApiKey: "locked-key" } });
  printers.push(found, locked);
  assert.equal(jvm.call("printerDiscoveryChecks", found.url, locked.url), 27);
  // The probes sent no key; the locked printer saw its key only once the operator entered it.
  assert.deepEqual((await found.summary()).apiKeys.filter(Boolean), []);
  assert.deepEqual([...new Set((await locked.summary()).apiKeys.filter(Boolean))], ["locked-key"]);
  console.log(
    JSON.stringify({
      printerDiscoveryChecks: 27,
      printerExchangesChecks: 20,
      deviceWorkspaceChecks: 30,
      deviceSendChecks: 28,
      lanPolicyChecks: 21,
      localNetworkChecks: 28,
      moonrakerClientChecks: 23,
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
