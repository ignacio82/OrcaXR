// The Moonraker simulator on a thread of its own: the JNI bridge blocks the
// main thread while the JVM runs, and the simulator must keep serving.
import { parentPort, workerData } from "node:worker_threads";
import { startMoonrakerSimulator } from "../../web/scripts/moonraker-simulator.mjs";

const simulator = await startMoonrakerSimulator(workerData?.options ?? {});
// A camera on the simulator's own origin (known only once it listens), and
// one that offers only a stream.
if (workerData?.cameras) {
  simulator.state.webcams = [
    {
      name: "Nozzle",
      service: "mjpegstreamer-adaptive",
      snapshot_url: `${simulator.url}/webcam/snapshot`,
      stream_url: "/webcam/?action=stream",
      target_fps: 15,
    },
    { name: "Bed", service: "webrtc-camerastreamer", stream_url: "/webcam2/webrtc" },
  ];
}
// The first upload is held, so a client's cancel lands while it is in flight.
simulator.afterNextUpload(
  () => new Promise((resolve) => setTimeout(resolve, 3000)),
);
parentPort.postMessage(simulator.url);
parentPort.on("message", async (message) => {
  if (message === "summary") {
    parentPort.postMessage({
      stored: [...simulator.stored.keys()].sort(),
      started: simulator.started,
      commands: simulator.commands,
      apiKeys: [...new Set(simulator.apiKeys)],
      requests: simulator.requests,
    });
  } else if (message === "close") {
    await simulator.close();
    parentPort.close();
  }
});
