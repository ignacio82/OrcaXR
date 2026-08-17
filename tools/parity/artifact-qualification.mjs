#!/usr/bin/env node

/**
 * Artifact qualification (P12.3).
 *
 * P12.3 asks for two things that pull in different directions. Rebuilding the
 * WASM engine and the server CLI from clean sources needs a toolchain this
 * check cannot assume. But its acceptance clause — "no stale bundle or
 * uncommitted developer-local fixture participates" — is checkable right now,
 * and it is the half that actually protects a reader of the evidence: every
 * slice result recorded in this repository was produced by *some* engine
 * binary, and if that binary is not the committed one then none of those
 * results describe the artifact anyone else would get.
 *
 * So this qualifies what is present rather than pretending to rebuild it, and
 * reports the corpora named by P12.3 with an honest note of which have no suite
 * at all. A qualification report that lists only the corpora that exist reads
 * as complete coverage; naming the absent one is the point.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPOSITORY_ROOT } from "./source.mjs";

/** Everything whose bytes decide what an operator actually runs. */
const ARTIFACT_ROOTS = Object.freeze({
  engine: "web/public/slicer",
  patches: "server/patches",
  profiles: "web/public/profiles",
  calibrationGeometry: "web/public/calibration",
});

/**
 * The corpora P12.3 names, and where each is covered.
 *
 * `suite: null` is a deliberate entry rather than an omission. Route comparison
 * — the same project sliced through the in-browser WASM route and the external
 * server route, compared — has no suite, and a qualification report that simply
 * left it out would read as full coverage of the list.
 */
const CORPORA = Object.freeze([
  { id: "project", suite: "web/src/project/**/__tests__" },
  { id: "config", suite: "web/src/settings/**" },
  { id: "3mf", suite: "web/src/project/serialization/**" },
  { id: "gcode", suite: "web/src/project/__tests__/*-slice.test.ts" },
  {
    id: "hostile-input",
    suite: "web/src/project/import/__tests__/model-formats.test.ts",
  },
  { id: "cancellation", suite: "web/src/project/__tests__/session.test.ts" },
  { id: "memory", suite: "web/src/settings/generated/loader.test.ts" },
  {
    id: "route-comparison",
    suite: "tools/parity/route-comparison.mjs",
    runnable: false,
    why: "needs the external OrcaSlicer CLI, which is absent outside the qualification container",
  },
]);

function git(args) {
  return execFileSync("git", ["-C", REPOSITORY_ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Files under a root that differ from what is committed.
 *
 * Both directions matter. A modified tracked file means the tests ran against
 * something nobody else has; an untracked one means an artifact exists only on
 * this machine and would simply be missing from a fresh clone.
 */
function unqualifiedFiles(root) {
  const modified = git(["diff", "--name-only", "-z", "HEAD", "--", root])
    .split("\0")
    .filter(Boolean);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    root,
  ])
    .split("\0")
    .filter(Boolean);
  return { modified, untracked };
}

export function qualifyArtifacts() {
  const roots = {};
  const problems = [];
  for (const [name, root] of Object.entries(ARTIFACT_ROOTS)) {
    const tracked = git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      "HEAD",
      "--",
      root,
    ])
      .split("\0")
      .filter(Boolean);
    const { modified, untracked } = unqualifiedFiles(root);
    roots[name] = { root, files: tracked.length, modified, untracked };
    for (const path of modified) {
      problems.push(
        `${path} differs from the committed bytes, so results produced with it describe no released artifact`,
      );
    }
    for (const path of untracked) {
      problems.push(
        `${path} exists only on this machine and would be absent from a fresh clone`,
      );
    }
    if (tracked.length === 0)
      problems.push(`${root} has no committed files at all`);
  }
  // A corpus that exists but cannot run here is not the same as one that does
  // not exist, and flattening the two would hide which is which.
  const missingCorpora = CORPORA.filter((corpus) => corpus.suite === null).map(
    (corpus) => corpus.id,
  );
  const notRunnableHere = CORPORA.filter(
    (corpus) => corpus.suite !== null && corpus.runnable === false,
  ).map((corpus) => `${corpus.id} (${corpus.why})`);
  return {
    schemaVersion: 1,
    roots,
    corpora: CORPORA,
    missingCorpora,
    notRunnableHere,
    qualified: problems.length === 0,
    problems,
    // Said in the result rather than left to a reader's inference: passing this
    // check is not the rebuild P12.3 asks for.
    notQualifiedHere: [
      "rebuilding the WASM engine from clean sources (needs the Emscripten toolchain)",
      "rebuilding the server WASM/CLI from clean sources",
      ...(missingCorpora.length > 0
        ? [`corpora with no suite: ${missingCorpora.join(", ")}`]
        : []),
      ...notRunnableHere.map(
        (entry) => `corpus present but not runnable here: ${entry}`,
      ),
    ],
  };
}

export function main() {
  const result = qualifyArtifacts();
  for (const [name, root] of Object.entries(result.roots)) {
    console.log(
      `  ${name}: ${root.files} committed file(s) under ${root.root}`,
    );
  }
  if (!result.qualified) {
    for (const problem of result.problems) console.error(`  ✗ ${problem}`);
    throw new Error(
      `${result.problems.length} artifact(s) would not be reproducible from this commit`,
    );
  }
  console.log(
    `Artifacts qualified: every file under ${Object.keys(result.roots).length} roots matches the commit. ` +
      `Not qualified here: ${result.notQualifiedHere.join("; ")}.`,
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
    console.error(`parity artifact-qualification: ${error.message}`);
    process.exitCode = 1;
  }
}
