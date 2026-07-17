#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  canonicalJson,
  DISPOSITIONS_PATH,
  inventoryLeaves,
  MANIFEST_PATH,
  readOverlay,
} from "./extract.mjs";
import { PinnedSource, REPOSITORY_ROOT, UPSTREAM_COMMIT } from "./source.mjs";

const PLAN_PATH = resolve(REPOSITORY_ROOT, "docs", "parity.md");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function taskIdsFromPlan() {
  const plan = readFileSync(PLAN_PATH, "utf8");
  return new Set(
    [...plan.matchAll(/\*\*(P\d+\.\d+)\s+—/g)].map((match) => match[1]),
  );
}

export function verifyManifest({
  manifest,
  overlay = readOverlay(DISPOSITIONS_PATH),
  source = new PinnedSource(),
  compareGenerated = true,
} = {}) {
  assert(
    manifest?.schemaVersion === 1,
    "Unsupported or missing manifest schemaVersion",
  );
  assert(
    manifest.upstream?.commit === UPSTREAM_COMMIT,
    "Manifest is not pinned to the parity commit",
  );
  assert(
    Array.isArray(manifest.sourceFiles),
    "Manifest sourceFiles must be an array",
  );
  const sourceFiles = new Map();
  for (const record of manifest.sourceFiles) {
    assert(
      !sourceFiles.has(record.path),
      `Duplicate source file record: ${record.path}`,
    );
    assert(source.hasPath(record.path), `Stale source path: ${record.path}`);
    assert(
      source.blob(record.path) === record.blob,
      `Stale source blob: ${record.path}`,
    );
    sourceFiles.set(record.path, record);
  }

  const leaves = inventoryLeaves(manifest.inventory);
  assert(
    leaves.length === manifest.counts.total,
    "Total leaf count does not match inventory",
  );
  const ids = new Set();
  const validTasks = taskIdsFromPlan();
  for (const [family, entries] of Object.entries(manifest.inventory)) {
    assert(
      Array.isArray(entries),
      `Inventory family ${family} must be an array`,
    );
    assert(
      entries.length === manifest.counts[family],
      `Count mismatch for ${family}`,
    );
    const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
    assert(
      entries.every((entry, index) => entry.id === sorted[index].id),
      `${family} is not sorted by stable ID`,
    );
    for (const entry of entries) {
      assert(entry.family === family, `Leaf ${entry.id} has the wrong family`);
      assert(!ids.has(entry.id), `Duplicate inventory leaf: ${entry.id}`);
      ids.add(entry.id);
      assert(
        entry.disposition && entry.disposition.id,
        `Unmapped inventory leaf: ${entry.id}`,
      );
      if (entry.disposition.kind === "task") {
        assert(
          validTasks.has(entry.disposition.id),
          `Leaf ${entry.id} maps to missing task ${entry.disposition.id}`,
        );
      } else {
        assert(
          entry.disposition.kind === "adaptation",
          `Leaf ${entry.id} has invalid disposition kind ${entry.disposition.kind}`,
        );
      }
      assert(
        Array.isArray(entry.sources) && entry.sources.length > 0,
        `Leaf ${entry.id} has no upstream source metadata`,
      );
      for (const reference of entry.sources) {
        assert(
          sourceFiles.has(reference.path),
          `Leaf ${entry.id} uses unregistered source ${reference.path}`,
        );
        assert(
          reference.blob === sourceFiles.get(reference.path).blob,
          `Leaf ${entry.id} has a stale blob for ${reference.path}`,
        );
        const text = source.read(reference.path);
        const lines = text.split("\n");
        assert(
          Number.isInteger(reference.line) &&
            reference.line > 0 &&
            reference.line <= lines.length,
          `Leaf ${entry.id} has stale line metadata for ${reference.path}`,
        );
        assert(
          lines[reference.line - 1].trim() === reference.anchor,
          `Leaf ${entry.id} has a stale source anchor at ${reference.path}:${reference.line}`,
        );
        assert(
          typeof reference.symbol === "string" && reference.symbol.length > 0,
          `Leaf ${entry.id} has no source symbol`,
        );
      }
    }
  }

  const mappings = overlay.mappings ?? [];
  const mappedIds = new Set();
  for (const mapping of mappings) {
    assert(
      !mappedIds.has(mapping.id),
      `Duplicate disposition mapping: ${mapping.id}`,
    );
    mappedIds.add(mapping.id);
    assert(ids.has(mapping.id), `Stale disposition mapping: ${mapping.id}`);
    if ((mapping.kind ?? "task") === "task") {
      assert(
        validTasks.has(mapping.dispositionId),
        `Disposition ${mapping.id} refers to missing task ${mapping.dispositionId}`,
      );
    }
  }
  assert(
    mappedIds.size === ids.size,
    `Disposition coverage mismatch: ${mappedIds.size} mappings for ${ids.size} leaves`,
  );

  if (compareGenerated) {
    const generated = buildManifest({ source, overlay });
    assert(
      canonicalJson(generated) === canonicalJson(manifest),
      "Committed manifest differs from a fresh exact-blob extraction",
    );
  }
  return {
    families: Object.keys(manifest.inventory).length,
    leaves: leaves.length,
    sources: sourceFiles.size,
  };
}

function parseArgs(argv) {
  const options = { manifestPath: MANIFEST_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") options.manifestPath = resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
  const result = verifyManifest({ manifest });
  console.log(
    `Parity manifest verified: ${result.leaves} leaves in ${result.families} families, ` +
      `${result.sources} exact upstream blobs at ${UPSTREAM_COMMIT}.`,
  );
  return result;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`parity verify: ${error.message}`);
    process.exitCode = 1;
  }
}
