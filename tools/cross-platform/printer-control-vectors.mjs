// Printer control references from the production browser
// (`PrinterControlExchange.ts` over `PrintJobControl.ts` and
// `PrinterStatusSummary.ts`): command availability for every reported state and
// Klippy readiness, what each command sends or why it is refused (unreported
// state, expected file changed), the sentence a failed or cancelled send
// reports for every transport error, compact status summaries over snapshots,
// connections and reading ages, guarded actions with and without a stale
// reading, and hold-to-confirm gestures. Replayed by Rust, WASM (Node,
// Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PrintJobStatusModel } from "../../web/src/printer/PrintJobStatus.ts";
import { printJobSnapshotWire } from "../../web/src/printer/PrintJobStatusExchange.ts";
import {
  answerGuardedPrinterActions,
  answerPrintJobAvailability,
  answerPrintJobCommandCheck,
  answerPrintJobCommandFailure,
  answerPrinterStatus,
  guardedActionFromWire,
  holdReleaseWire,
  holdStateWire,
} from "../../web/src/printer/PrinterControlExchange.ts";
import { HoldToConfirm } from "../../web/src/printer/PrinterStatusSummary.ts";
import {
  decodeProjectGuardedPrinterAction,
  decodeProjectGuardedPrinterActionsRequest,
  decodeProjectPrintJobAvailabilityRequest,
  decodeProjectPrintJobCommandCheckRequest,
  decodeProjectPrintJobCommandFailureRequest,
  decodeProjectPrinterStatusRequest,
  encodeProjectGuardedPrinterAction,
  encodeProjectGuardedPrinterActions,
  encodeProjectGuardedPrinterActionsRequest,
  encodeProjectHoldToConfirmRelease,
  encodeProjectHoldToConfirmState,
  encodeProjectPrintJobAvailabilityRequest,
  encodeProjectPrintJobCommandCheckRequest,
  encodeProjectPrintJobCommandDescriptors,
  encodeProjectPrintJobCommandFailureRequest,
  encodeProjectPrintJobCommandPlan,
  encodeProjectPrintJobCommandRefusal,
  encodeProjectPrinterStatusRequest,
  encodeProjectPrinterStatusSummary,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const absent = { absent: {} };
const optional = (value) => (value === undefined ? absent : { value });

// --- Snapshots ------------------------------------------------------------------
/** A browser snapshot from one query payload, on the shared wire. */
const snapshot = (status, nowMs = 1_000) =>
  printJobSnapshotWire(new PrintJobStatusModel().applyQuery({ status }, nowMs));
const STATES = [
  "standby",
  "printing",
  "paused",
  "complete",
  "cancelled",
  "error",
  "bogus",
];
const KLIPPY = ["ready", "startup", "shutdown", undefined, ""];
const snapshots = [];
for (const state of STATES)
  for (const klippy of KLIPPY)
    snapshots.push(
      snapshot({
        ...(klippy === undefined ? {} : { webhooks: { state: klippy } }),
        print_stats: {
          state,
          filename: state === "complete" ? "" : `job-${state}.gcode`,
          message: state === "error" ? "MCU shutdown" : "",
        },
      }),
    );
const rich = [
  snapshot(
    {
      webhooks: { state: "ready" },
      print_stats: {
        state: "printing",
        filename: "Plate_1.gcode",
        print_duration: 600,
        info: { current_layer: 12, total_layer: 98 },
      },
      virtual_sdcard: { progress: 0.25 },
      extruder: { temperature: 219.6, target: 220 },
      heater_bed: { temperature: 59.5, target: 0 },
    },
    1_000,
  ),
  snapshot(
    {
      webhooks: { state: "ready" },
      print_stats: {
        state: "paused",
        filename: "lone \ud800.gcode",
        print_duration: 3599.5,
      },
      virtual_sdcard: { progress: 0.004 },
    },
    5_000,
  ),
  snapshot(
    {
      webhooks: { state: "ready" },
      print_stats: { state: "printing", print_duration: 59.5 },
      virtual_sdcard: { progress: 0.995 },
    },
    0,
  ),
  snapshot(
    {
      webhooks: { state: "ready" },
      print_stats: { state: "printing", print_duration: 1e21 },
      virtual_sdcard: { progress: 0.5 },
    },
    7,
  ),
  snapshot(
    {
      webhooks: { state: "ready" },
      print_stats: { state: "standby", message: "Ready to print" },
      extruder: { temperature: -0.4 },
      heater_bed: { temperature: 24.5, target: 60.5 },
    },
    1,
  ),
  snapshot(
    {
      print_stats: {
        state: "printing",
        info: { current_layer: 0, total_layer: 1e300 },
      },
      display_status: { progress: 1.5 },
    },
    2_000,
  ),
  snapshot({ print_stats: { state: "error" } }, 3_000),
  snapshot(
    {
      print_stats: { state: "complete", filename: "done.gcode" },
      virtual_sdcard: { progress: 1 },
    },
    4_000,
  ),
  snapshot(
    { print_stats: { state: "standby" }, virtual_sdcard: { progress: -0 } },
    9_000,
  ),
];
const allSnapshots = [...snapshots, ...rich];

// --- Availability and command checks ----------------------------------------------
const availability = [];
for (const observed of [undefined, ...allSnapshots]) {
  const request = decodeProjectPrintJobAvailabilityRequest(
    encodeProjectPrintJobAvailabilityRequest({ observed: optional(observed) }),
  );
  availability.push({
    requestJson: encodeProjectPrintJobAvailabilityRequest(request),
    replyJson: encodeProjectPrintJobCommandDescriptors(
      answerPrintJobAvailability(request),
    ),
  });
}
const COMMANDS = [
  "pause",
  "resume",
  "cancel",
  "emergencyStop",
  "firmwareRestart",
];
const checks = [];
for (const command of COMMANDS)
  for (const observed of [undefined, ...allSnapshots])
    for (const expected of [
      undefined,
      "job-printing.gcode",
      "Plate_1.gcode",
      "lone \ud800.gcode",
      "other.gcode",
    ]) {
      const request = decodeProjectPrintJobCommandCheckRequest(
        encodeProjectPrintJobCommandCheckRequest({
          command,
          observed: optional(observed),
          expectedFilename:
            expected === undefined ? absent : { value: units(expected) },
        }),
      );
      checks.push({
        requestJson: encodeProjectPrintJobCommandCheckRequest(request),
        replyJson: encodeProjectPrintJobCommandPlan(
          await answerPrintJobCommandCheck(request),
        ),
      });
    }

// --- Failures ---------------------------------------------------------------------
const CODES = [
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
const failures = [];
for (const command of COMMANDS)
  for (const code of [undefined, ...CODES])
    for (const cancelled of [false, true]) {
      if (cancelled && code !== undefined && code !== "timeout") continue;
      const request = decodeProjectPrintJobCommandFailureRequest(
        encodeProjectPrintJobCommandFailureRequest({
          command,
          transportCode: optional(code),
          cancelled,
        }),
      );
      failures.push({
        requestJson: encodeProjectPrintJobCommandFailureRequest(request),
        replyJson: encodeProjectPrintJobCommandRefusal(
          await answerPrintJobCommandFailure(request),
        ),
      });
    }

// --- Status summaries ----------------------------------------------------------------
const CONNECTIONS = [
  undefined,
  { connected: {} },
  { connecting: {} },
  { disconnected: {} },
  { reconnecting: { delayMs: 1499 } },
  { reconnecting: { delayMs: -2500 } },
  { reconnecting: { delayMs: 30_500 } },
  ...CODES.map((code) => ({ error: { code } })),
];
const AGES = [
  0,
  4_499,
  4_500,
  89_499,
  89_500,
  3_600_000,
  5_369_999,
  5_370_000,
  30 * 3_600_000,
  -5,
];
const summaries = [];
const summarize = (request) => {
  const decoded = decodeProjectPrinterStatusRequest(
    encodeProjectPrinterStatusRequest(request),
  );
  summaries.push({
    requestJson: encodeProjectPrinterStatusRequest(decoded),
    replyJson: encodeProjectPrinterStatusSummary(answerPrinterStatus(decoded)),
  });
};
for (const connection of CONNECTIONS)
  for (const observed of [undefined, ...allSnapshots])
    summarize({
      snapshot: optional(observed),
      connection: optional(connection),
      nowMs: (observed?.updatedAtMs ?? 0) + 60_000,
      configured: true,
    });
for (const age of AGES)
  for (const observed of rich.slice(0, 3))
    for (const connection of [
      undefined,
      { reconnecting: { delayMs: 2000 } },
      { connected: {} },
    ])
      summarize({
        snapshot: optional(observed),
        connection: optional(connection),
        nowMs: observed.updatedAtMs + age,
        configured: true,
      });
for (const connection of [
  undefined,
  { connected: {} },
  { error: { code: "network" } },
])
  summarize({
    snapshot: optional(rich[0]),
    connection: optional(connection),
    nowMs: 0,
    configured: false,
  });

// --- Guarded actions -----------------------------------------------------------------------
const guarded = [];
for (const entry of availability) {
  const descriptors = JSON.parse(entry.replyJson);
  const variants = [
    descriptors,
    // A host may lift recovery commands as the browser shell does.
    descriptors.map((d) =>
      d.command === "emergencyStop"
        ? { ...d, allowed: true, reason: absent }
        : d,
    ),
    descriptors.map((d) => ({ ...d, reason: { value: [] } })),
  ];
  for (const list of variants)
    for (const stale of [false, true])
      for (const staleReason of [undefined, "Custom stale reason"]) {
        const request = decodeProjectGuardedPrinterActionsRequest(
          encodeProjectGuardedPrinterActionsRequest({
            descriptors: list,
            stale,
            staleReason:
              staleReason === undefined
                ? absent
                : { value: units(staleReason) },
          }),
        );
        guarded.push({
          requestJson: encodeProjectGuardedPrinterActionsRequest(request),
          replyJson: encodeProjectGuardedPrinterActions(
            answerGuardedPrinterActions(request),
          ),
        });
      }
}

// --- Hold to confirm ----------------------------------------------------------------------
const actionsFor = (stale) =>
  answerGuardedPrinterActions(
    decodeProjectGuardedPrinterActionsRequest(
      encodeProjectGuardedPrinterActionsRequest({
        descriptors: answerPrintJobAvailability({
          observed: {
            value: snapshots[STATES.indexOf("printing") * KLIPPY.length],
          },
        }),
        stale,
        staleReason: absent,
      }),
    ),
  );
const enabled = actionsFor(false);
const disabled = actionsFor(true);
const action = (list, command) => list.find((a) => a.command === command);
function holdTrace(name, steps) {
  let now = 0;
  const hold = new HoldToConfirm({ now: () => now });
  return {
    name,
    steps: steps.map(([op, at, chosen]) => {
      now = at;
      let replyJson;
      if (op === "press") {
        const wire = decodeProjectGuardedPrinterAction(
          encodeProjectGuardedPrinterAction(chosen),
        );
        replyJson = encodeProjectHoldToConfirmState(
          holdStateWire(hold.press(guardedActionFromWire(wire))),
        );
        return {
          op,
          nowMs: at,
          actionJson: encodeProjectGuardedPrinterAction(wire),
          replyJson,
        };
      }
      if (op === "poll")
        replyJson = encodeProjectHoldToConfirmState(holdStateWire(hold.poll()));
      else if (op === "cancel")
        replyJson = encodeProjectHoldToConfirmState(
          holdStateWire(hold.cancel()),
        );
      else
        replyJson = encodeProjectHoldToConfirmRelease(
          holdReleaseWire(hold.release()),
        );
      return { op, nowMs: at, replyJson };
    }),
  };
}
const holds = [
  holdTrace("cancel-held", [
    ["press", 100, action(enabled, "cancel")],
    ["poll", 500],
    ["poll", 900],
    ["release", 900],
  ]),
  holdTrace("cancel-early", [
    ["press", 100, action(enabled, "cancel")],
    ["poll", 899.5],
    ["release", 899.5],
    ["poll", 1000],
  ]),
  holdTrace("pause-tap", [
    ["press", 5, action(enabled, "pause")],
    ["poll", 5],
    ["release", 5],
  ]),
  holdTrace("emergency", [
    ["press", 0, action(enabled, "emergencyStop")],
    ["poll", 600],
    ["release", 1199],
    ["press", 2000, action(enabled, "emergencyStop")],
    ["release", 3200],
  ]),
  holdTrace("disabled", [
    ["press", 0, action(disabled, "pause")],
    ["release", 10],
    ["press", 20, action(enabled, "cancel")],
    ["press", 30, action(disabled, "cancel")],
    ["poll", 420],
    ["release", 820],
  ]),
  holdTrace("abandoned", [
    ["press", 0, action(enabled, "firmwareRestart")],
    ["poll", 400],
    ["cancel", 500],
    ["release", 900],
    ["poll", 1000],
  ]),
  holdTrace("switched", [
    ["press", 0, action(enabled, "cancel")],
    ["press", 100, action(enabled, "pause")],
    ["release", 100],
  ]),
  holdTrace("clock-back", [
    ["press", 1000, action(enabled, "cancel")],
    ["poll", 500],
    ["release", 1799],
    ["press", 2000, action(enabled, "firmwareRestart")],
    ["release", 2800],
  ]),
];

const sources = [
  "tools/cross-platform/printer-control-vectors.mjs",
  "web/src/printer/PrinterControlExchange.ts",
  "web/src/printer/PrintJobControl.ts",
  "web/src/printer/PrinterStatusSummary.ts",
  "web/src/printer/PrintJobStatus.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    availability,
    checks,
    failures,
    summaries,
    guarded,
    holds,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-control-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer control reference drift",
  );
console.log(
  `Printer control: ${availability.length} availabilities, ${checks.length} command checks, ${failures.length} failures, ${summaries.length} summaries, ${guarded.length} guarded lists, ${holds.length} hold traces (${holds.reduce((n, h) => n + h.steps.length, 0)} steps)`,
);
