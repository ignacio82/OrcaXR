import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSlicerService } from "./server.js";

test(
  "the default verified deployment executes a real WASM slice through HTTP",
  { timeout: 90_000 },
  async () => {
    const service = createSlicerService({
      env: {},
      engine: "wasm",
      logger: { log() {}, warn() {}, error() {} },
    });
    const server = service.start(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const attestation = await (await fetch(`${url}/engine`)).json();
      assert.equal(
        attestation.attested,
        true,
        "default deployment must attest without a path override",
      );
      const body = new FormData();
      body.append(
        "file",
        new Blob([
          await fs.readFile(
            new URL("../web/public/models/cube_20mm.stl", import.meta.url),
          ),
        ]),
        "cube.stl",
      );
      body.append(
        "overrides",
        JSON.stringify({
          before_layer_change_gcode: "G92 E0\n",
          layer_height: "0.3",
        }),
      );
      const response = await fetch(`${url}/slice`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(80_000),
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 1000);
      assert.match(bytes.toString("utf8"), /;LAYER_CHANGE/);
      assert.equal(
        response.headers.get("x-orcaxr-gcode-sha256"),
        createHash("sha256").update(bytes).digest("hex"),
      );
      const id = response.headers.get("x-orcaxr-job-id");
      assert.ok(id);
      assert.deepEqual(
        await (await fetch(`${url}/jobs/${id}`, { method: "DELETE" })).json(),
        { status: "done", released: true },
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await service.shutdown();
    }
  },
);
