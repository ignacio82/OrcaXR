// Print job status references from the production browser (`PrintJobStatus.ts`
// through `PrintJobStatusExchange.ts`): traces of full queries, partial
// `notify_status_update` patches and resets, each step's text exactly as a
// host would receive it, with the browser's reply (a snapshot, an ignored
// patch, or text JSON.parse refuses) and the model's snapshot afterwards.
// Hand-written traces cover nested merges, state spellings, numbers JSON.parse
// reads as infinities, duplicate keys, lone surrogates, prototype-named keys
// and `__proto__` patches; seeded traces mix random patches over every object
// the model reads and some it does not. Replayed by Rust, WASM (Node, Chrome)
// and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PrintJobStatusModel } from "../../web/src/printer/PrintJobStatus.ts";
import { printJobSnapshotWire } from "../../web/src/printer/PrintJobStatusExchange.ts";
import { encodeProjectPrintJobSnapshot } from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const wire = (snapshot) =>
  encodeProjectPrintJobSnapshot(printJobSnapshotWire(snapshot));

/** Run one trace through a fresh browser model, recording every step. */
function trace(name, steps) {
  const model = new PrintJobStatusModel();
  const recorded = steps.map(([op, text, nowMs]) => {
    let reply;
    if (op === "reset") {
      reply = { snapshotJson: wire(model.reset()) };
    } else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
        reply = { refusal: "invalid_json" };
      }
      if (!reply) {
        const next =
          op === "query"
            ? model.applyQuery(parsed, nowMs)
            : model.applyNotification(parsed, nowMs);
        reply =
          next === null ? { ignored: true } : { snapshotJson: wire(next) };
      }
    }
    return {
      op,
      ...(text === undefined ? {} : { text }),
      ...(nowMs === undefined ? {} : { nowMs }),
      ...reply,
      currentJson: wire(model.snapshot),
    };
  });
  return { name, steps: recorded };
}
const q = (value, nowMs) => [
  "query",
  typeof value === "string" ? value : JSON.stringify(value),
  nowMs,
];
const n = (value, nowMs) => [
  "notify",
  typeof value === "string" ? value : JSON.stringify(value),
  nowMs,
];
const reset = ["reset"];

const QUERY = {
  status: {
    webhooks: { state: "ready" },
    print_stats: {
      state: "printing",
      filename: "PeggyPalette_Plate_1.gcode",
      print_duration: 600,
      total_duration: 640,
      filament_used: 1234.5,
      message: "",
      info: { current_layer: 12, total_layer: 98 },
    },
    virtual_sdcard: { progress: 0.25, is_active: true, file_position: 1024 },
    display_status: { progress: 0.24, message: null },
    extruder: { temperature: 219.6, target: 220 },
    heater_bed: { temperature: 59.9, target: 60 },
  },
  eventtime: 1234.5,
};

