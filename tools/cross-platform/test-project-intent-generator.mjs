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
  readFileSync(new URL("contracts/project-intents.json", root)),
);
const changes = [
  (s) => {
    s.additionalProperties = true;
  },
  (s) => {
    s.schemaVersion = 2;
  },
  (s) => {
    s.maxDepth = 33;
  },
  (s) => {
    s.maxNodes = 0;
  },
  (s) => {
    s.definitions.Unit.max = Number.MAX_SAFE_INTEGER + 1;
  },
  (s) => {
    s.definitions.Unit.min = -1;
  },
  (s) => {
    s.definitions.Unit.maximum = 42;
  },
  (s) => {
    s.definitions.Flag.optional = true;
  },
  (s) => {
    s.definitions.Id.items = "Id";
  },
  (s) => {
    s.definitions.Id.max = s.maxNodes + 1;
  },
  (s) => {
    s.definitions.Id.min = s.definitions.Id.max + 1;
  },
  (s) => {
    s.definitions.AddPlate.fields.payload = "Unknown";
  },
  (s) => {
    s.definitions.AddPlate.fields.constructor = "Unit";
  },
  (s) => {
    s.definitions.Command.kind = "tagged-union";
  },
  (s) => {
    s.definitions.Command.optional = true;
  },
  (s) => {
    s.definitions.Command.variants = {};
  },
  (s) => {
    s.definitions.Version.max = 2;
  },
  (s) => {
    s.roots.push("Command");
  },
  (s) => {
    s.definitions.Unreachable = { kind: "boolean" };
  },
];
changes.push(
  (s) => {
    s.definitions.Order.max = null;
  },
  (s) => {
    s.definitions.Order.min = 0.5;
  },
  (s) => {
    s.definitions.Order.optional = true;
  },
  (s) => {
    s.definitions.Order.min = -1;
  },
);
changes.push(
  (s) => {
    s.sessionVersion = 0;
  },
  (s) => {
    s.definitions.SessionVersion.max = 2;
  },
  (s) => {
    s.definitions.SessionError.values = [];
  },
  (s) => {
    s.definitions.SessionError.values.push("stale");
  },
  (s) => {
    s.definitions.SessionError.values.push("invalid-value");
  },
  (s) => {
    s.definitions.SessionError.optional = true;
  },
);
const directory = mkdtempSync(join(tmpdir(), "orcaxr-intent-generator-"));
try {
  mkdirSync(join(directory, "tools/cross-platform"), { recursive: true });
  mkdirSync(join(directory, "contracts"));
  copyFileSync(
    new URL("tools/cross-platform/generate-project-intents.mjs", root),
    join(directory, "tools/cross-platform/generate-project-intents.mjs"),
  );
  for (const [index, change] of changes.entries()) {
    const schema = structuredClone(original);
    change(schema);
    writeFileSync(
      join(directory, "contracts/project-intents.json"),
      JSON.stringify(schema),
    );
    const result = spawnSync(
      process.execPath,
      ["tools/cross-platform/generate-project-intents.mjs"],
      { cwd: directory, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(
      result.error,
      undefined,
      `Guard ${index} must terminate normally`,
    );
    assert.notEqual(result.status, 0, `Mutation ${index} accepted`);
    assert.match(
      result.stderr,
      /AssertionError/,
      `Mutation ${index} escaped validation`,
    );
    assert.doesNotMatch(
      result.stderr,
      /ENOENT/,
      `Mutation ${index} reached output checking`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(
  `Project intent generator rejects ${changes.length} unsupported schema mutations.`,
);
