#!/usr/bin/env node

/**
 * The release report P12.6 asks for (P12.6, P12.2, P12.5).
 *
 * P12.6's acceptance cannot be met yet — it requires every task to be `[x]` and
 * four human gates that no code can satisfy. Its *deliverable* can be, and
 * should be built first rather than last: the reviewer P12.2 wants and the
 * security sign-off P12.5 wants both need something to review, and until now
 * the only artifact was a 3,400-line plan document.
 *
 * So this generates the report from the manifests rather than from prose. Task
 * states, evidence rows, upstream and artifact hashes, upstream drift, and the
 * exit gates are all read from files that other checks already keep honest.
 *
 * The report's most important section is the one that says the claim cannot be
 * made. A release report that reads as a summary of achievements is the exact
 * document that gets skimmed and quoted; this one leads with what is unproven,
 * because the reader who matters is deciding whether to trust it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST_PATH, canonicalJson } from "./extract.mjs";
import { DRIFT_PATH } from "./drift.mjs";
import {
  REPOSITORY_ROOT,
  UPSTREAM_COMMIT,
  UPSTREAM_REPOSITORY,
} from "./source.mjs";

const PLAN_PATH = resolve(REPOSITORY_ROOT, "docs", "parity.md");
export const REPORT_PATH = resolve(
  REPOSITORY_ROOT,
  "docs",
  "parity",
  "release-report.json",
);

/**
 * The four conditions §12 gates the parity claim on, none of which code can
 * satisfy. Named individually rather than counted, so a report cannot say
 * "3 of 4" and leave the reader guessing which one is missing.
 */
const HUMAN_GATES = Object.freeze([
  {
    id: "P12.2",
    what: "An independent reviewer who did not implement the work runs the coverage matrix",
  },
  {
    id: "P12.4",
    what: "Target hardware qualification on recorded U1 and Elegoo CC firmware",
  },
  { id: "P8.6", what: "Supervised calibration prints on both target printers" },
  { id: "P12.5", what: "Release quality and security review sign-off" },
  {
    id: "P10.5",
    what: "A Galaxy XR headset session against the acceptance matrix",
  },
]);

/** Task id, state, and title, read from the plan's own checkboxes. */
export function readTasks(plan) {
  const tasks = [];
  for (const match of plan.matchAll(
    /^- \[( |~|x|!)\] \*\*(P\d+(?:\.\d+)*) — ([^*]+)\*\*/gm,
  )) {
    tasks.push({
      id: match[2],
      state: match[1] === " " ? "unstarted" : match[1],
      title: match[3].trim(),
    });
  }
  return tasks;
}

/**
 * Expand a task reference that may be a range.
 *
 * Evidence rows write `P1.1–P1.3` as often as `P1.1, P1.2, P1.3`, and reading
 * the range as one opaque token reports the tasks inside it as uncovered. The
 * first run of this tool did exactly that and named `P1.1` as complete with no
 * evidence, which `EVID-003` plainly covers — a false alarm in the one section
 * a reviewer is meant to trust most.
 */
function expandTaskRange(token) {
  const range = /^(P\d+)\.(\d+)[–-](?:P\d+\.)?(\d+)$/.exec(token);
  if (!range) return [token];
  const [, phase, from, to] = range;
  const start = Number(from);
  const end = Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [token];
  const out = [];
  for (let index = start; index <= end; index += 1)
    out.push(`${phase}.${index}`);
  return out;
}

