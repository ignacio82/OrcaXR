#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PinnedSource } from "../parity/source.mjs";
import { extractEngineOptionSchema } from "./source-parser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../..");
export const MANIFEST_PATH = resolve(
  REPOSITORY_ROOT,
  "docs/parity/snapmaker-v2.3.4.json",
);
export const OUTPUT_PATH = resolve(
  REPOSITORY_ROOT,
  "web/src/settings/generated/engine-options.schema.json",
);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function serializeSchema(schema) {
  return `${JSON.stringify(canonicalize(schema), null, 2)}\n`;
}

export function buildSchema({ allowFetch = true, sourceOverrides } = {}) {
  const manifestBytes = readFileSync(MANIFEST_PATH);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const snapshot = new PinnedSource({ allowFetch, overrides: sourceOverrides });
  return extractEngineOptionSchema({ snapshot, manifest, manifestSha256 });
}

export function expectedSchemaBytes(options = {}) {
  return serializeSchema(buildSchema(options));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const supported = new Set(["--check", "--no-fetch"]);
  for (const arg of args)
    if (!supported.has(arg)) throw new Error(`Unknown argument ${arg}`);
  const expected = expectedSchemaBytes({ allowFetch: !args.has("--no-fetch") });
  if (args.has("--check")) {
    if (!existsSync(OUTPUT_PATH))
      throw new Error(`Generated settings schema is missing: ${OUTPUT_PATH}`);
    const actual = readFileSync(OUTPUT_PATH, "utf8");
    if (actual !== expected) {
      throw new Error(
        `Generated settings schema is stale. Run: node tools/settings-schema/generate.mjs`,
      );
    }
    process.stdout.write(
      `settings schema is current (${Buffer.byteLength(expected)} bytes)\n`,
    );
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected);
  process.stdout.write(
    `wrote ${OUTPUT_PATH} (${Buffer.byteLength(expected)} bytes)\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
