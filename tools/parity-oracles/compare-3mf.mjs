#!/usr/bin/env node

import { compareThreeMf } from "./three-mf.mjs";

const [expectedPath, actualPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  console.error(
    "Usage: node tools/parity-oracles/compare-3mf.mjs EXPECTED.3mf ACTUAL.3mf",
  );
  process.exit(2);
}

try {
  const result = compareThreeMf(expectedPath, actualPath);
  if (result.equal) {
    console.log("3MF STRUCTURAL PARITY: PASS");
  } else {
    console.error(
      `3MF STRUCTURAL PARITY: FAIL (${result.differences.length} difference(s))`,
    );
    for (const difference of result.differences)
      console.error(JSON.stringify(difference));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`3MF STRUCTURAL PARITY: ERROR: ${error.message}`);
  process.exitCode = 2;
}
