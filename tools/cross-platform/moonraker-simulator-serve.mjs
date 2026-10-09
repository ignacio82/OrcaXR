// A Moonraker simulator for an out-of-process client (an emulator's app):
// prints its URL, answers `summary` on stdin with what it received, and
// stops on `close` or end of input.
import { createInterface } from "node:readline";
import { startMoonrakerSimulator } from "../../web/scripts/moonraker-simulator.mjs";

const simulator = await startMoonrakerSimulator();
console.log(simulator.url);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line === "summary") {
    console.log(
      JSON.stringify({
        apiKeys: [...new Set(simulator.apiKeys)],
        requests: simulator.requests,
        commands: simulator.commands,
      }),
    );
  } else if (line === "close") break;
}
await simulator.close();
process.exit(0);
