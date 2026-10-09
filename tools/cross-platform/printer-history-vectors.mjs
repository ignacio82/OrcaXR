// Print history references from the production browser
// (`PrintHistoryExchange.ts` over `PrinterHistory.ts`): what every page and
// totals request sends or why it is refused, how each transport outcome
// finishes, how history and totals replies of every shape read (missing,
// blank, mistyped and huge fields; unknown outcomes; more rows than asked
// for; counts that are not counts), and how a panel describes durations,
// lengths, jobs, totals and pages. Replayed by Rust, WASM (Node, Chrome) and
// JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerHistoryDuration,
  answerHistoryFilament,
  answerHistoryFinish,
  answerHistoryJobView,
  answerHistoryPageView,
  answerHistoryPlan,
  answerHistoryRead,
  answerHistoryTotalsText,
} from "../../web/src/printer/PrintHistoryExchange.ts";
import {
  PrintHistoryError,
  listPrintHistory,
} from "../../web/src/printer/PrinterHistory.ts";
import {
  encodeProjectOptionalPrintHistoryTotals,
  encodeProjectOptionalText,
  encodeProjectPrintHistoryFinish,
  encodeProjectPrintHistoryJob,
  encodeProjectPrintHistoryJobView,
  encodeProjectPrintHistoryOperation,
  encodeProjectPrintHistoryPageShape,
  encodeProjectPrintHistoryPageView,
  encodeProjectPrintHistoryPlan,
  encodeProjectPrintHistoryResult,
  encodeProjectPrinterText,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const finite = (value) => (value === undefined ? absent : { value });

// Seeded, so the corpus is the same every run.
let seed = 0x415;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

const pageNumbers = [
  undefined,
  0,
  1,
  2,
  19,
  20,
  40,
  99,
  100,
  101,
  -1,
  -0,
  0.5,
  1e21,
  2 ** 53 - 1,
  2 ** 53,
  -(2 ** 53),
];
const operations = [{ totals: {} }];
for (const start of pageNumbers)
  for (const limit of pageNumbers)
    operations.push({ page: { start: finite(start), limit: finite(limit) } });

const planCases = [];
for (const operation of operations)
  planCases.push({
    requestJson: encodeProjectPrintHistoryOperation(operation),
    replyJson: encodeProjectPrintHistoryPlan(
      await answerHistoryPlan(operation),
    ),
  });

const codes = [
  "invalidEndpoint",
  "invalidCredentials",
  "invalidState",
  "invalidRequest",
  "cancelled",
  "timeout",
  "network",
  "authRequired",
  "forbidden",
  "httpError",
  "invalidResponse",
  "protocolError",
  "versionUnsupported",
  "websocketUnavailable",
  "websocketFailed",
  "heartbeatTimeout",
  "reconnectExhausted",
];
const outcomes = [
  { done: {} },
  { cancelled: {} },
  { failed: { code: absent, httpStatus: absent, detail: absent } },
  ...codes.map((code) => ({
    failed: {
      code: { value: code },
      httpStatus: code === "httpError" ? { value: 500 } : absent,
      detail: code === "httpError" ? { value: units("boom") } : absent,
    },
  })),
];
const finishCases = [];
for (const operation of operations)
  for (const outcome of outcomes) {
    if (random() > 0.2 && !("done" in outcome)) continue;
    const request = { operation, outcome };
    finishCases.push({
      requestJson: encodeProjectPrintHistoryFinish(request),
      replyJson: encodeProjectPrintHistoryResult(
        await answerHistoryFinish(request),
      ),
    });
  }

// History replies: every field present, missing, blank, mistyped or huge.
const statuses = [
  "completed",
  "cancelled",
  "error",
  "klippy_shutdown",
  "klippy_disconnect",
  "in_progress",
  "interrupted",
  "server_exit",
  "",
  "  ",
  " completed ",
  "Completed",
  "x\uD800",
  undefined,
  7,
];
const times = [
  undefined,
  0,
  -5,
  1_800_000_000,
  1_800_000_000.0005,
  1e306,
  "1800000000",
  null,
];
const durations = [undefined, 0, 1, 59.5, 5100, 1e300, -3, "60", null];
const filenames = [
  "tower.gcode",
  "projects/tower.gcode",
  "  padded.gcode ",
  "",
  "   ",
  "ümlaut 😀.gcode",
  undefined,
  3,
];
function jobEntry() {
  const entry = {};
  const filename = pick(filenames);
  if (filename !== undefined) entry.filename = filename;
  const id = pick(["000001", "000002", " 000003 ", "", undefined, 4, filename]);
  if (id !== undefined) entry.job_id = id;
  const status = pick(statuses);
  if (status !== undefined) entry.status = status;
  for (const key of ["start_time", "end_time"])
    if (random() < 0.8) entry[key] = pick(times);
  for (const key of ["print_duration", "total_duration", "filament_used"])
    if (random() < 0.7) entry[key] = pick(durations);
  if (random() < 0.7) entry.exists = pick([true, false, 0, "false", null]);
  if (random() < 0.6)
    entry.metadata = pick([
      { estimated_time: pick(durations) },
      {},
      null,
      "meta",
      { estimated_time: 0 },
    ]);
  return random() < 0.06 ? pick([null, "job", 3, []]) : entry;
}
const counts = [undefined, 0, 3, 57, -5, 2.5, 1e300, "57", null, 2 ** 53];
const historyReplies = [
  JSON.stringify(null),
  JSON.stringify([]),
  JSON.stringify("history"),
  JSON.stringify({}),
  JSON.stringify({ jobs: "nope", count: 4 }),
  JSON.stringify({
    count: 57,
    jobs: [
      {
        job_id: "000001",
        filename: "projects/tower.gcode",
        status: "completed",
        start_time: 1_800_000_000,
        end_time: 1_800_005_400,
        print_duration: 5100,
        total_duration: 5400,
        filament_used: 4210.5,
        exists: true,
        metadata: { estimated_time: 4800 },
      },
      {
        job_id: "000002",
        filename: "cube.gcode",
        status: "in_progress",
        start_time: 1_800_010_000,
        end_time: 0,
        exists: false,
      },
      {
        job_id: "000003",
        filename: "odd.gcode",
        status: "server_exit",
        start_time: 1_700_000_000,
      },
      { job_id: "000004", status: "completed" },
    ],
  }),
  '{"count":2,"jobs":[{"filename":"a.gcode","filename":"b.gcode","status":"completed"}]}',
];
for (let i = 0; i < 50; i++) {
  const reply = {};
  if (random() < 0.9)
    reply.jobs = Array.from({ length: Math.floor(random() * 8) }, jobEntry);
  const count = pick(counts);
  if (count !== undefined) reply.count = count;
  historyReplies.push(JSON.stringify(reply));
}
// More rows than any page asks for.
historyReplies.push(
  JSON.stringify({
    count: 500,
    jobs: Array.from({ length: 150 }, (_, i) => ({
      job_id: String(i).padStart(6, "0"),
      filename: `print_${i}.gcode`,
      status: statuses[i % 8],
      print_duration: i * 37,
      metadata: { estimated_time: i * 35 },
    })),
  }),
);
const totalsReplies = [
  JSON.stringify(null),
  JSON.stringify({}),
  JSON.stringify({ job_totals: null }),
  JSON.stringify({ job_totals: [] }),
  JSON.stringify({ job_totals: {} }),
  JSON.stringify({
    job_totals: {
      total_jobs: 57,
      total_time: 360_000,
      total_print_time: 320_000,
      total_filament_used: 812_345.6,
      longest_job: 36_000,
      longest_print: 32_400,
    },
  }),
];
for (let i = 0; i < 20; i++) {
  const totals = {};
  for (const key of [
    "total_jobs",
    "total_time",
    "total_print_time",
    "total_filament_used",
    "longest_job",
    "longest_print",
  ])
    if (random() < 0.7) totals[key] = pick([...durations, ...counts]);
  totalsReplies.push(JSON.stringify({ job_totals: totals }));
}
const readCases = [];
for (const reply of historyReplies)
  for (const page of [
    { start: absent, limit: absent },
    { start: finite(40), limit: finite(20) },
    { start: finite(0), limit: finite(2) },
    {
      start: finite(pick(pageNumbers.filter(Boolean))),
      limit: finite(pick(pageNumbers.filter(Boolean))),
    },
  ])
    readCases.push({ operation: { page }, reply });
for (const reply of totalsReplies)
  readCases.push({ operation: { totals: {} }, reply });
// The ids the browser gives a page's jobs, as UTF-16 units (`,`) per id
// (`;`): the wire carries the printer's id only where it differs.
async function browserIds(operation, reply) {
  if (!("page" in operation)) return [];
  const value = (field) => ("value" in field ? field.value : undefined);
  const start = value(operation.page.start);
  const limit = value(operation.page.limit);
  try {
    const page = await listPrintHistory(
      { request: async () => JSON.parse(reply) },
      {
        ...(start === undefined ? {} : { start }),
        ...(limit === undefined ? {} : { limit }),
      },
    );
    return page.jobs.map((job) => job.id);
  } catch (error) {
    if (error instanceof PrintHistoryError) return [];
    throw error;
  }
}
const readRecords = [];
const readJobs = [];
for (const { operation, reply } of readCases) {
  const result = await answerHistoryRead(operation, reply);
  if ("page" in result) readJobs.push(...result.page.jobs);
  readRecords.push({
    operationJson: encodeProjectPrintHistoryOperation(operation),
    reply,
    replyJson: encodeProjectPrintHistoryResult(result),
    ids: (await browserIds(operation, reply))
      .map((id) => units(id).join(","))
      .join(";"),
  });
}

// What a panel shows.
const numbers = [
  0,
  0.4,
  0.5,
  9,
  59.5,
  60,
  90,
  3599.5,
  3600,
  5400,
  86_399,
  1e7,
  1e300,
  -1,
  -0,
  Number.NaN,
  Infinity,
  -Infinity,
  420,
  999.4,
  999.5,
  1000,
  4210.5,
  1_234_567.891,
  1e21 * 1000,
];
for (let i = 0; i < 30; i++)
  numbers.push(random() * 10 ** Math.floor(random() * 8));
const durationCases = numbers.map((seconds) => ({
  seconds,
  replyJson: encodeProjectOptionalText(answerHistoryDuration(seconds)),
}));
const filamentCases = numbers.map((millimetres) => ({
  millimetres,
  replyJson: encodeProjectOptionalText(answerHistoryFilament(millimetres)),
}));
const unique = new Map();
for (const job of readJobs) unique.set(encodeProjectPrintHistoryJob(job), job);
for (const [printSeconds, estimatedSeconds] of [
  [5100, 4800],
  [60, 60],
  [4799, 4800],
  [100, 0],
  [0, 100],
  [100, -5],
  [1e300, 1e-300],
  [-0.004, 1],
])
  for (const filamentUsedMm of [undefined, 420, 4210.5]) {
    const job = {
      jobId: absent,
      filename: units("x.gcode"),
      status: "completed",
      rawStatus: absent,
      startedAtMs: absent,
      endedAtMs: absent,
      printSeconds: finite(printSeconds),
      totalSeconds: absent,
      filamentUsedMm: finite(filamentUsedMm),
      fileExists: true,
      estimatedSeconds: finite(estimatedSeconds),
    };
    unique.set(encodeProjectPrintHistoryJob(job), job);
  }
const jobViewCases = [...unique].map(([requestJson, job]) => ({
  requestJson,
  replyJson: encodeProjectPrintHistoryJobView(answerHistoryJobView(job)),
}));
const totalsTextCases = [];
for (const { reply } of readCases.filter((c) => "totals" in c.operation)) {
  const result = await answerHistoryRead({ totals: {} }, reply);
  if ("totals" in result) {
    const request = { value: result.totals };
    totalsTextCases.push({
      requestJson: encodeProjectOptionalPrintHistoryTotals(request),
      replyJson: encodeProjectPrinterText(answerHistoryTotalsText(request)),
    });
  }
}
totalsTextCases.push({
  requestJson: encodeProjectOptionalPrintHistoryTotals(absent),
  replyJson: encodeProjectPrinterText(answerHistoryTotalsText(absent)),
});
const shapes = [
  [20, 57, 20, 20],
  [17, 57, 40, 20],
  [0, 0, 0, 20],
  [1, 1, 0, 20],
  [2, 5, 0, 2],
  [0, 0, 1e21, 20],
  [100, 1e300, 0, 100],
  [3, 3, 0, 1],
  [0, 43, 40, 20],
];
for (let i = 0; i < 30; i++) {
  const limit = 1 + Math.floor(random() * 100);
  const total = Math.floor(random() * 1000);
  const start = Math.floor(random() * 50) * limit;
  shapes.push([
    Math.min(limit, Math.max(0, total - start)),
    total,
    start,
    limit,
  ]);
}
const pageViewCases = shapes.map(([jobCount, total, start, limit]) => {
  const shape = { jobCount, total, start, limit };
  return {
    requestJson: encodeProjectPrintHistoryPageShape(shape),
    replyJson: encodeProjectPrintHistoryPageView(answerHistoryPageView(shape)),
  };
});

const sources = [
  "tools/cross-platform/printer-history-vectors.mjs",
  "web/src/printer/PrintHistoryExchange.ts",
  "web/src/printer/PrinterHistory.ts",
  "web/src/printer/PrinterWire.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const corpus = {
  plans: planCases,
  finishes: finishCases,
  reads: readRecords,
  durations: durationCases,
  filaments: filamentCases,
  jobViews: jobViewCases,
  totalsTexts: totalsTextCases,
  pageViews: pageViewCases,
};
// Durations and lengths include non-finite numbers, which JSON cannot spell:
// they travel as text.
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      ...corpus,
    },
    (key, value) =>
      (key === "seconds" || key === "millimetres") &&
      typeof value === "number" &&
      !Number.isFinite(value)
        ? String(value)
        : value,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-history-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Print history reference drift",
  );
console.log(
  `Print history references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
