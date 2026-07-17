#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareGcodeFiles,
  compareGcodeText,
  parseGcodeFile,
} from "./gcode.mjs";
import {
  buildExpectedSummary,
  generateFixtures,
} from "./generate-fixtures.mjs";
import { compareThreeMf, normalizeThreeMf } from "./three-mf.mjs";
import { createZip, readZip } from "./zip.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DATA = join(ROOT, "testdata", "parity");
const FIXTURES = join(DATA, "fixtures");

generateFixtures({ check: true });
const mutations = JSON.parse(
  readFileSync(join(DATA, "recipes", "mutations.json"), "utf8"),
);
const reference3mf = join(FIXTURES, "reference.3mf");
const referenceGcode = join(FIXTURES, "reference.gcode");
const expectedSummary = JSON.parse(
  readFileSync(join(DATA, "expected", "reference.semantic.json"), "utf8"),
);
assert.deepEqual(
  buildExpectedSummary(
    readFileSync(reference3mf),
    readFileSync(referenceGcode, "utf8"),
  ),
  expectedSummary,
  "committed semantic summary must match the generated reference fixtures",
);

const identical3mf = compareThreeMf(reference3mf, reference3mf);
assert.equal(identical3mf.equal, true, "a 3MF must compare equal to itself");

const entries = [...readZip(reference3mf).entries()].reverse();
const reorderedAndRestamped = createZip(entries, {
  sort: false,
  timestamp: new Date("2026-07-17T12:34:56Z"),
});
assert.equal(
  compareThreeMf(reference3mf, reorderedAndRestamped).equal,
  true,
  "ZIP member order and timestamps must not affect structural parity",
);

const changedExtensionEntries = readZip(reference3mf);
changedExtensionEntries.set(
  "Extensions/opaque.txt",
  Buffer.from("changed unknown extension\n"),
);
const changedExtension = compareThreeMf(
  reference3mf,
  createZip(changedExtensionEntries),
);
assert.equal(
  changedExtension.equal,
  false,
  "an unknown extension payload change must fail parity",
);
assert.ok(
  changedExtension.differences.some((difference) =>
    difference.path.startsWith("/unknownExtensions"),
  ),
);

const brokenRelationshipEntries = readZip(reference3mf);
brokenRelationshipEntries.delete("Extensions/opaque.txt");
const brokenRelationship = compareThreeMf(
  reference3mf,
  createZip(brokenRelationshipEntries),
);
assert.equal(
  brokenRelationship.equal,
  false,
  "a dangling package relationship must fail parity",
);
assert.ok(
  brokenRelationship.actual.relationships.some(
    (relationship) => relationship.missing,
  ),
);

const summary = normalizeThreeMf(reference3mf);
assert.equal(summary.relationships.length, 5, "reference relationship count");
assert.equal(
  summary.relationships.some((relationship) => relationship.missing),
  false,
  "all fixture relationships resolve",
);
assert.equal(summary.models.length, 1, "reference model document count");
assert.equal(summary.models[0].objects.length, 4, "reference object count");
assert.equal(
  summary.models[0].objects[0].components.length,
  2,
  "reference component count",
);
assert.equal(
  summary.models[0].build.length,
  3,
  "reference build item / instance count",
);
assert.ok(
  summary.partAssignments.some(
    (assignment) =>
      assignment.scope === "part" && assignment.key === "extruder",
  ),
);
assert.ok(
  summary.facetAnnotations.some(
    (annotation) => annotation.payload.paint_color === "1F",
  ),
);
assert.ok(
  summary.mixedFilamentDefinitions.some(
    (setting) => setting.key === "mixed_filament_ratio",
  ),
);
assert.ok(summary.plates.length >= 2, "multiple plates must be indexed");
assert.ok(summary.customGcode.length >= 2, "custom G-code must be indexed");
assert.ok(
  summary.unknownExtensions.length >= 2,
  "unknown elements, attributes, and members must be retained",
);

for (const mutation of mutations.threeMf) {
  const result = compareThreeMf(
    reference3mf,
    join(FIXTURES, "mutations", `${mutation.id}.3mf`),
  );
  assert.equal(
    result.equal,
    false,
    `${mutation.id} must fail structural parity`,
  );
  assert.ok(
    result.differences.some((difference) =>
      difference.path.startsWith(mutation.expectedDifference),
    ),
    `${mutation.id} must report a difference under ${mutation.expectedDifference}`,
  );
}

const identicalGcode = compareGcodeFiles(referenceGcode, referenceGcode);
assert.equal(identicalGcode.equal, true, "G-code must compare equal to itself");
const gcode = parseGcodeFile(referenceGcode);
assert.equal(gcode.layers.length, 2, "reference G-code layer count");
assert.deepEqual(gcode.toolOrder, [0, 1], "reference G-code tool order");
assert.equal(
  gcode.extrusion.total,
  7.5,
  "absolute/relative extrusion accounting",
);
assert.equal(gcode.extrusion.byContext.model, 7, "model extrusion accounting");
assert.equal(
  gcode.extrusion.byContext.tower,
  0.5,
  "tower extrusion accounting",
);
assert.deepEqual(gcode.bounds.min, { x: 0, y: 0, z: 0.2 });
assert.deepEqual(gcode.bounds.max, { x: 12, y: 12, z: 0.4 });
assert.ok(
  gcode.roles.includes("Outer wall") && gcode.roles.includes("Prime tower"),
);
assert.equal(gcode.temperatures.length, 7, "temperature command count");
assert.equal(gcode.estimates["estimated printing time (normal mode)"], 42);
assert.deepEqual(gcode.warnings, ["WARNING: Synthetic fixture warning"]);

for (const mutation of mutations.gcode) {
  const result = compareGcodeFiles(
    referenceGcode,
    join(FIXTURES, "mutations", `${mutation.id}.gcode`),
  );
  assert.equal(
    result.equal,
    false,
    `${mutation.id} must fail semantic G-code parity`,
  );
  assert.ok(
    result.differences.some((difference) =>
      difference.path.startsWith(mutation.expectedDifference),
    ),
    `${mutation.id} must report a difference under ${mutation.expectedDifference}`,
  );
}

const temperatureWithinTolerance = readFileSync(referenceGcode, "utf8").replace(
  "M104 S210 T0",
  "M104 S210.05 T0",
);
assert.equal(
  compareGcodeText(
    readFileSync(referenceGcode, "utf8"),
    temperatureWithinTolerance,
  ).equal,
  true,
  "configured numeric tolerances must permit insignificant drift",
);
assert.equal(
  compareGcodeText(
    readFileSync(referenceGcode, "utf8"),
    temperatureWithinTolerance,
    {
      tolerances: { temperatureC: 0.001 },
    },
  ).equal,
  false,
  "tightened numeric tolerances must reject the same drift",
);

console.log(
  "Parity oracle self-tests: PASS (required mutations, relationships/extensions, ZIP normalization, tolerance controls)",
);