const traces = [
  trace("print-lifecycle", [
    q(QUERY, 1_000),
    n([{ print_stats: { info: { current_layer: 13 } } }, 1235], 2_000),
    n(
      [
        { virtual_sdcard: { progress: 0.5 }, extruder: { temperature: 220.1 } },
        1236,
      ],
      3_000,
    ),
    n([{ print_stats: { state: "paused" } }, 1237], 4_000),
    n(
      [{ print_stats: { state: "printing", print_duration: 1200 } }, 1238],
      5_000,
    ),
    n(
      [
        { virtual_sdcard: { progress: 1 }, print_stats: { state: "complete" } },
        1239,
      ],
      6_000,
    ),
    n([{ gcode_move: { speed: 3000 } }, 1240], 7_000),
    reset,
    q({ status: { webhooks: { state: "startup" } } }, 8_000),
  ]),
  trace("errors-and-cancels", [
    q(
      {
        status: {
          print_stats: {
            state: "error",
            message: "MCU 'mcu' shutdown: Timer too close",
          },
          webhooks: { state: "shutdown" },
        },
      },
      10,
    ),
    n({ print_stats: { state: "Canceled", message: "" } }, 20),
    n({ print_stats: { state: "CANCELLED" } }, 30),
    n({ print_stats: { state: "standBY" } }, 40),
    n({ print_stats: { state: "printing " } }, 50),
    n({ print_stats: { state: "İdle" } }, 60),
    n({ print_stats: { state: 7 } }, 70),
    n({ print_stats: { state: null } }, 80),
  ]),
  trace("query-shapes", [
    q([], 1),
    q(null, 2),
    q("x", 3),
    q({ status: [] }, 4),
    q({ status: null }, 5),
    q({ result: QUERY }, 6),
    q(QUERY, 7),
    q({ status: { print_stats: { filename: "b.gcode" } } }, 8),
  ]),
  trace("notification-shapes", [
    q(QUERY, 100),
    n([], 101),
    n([null, 1], 102),
    n([[{ print_stats: { state: "paused" } }], 1], 103),
    n("x", 104),
    n(7, 105),
    n({}, 106),
    n({ toolhead: { position: [0, 0, 0, 0] } }, 107),
    n('[{"constructor": {"state": "error"}}, 1]', 108),
    n('[{"toString": 1, "hasOwnProperty": {}}, 1]', 109),
    n('[{"__proto__": {"print_stats": {"state": "error"}}}, 1]', 110),
    n([{ print_stats: { state: "paused" }, toolhead: {} }, 1], 111),
    n([{ print_stats: 7 }, 1], 112),
    n([{ print_stats: [1, 2] }, 1], 113),
  ]),
  trace("nested-merges", [
    q({ status: { print_stats: { info: { current_layer: 5 } } } }, 1),
    n([{ print_stats: { info: { total_layer: 10 } } }], 2),
    n([{ print_stats: { info: 7 } }], 3),
    n([{ print_stats: { info: { current_layer: 1 } } }], 4),
    n(
      [{ print_stats: { info: { current_layer: { deep: { deeper: 1 } } } } }],
      5,
    ),
    n(
      [{ print_stats: { info: { current_layer: { deep: { other: 2 } } } } }],
      6,
    ),
    n([{ print_stats: { info: { current_layer: 4 } } }], 7),
    n(
      '[{"print_stats": {"__proto__": {"state": "printing", "info": {"total_layer": 9}}}}, 1]',
      8,
    ),
    n(
      '[{"print_stats": {"state": "paused", "state": "printing", "info": {"current_layer": 3, "current_layer": 6}}}, 1]',
      9,
    ),
  ]),
  trace("numbers", [
    q(
      {
        status: {
          print_stats: {
            print_duration: 100,
            total_duration: -5,
            filament_used: 0,
          },
        },
      },
      1,
    ),
    n(
      '[{"print_stats": {"print_duration": 1e400, "total_duration": -1e400, "filament_used": -0}}, 1]',
      2,
    ),
    n(
      '[{"virtual_sdcard": {"progress": 1e400}, "display_status": {"progress": 0.5}}, 1]',
      3,
    ),
    n(
      [
        {
          print_stats: { print_duration: 300 },
          virtual_sdcard: { progress: 0.02 },
        },
      ],
      4,
    ),
    n([{ virtual_sdcard: { progress: 0.020000000000000004 } }], 5),
    n([{ virtual_sdcard: { progress: 1 } }], 6),
    n([{ virtual_sdcard: { progress: 1.5 } }], 7),
    n([{ virtual_sdcard: { progress: -0.5 } }], 8),
    n(
      [
        {
          virtual_sdcard: { progress: "0.5" },
          display_status: { progress: 0.75 },
        },
      ],
      9,
    ),
    n(
      [
        {
          print_stats: { print_duration: 0 },
          virtual_sdcard: { progress: 0.5 },
        },
      ],
      10,
    ),
    n([{ print_stats: { print_duration: -10 } }], 11),
    n([{ print_stats: { info: { current_layer: 3.5, total_layer: -1 } } }], 12),
    n(
      [{ print_stats: { info: { current_layer: 1e300, total_layer: "12" } } }],
      13,
    ),
    n(
      '[{"print_stats": {"info": {"current_layer": -0, "total_layer": 0}}}, 1]',
      14,
    ),
    n(
      [
        {
          extruder: { temperature: 21.5 },
          heater_bed: { temperature: "60", target: 60 },
        },
      ],
      15,
    ),
    n(
      '[{"extruder": {"temperature": 1e400, "target": 200}, "heater_bed": {"temperature": 61, "target": 1e400}}, 1]',
      16,
    ),
    n(
      [
        {
          print_stats: { print_duration: 0.1 },
          virtual_sdcard: { progress: 0.3 },
        },
      ],
      17,
    ),
  ]),
  trace("text", [
    q(
      {
        status: {
          webhooks: { state: "" },
          print_stats: { filename: "", message: "" },
        },
      },
      1,
    ),
    n(
      '[{"print_stats": {"filename": "lone \\ud800 part.gcode", "message": "caf\\u00e9 \\ud83e\\udde9"}}, 1]',
      2,
    ),
    n([{ webhooks: { state: 5 }, virtual_sdcard: { is_active: "true" } }], 3),
    n([{ virtual_sdcard: { is_active: false } }], 4),
    n([{ print_stats: { filename: ["a"] } }], 5),
  ]),
  trace("refusals", [
    q(QUERY, 1),
    n("{", 2),
    q("not json", 3),
    n("[1,]", 4),
    n("01", 5),
    q('{"status": {"print_stats": {"state": "paused"}}} trailing', 6),
    n([{ print_stats: { state: "paused" } }], 7),
  ]),
];