/** Evidence rows, by the tasks they claim to cover. */
export function readEvidence(plan) {
  const rows = [];
  for (const match of plan.matchAll(/^\| `(EVID-\d+)` \| ([^|]+) \|/gm)) {
    rows.push({
      id: match[1],
      tasks: match[2]
        .split(",")
        .map((task) => task.trim().replace(/`/g, ""))
        .filter(Boolean)
        .flatMap(expandTaskRange),
    });
  }
  return rows;
}

function hashesFor(root) {
  const entries = execFileSync(
    "git",
    ["-C", REPOSITORY_ROOT, "ls-tree", "-r", "-z", "HEAD", "--", root],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { path, blob: meta.split(" ")[2] };
    });
  return { count: entries.length, entries };
}

/**
 * Evidence ids a commit message claims that the table does not carry.
 *
 * Pure, and separate from the git call, so the detection can be exercised
 * rather than only ever observed passing — a guard nobody has seen fire is
 * indistinguishable from one that cannot.
 */
export function findUnrecordedClaims(log, recordedIds) {
  const recorded = new Set(recordedIds);
  const claimed = new Set();
  for (const match of log.matchAll(/Recorded as (EVID-\d+)/g))
    claimed.add(match[1]);
  return [...claimed].filter((id) => !recorded.has(id)).sort();
}

export function buildReleaseReport() {
  const plan = readFileSync(PLAN_PATH, "utf8");
  const tasks = readTasks(plan);
  const evidence = readEvidence(plan);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const drift = existsSync(DRIFT_PATH)
    ? JSON.parse(readFileSync(DRIFT_PATH, "utf8"))
    : null;

  const covered = new Set(evidence.flatMap((row) => row.tasks));
  const byState = {};
  for (const task of tasks)
    byState[task.state] = (byState[task.state] ?? 0) + 1;

  // A task claimed complete with nothing recorded against it is the one thing a
  // reviewer most needs pointed out, so it is computed rather than narrated.
  const completeWithoutEvidence = tasks
    .filter((task) => task.state === "x" && !covered.has(task.id))
    .map((task) => task.id);

  // Evidence ids claimed by a commit message but never written into the table.
  // Three times this session a generated docs edit failed on a stale anchor
  // while an `&&` chain committed the code anyway, so a commit said "Recorded
  // as EVID-nnn" and nothing was. Each was caught by reading the output; this
  // catches it without anyone having to.
  const log = execFileSync(
    "git",
    ["-C", REPOSITORY_ROOT, "log", "--format=%B", "-n", "200"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const claimedButUnrecorded = findUnrecordedClaims(
    log,
    evidence.map((row) => row.id),
  );

  return {
    schemaVersion: 1,
    // Deliberately first: a reader who stops after one section should stop
    // knowing the claim is not made.
    claim: {
      parityClaimPermitted: false,
      why: "P12.6 permits the full-parity claim only after every gate is verified; none of the human gates below has been.",
      humanGatesOutstanding: HUMAN_GATES,
    },
    tasks: {
      total: tasks.length,
      byState,
      unstarted: tasks
        .filter((task) => task.state === "unstarted")
        .map((task) => task.id),
      completeWithoutEvidence,
    },
    integrity: { claimedButUnrecorded },
    evidence: { rows: evidence.length, tasksCovered: covered.size },
    upstream: {
      repository: UPSTREAM_REPOSITORY,
      commit: UPSTREAM_COMMIT,
      inventoryLeaves: manifest.counts.total,
      families: Object.keys(manifest.inventory).length,
      sourceFiles: manifest.sourceFiles.length,
      drift: drift
        ? {
            pinnedTag: drift.pinned?.tag ?? null,
            latestTag: drift.latest?.tag ?? null,
            releasesBehind: drift.pinned?.releasesBehind ?? null,
            changedSourceFiles: drift.drift?.sourceFiles?.changed?.length ?? 0,
            deltasDispositioned: Object.values(drift.dispositions ?? {}).every(
              Boolean,
            ),
          }
        : null,
    },
    artifacts: {
      engine: hashesFor("web/public/slicer"),
      patches: hashesFor("server/patches"),
      calibrationGeometry: hashesFor("web/public/calibration"),
    },
  };
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const report = buildReleaseReport();
  const text = canonicalJson(report);
  if (check) {
    if (!existsSync(REPORT_PATH))
      throw new Error(
        `No release report at ${REPORT_PATH}. Run without --check.`,
      );
    if (readFileSync(REPORT_PATH, "utf8") !== text) {
      throw new Error("The committed release report is stale; regenerate it.");
    }
  } else {
    writeFileSync(REPORT_PATH, text);
  }
  console.log(
    `Release report: parity claim ${report.claim.parityClaimPermitted ? "PERMITTED" : "NOT permitted"}; ` +
      `${report.claim.humanGatesOutstanding.length} human gate(s) outstanding; ` +
      `${report.tasks.total} tasks (${report.tasks.byState.x ?? 0} complete, ${report.tasks.unstarted.length} unstarted); ` +
      `${report.evidence.rows} evidence rows.`,
  );
  if (report.integrity.claimedButUnrecorded.length > 0) {
    throw new Error(
      `Commit messages claim evidence that the table does not carry: ${report.integrity.claimedButUnrecorded.join(", ")}`,
    );
  }
  if (report.tasks.completeWithoutEvidence.length > 0) {
    console.log(
      `Complete without evidence: ${report.tasks.completeWithoutEvidence.join(", ")}`,
    );
  }
  return report;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`parity release-report: ${error.message}`);
    process.exitCode = 1;
  }
}
