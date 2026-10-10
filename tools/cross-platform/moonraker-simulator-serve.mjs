// A Moonraker simulator for an out-of-process client (an emulator's app):
// prints its URL, answers `summary` on stdin with what it received, and
// stops on `close` or end of input. Its first argument, when given, is the
// simulator's options as JSON. `slots <json>` replaces the loaded filaments
// (answering `slots`), and `hold <ms>` holds the reply to the next upload —
// stored already — that long (answering `holding`), so a client's cancel
// lands while it is in flight.
import { createInterface } from "node:readline";
import { startMoonrakerSimulator } from "../../web/scripts/moonraker-simulator.mjs";

const simulator = await startMoonrakerSimulator(JSON.parse(process.argv[2] ?? "{}"));
console.log(simulator.url);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line === "summary") {
    console.log(
      JSON.stringify({
        apiKeys: [...new Set(simulator.apiKeys)],
        requests: simulator.requests,
        commands: simulator.commands,
        snapshotRequests: simulator.snapshotRequests,
        stored: [...simulator.stored.keys()].sort(),
        started: simulator.started,
      }),
    );
  } else if (line.startsWith("slots ")) {
    simulator.setSlots(JSON.parse(line.slice("slots ".length)));
    console.log("slots");
  } else if (line.startsWith("hold ")) {
    const ms = Number(line.slice("hold ".length));
    simulator.afterNextUpload(() => new Promise((resolve) => setTimeout(resolve, ms)));
    console.log("holding");
  } else if (line === "close") break;
}
await simulator.close();
process.exit(0);