// --- Seeded traces ---------------------------------------------------------------
let seed = 0x9e3779b9;
const next = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
};
const pick = (items) => items[Math.floor(next() * items.length)];
const OBJECTS = [
  "webhooks",
  "print_stats",
  "virtual_sdcard",
  "display_status",
  "extruder",
  "heater_bed",
  "toolhead",
  "gcode_move",
];
const FIELDS = {
  webhooks: ["state", "state_message"],
  print_stats: [
    "state",
    "filename",
    "message",
    "print_duration",
    "total_duration",
    "filament_used",
    "info",
  ],
  virtual_sdcard: ["progress", "is_active", "file_position"],
  display_status: ["progress", "message"],
  extruder: ["temperature", "target", "power"],
  heater_bed: ["temperature", "target", "power"],
  toolhead: ["position", "homed_axes"],
  gcode_move: ["speed"],
};
const STATES = [
  "printing",
  "paused",
  "complete",
  "cancelled",
  "canceled",
  "error",
  "standby",
  "PRINTING",
  "Paused",
  "ready",
  "",
];
const value = (field, depth = 0) => {
  const roll = next();
  if (field === "info" && roll < 0.7)
    return Object.fromEntries(
      ["current_layer", "total_layer"]
        .filter(() => next() < 0.7)
        .map((k) => [k, pick([0, 1, 7, 12, 98, 3.5, -1, "4", null])]),
    );
  if (field === "state" && roll < 0.8) return pick(STATES);
  if (roll < 0.45)
    return pick([
      0, 0.01, 0.02, 0.25, 0.5, 0.99, 1, 1.25, -0.5, 60, 219.6, 600, 1234.5,
      -12,
    ]);
  if (roll < 0.6)
    return pick(["", "a.gcode", "Plate_2.gcode", "Klipper state: Ready"]);
  if (roll < 0.7) return pick([true, false]);
  if (roll < 0.78) return null;
  if (roll < 0.86) return [pick([1, "x", null])];
  if (depth < 2)
    return { [pick(["nested", "info", "x"])]: value(field, depth + 1) };
  return 0;
};
const patch = () => {
  const status = {};
  for (let i = 0, count = 1 + Math.floor(next() * 3); i < count; i += 1) {
    const object = pick(OBJECTS);
    const fields = {};
    for (let j = 0, many = Math.floor(next() * 4); j < many; j += 1)
      fields[pick(FIELDS[object])] = value(pick(FIELDS[object]));
    status[object] = next() < 0.95 ? fields : pick([7, "x", null, []]);
  }
  return status;
};
for (let t = 0; t < 60; t += 1) {
  let now = Math.floor(next() * 1e9);
  const steps = [];
  for (let s = 0, count = 4 + Math.floor(next() * 20); s < count; s += 1) {
    now += Math.floor(next() * 5_000);
    const roll = next();
    if (roll < 0.15)
      steps.push(
        q(
          next() < 0.9
            ? { status: patch(), eventtime: next() }
            : pick([[], null, { status: 7 }]),
          now,
        ),
      );
    else if (roll < 0.2) steps.push(reset);
    else steps.push(n(next() < 0.85 ? [patch(), next() * 1e4] : patch(), now));
  }
  traces.push(trace(`seeded-${t}`, steps));
}

const sources = [
  "tools/cross-platform/print-job-status-vectors.mjs",
  "web/src/printer/PrintJobStatus.ts",
  "web/src/printer/PrintJobStatusExchange.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    traces,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/print-job-status-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Print job status reference drift",
  );
const steps = traces.flatMap((t) => t.steps);
console.log(
  `Print job status: ${traces.length} traces, ${steps.length} steps (${steps.filter((s) => s.snapshotJson).length} snapshots, ${steps.filter((s) => s.ignored).length} ignored, ${steps.filter((s) => s.refusal).length} refused)`,
);
