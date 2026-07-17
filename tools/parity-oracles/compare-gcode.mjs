#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { compareGcodeFiles, DEFAULT_TOLERANCES } from "./gcode.mjs";

function usage() {
  console.error(
    "Usage: node tools/parity-oracles/compare-gcode.mjs EXPECTED.gcode ACTUAL.gcode " +
      "[--tolerances JSON-or-@path]",
  );
}

const args = process.argv.slice(2);
const expectedPath = args.shift();
const actualPath = args.shift();
if (!expectedPath || !actualPath) {
  usage();
  process.exit(2);
}
let tolerances = {};
while (args.length > 0) {
  const flag = args.shift();
  if (flag !== "--tolerances" || args.length === 0) {
    usage();
    process.exit(2);
  }
  const raw = args.shift();
  tolerances = JSON.parse(
    raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw,
  );
}
for (const key of Object.keys(tolerances)) {
  if (
    !Object.hasOwn(DEFAULT_TOLERANCES, key) ||
    typeof tolerances[key] !== "number" ||
    tolerances[key] < 0
  ) {
    throw new Error(`Unknown or invalid G-code tolerance ${key}`);
  }
}

try {
  const result = compareGcodeFiles(expectedPath, actualPath, { tolerances });
  if (result.equal) {
    console.log(
      `G-CODE SEMANTIC PARITY: PASS (${JSON.stringify(result.tolerances)})`,
    );
  } else {
    console.error(
      `G-CODE SEMANTIC PARITY: FAIL (${result.differences.length} difference(s))`,
    );
    for (const difference of result.differences)
      console.error(JSON.stringify(difference));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`G-CODE SEMANTIC PARITY: ERROR: ${error.message}`);
  process.exitCode = 2;
}
