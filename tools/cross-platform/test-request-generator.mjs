import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const original = JSON.parse(
  readFileSync(new URL("contracts/gcode-requests.json", root)),
);
const changes = [
  (s) => {
    s.additionalProperties = true;
  },
  (s) => {
    s.primitives.u8.max = 256;
  },
  (s) => {
    s.definitions.Options.fields.limits.ignoreUnknown = true;
  },
  (s) => {
    Object.assign(s.definitions.RequestedLimits.fields.records, {
      optional: 0,
      nullable: 0,
    });
  },
  (s) => {
    s.definitions.PreviewRequest.rustGeneric = "";
  },
  (s) => {
    s.definitions.PreviewRequest.fields.layerTimes.rustType = 0;
  },
  (s) => {
    s.operations.inspection.unknown = true;
  },
  (s) => {
    s.definitions.RequestedLimits.fields.records.type = "RequestedLimits";
  },
];
const directory = mkdtempSync(join(tmpdir(), "orcaxr-request-generator-"));
try {
  mkdirSync(join(directory, "tools/cross-platform"), { recursive: true });
  mkdirSync(join(directory, "contracts"));
  copyFileSync(
    new URL("tools/cross-platform/generate-gcode-requests.mjs", root),
    join(directory, "tools/cross-platform/generate-gcode-requests.mjs"),
  );
  copyFileSync(
    new URL("contracts/gcode-view-buffer.json", root),
    join(directory, "contracts/gcode-view-buffer.json"),
  );
  for (const [index, change] of changes.entries()) {
    const schema = structuredClone(original);
    change(schema);
    writeFileSync(
      join(directory, "contracts/gcode-requests.json"),
      JSON.stringify(schema),
    );
    const result = spawnSync(
      process.execPath,
      ["tools/cross-platform/generate-gcode-requests.mjs"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024,
      },
    );
    assert.equal(
      result.error,
      undefined,
      `Guard ${index} must terminate normally`,
    );
    assert.notEqual(
      result.status,
      0,
      `Unsupported schema ${index} was accepted`,
    );
    // No generated outputs exist in this directory: a missing-file error means
    // the malformed schema escaped validation and reached output checking.
    assert.match(
      result.stderr,
      /AssertionError/,
      `Schema ${index} reached generation`,
    );
    assert.doesNotMatch(
      result.stderr,
      /ENOENT/,
      `Schema ${index} reached output checking`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(
  `Request generator rejects ${changes.length} unsupported schema mutations before generation.`,
);
