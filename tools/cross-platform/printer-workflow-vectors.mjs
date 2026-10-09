// Print submission workflow references from the production browser
// (`PrintWorkflowExchange.ts` driving `PrintWorkflowController.ts` and
// `submitPrintJob`): every input a host can give the workflow — run, stored
// reprint, each effect's answer, cancel, dispose — and the step it produced,
// over a scripted printer. Scenarios cover sending with and without starting,
// overwrites and name collisions, readiness, mapping and capability drift,
// unverified uploads, uncertain preparation and starts with their
// reconciliation, refused stored paths, and cancellation, session loss and
// artifact staleness at every single effect. Replayed by Rust, WASM (Node,
// Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PrintWorkflowRecorder } from "../../web/src/printer/PrintWorkflowExchange.ts";
import {
  encodeProjectPrintWorkflowIntent,
  encodeProjectPrintWorkflowOutcome,
  encodeProjectPrintWorkflowStep,
  encodeProjectPrinterText,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const fromUnits = (value) => String.fromCharCode(...value);
const absent = { absent: {} };
const failed = (code, httpStatus, detail) => ({
  failed: {
    code: code === undefined ? absent : { value: code },
    httpStatus: httpStatus === undefined ? absent : { value: httpStatus },
    detail: detail === undefined ? absent : { value: units(detail) },
  },
});
const reply = (value) => ({
  reply: typeof value === "string" ? value : JSON.stringify(value),
});
const kindOf = (effect) => Object.keys(effect)[0];
const query = (path, name) =>
  decodeURIComponent(
    new URL(path, "http://printer").searchParams.get(name) ?? "",
  );

const HASH = `sha256:${"0123456789abcdef".repeat(4)}`;
const intent = (overrides = {}) => ({
  filename: units("Model Plate 1.gcode"),
  byteLength: 1234567,
  plateName: units("Plate 1"),
  usage: {
    tools: [0, 1],
    multiMaterial: true,
    declaredColors: [units("#FF0000"), units("#00FF00")],
    declaredMaterials: [units("PLA"), units("PLA")],
  },
  outputHash: units(HASH),
  ...overrides,
});
const UNIQUE = (byte) =>
  `Model_Plate_1_${byte.toString(16).padStart(2, "0").repeat(16)}.gcode`;

// --- A scripted printer --------------------------------------------------------------
function printer(overrides = {}) {
  let draws = 0;
  return {
    label: "Printer A",
    klippy: "ready",
    printState: "standby",
    printing: "",
    virtualSd: false,
    files: new Map([["other.gcode", { size: 10, modified: 1 }]]),
    slots: {
      filament_color_rgba: ["FF0000FF", "00FF00FF"],
      filament_type: ["PLA", "PLA"],
      filament_vendor: ["Elegoo", "Elegoo"],
      filament_exist: [1, 1],
    },
    objects: ["webhooks", "print_stats", "virtual_sdcard", "bed_mesh"],
    commands: { BED_MESH_CALIBRATE: "Probe the bed", G28: "Home" },
    components: ["file_manager", "timelapse", "history"],
    session: true,
    artifact: true,
    random: () => Array(16).fill(draws++ & 0xff),
    decide: () => ({
      choice: "uploadAndPrint",
      overwrite: false,
      startOptions: ["timelapse", "bedLeveling"],
    }),
    // (operation, path, model, record) => an answer instead of the printer's own.
    override: () => undefined,
    // (record, index, model) => "cancel" to cancel before answering.
    on: () => undefined,
    lifo: false,
    lateReplies: false,
    ...overrides,
  };
}

function answer(model, record) {
  const effect = record.effect;
  switch (kindOf(effect)) {
    case "captureSession":
      return model.capture ?? { session: { text: units(model.label) } };
    case "sessionCurrent":
      return { current: model.session };
    case "artifactCurrent":
      return { current: model.artifact };
    case "random":
      return { random: model.random() };
    case "confirm":
      return { decision: model.decide(effect.confirm, model) };
    case "upload": {
      const upload = effect.upload;
      const name = fromUnits(upload.filename);
      const custom = model.override("upload_gcode", name, model, record);
      if (custom !== undefined) return custom;
      model.files.set(name, { size: upload.size, modified: 100 });
      return reply({
        item: { root: "gcodes", path: name, size: upload.size },
        print_started: false,
        print_queued: false,
      });
    }
  }
  const send = effect.request ?? effect.reconcile;
  const operation = fromUnits(send.operation);
  const path = fromUnits(send.path);
  const custom = model.override(operation, path, model, record);
  if (custom !== undefined) return custom;
  switch (operation) {
    case "print_readiness":
      return reply({
        status: {
          webhooks: { state: model.klippy },
          print_stats: { state: model.printState, filename: model.printing },
          virtual_sdcard: { is_active: model.virtualSd },
        },
      });
    case "query_filament_slots":
      return model.slots
        ? reply({ status: { print_task_config: model.slots } })
        : failed("httpError", 404);
    case "printer_objects":
      return reply({ objects: model.objects });
    case "gcode_help":
      return reply(model.commands);
    case "server_info":
      return reply({ components: model.components, klippy_state: "ready" });
    case "list_gcodes":
      return reply(
        [...model.files].map(([name, file]) => ({ path: name, ...file })),
      );
    case "print_file_identity":
    case "verify_upload": {
      const name = query(path, "filename");
      const file = model.files.get(name);
      return file
        ? reply({ filename: name, ...file })
        : failed("httpError", 404, `File ${name} does not exist`);
    }
    case "start_print":
    case "start_stored_print":
      model.printState = "printing";
      model.printing = query(path, "filename");
      model.virtualSd = true;
      return reply('"ok"');
    case "timelapse_enable":
    case "bed_leveling":
      return reply('"ok"');
  }
  throw new Error(`Unscripted ${operation}`);
}

// --- Recording ------------------------------------------------------------------------
function encodeInput(input) {
  const [kind, value] = Object.entries(input)[0];
  switch (kind) {
    case "run":
      return { run: encodeProjectPrintWorkflowIntent(value) };
    case "stored":
      return { stored: encodeProjectPrinterText(value) };
    case "resolve":
      return {
        resolve: {
          id: value.id,
          outcome: encodeProjectPrintWorkflowOutcome(value.outcome),
        },
      };
    case "reply":
      return { reply: value };
    default:
      return { [kind]: {} };
  }
}
function encodeRecords(records) {
  return records.map(({ input, step, refused }) => ({
    input: encodeInput(input),
    ...(step === undefined
      ? { refused }
      : { step: encodeProjectPrintWorkflowStep(step) }),
  }));
}

/** Answer everything the controller asks from the model until it settles. */
async function settle(recorder, model, counter) {
  const seen = new Set();
  let cancelled = false;
  while (recorder.busy) {
    const pending = recorder.pending();
    assert.ok(pending.length > 0, "the workflow waits on nothing");
    const record = model.lifo ? pending.at(-1) : pending[0];
    if (!seen.has(record.id)) {
      seen.add(record.id);
      if (model.on(record, ++counter.index, model) === "cancel") {
        await recorder.cancel();
        cancelled = true;
        continue;
      }
    }
    // A cancel fails what the transport has in flight for the operation, as
    // the real transport does — unless the replies are already on their way.
    const kind = kindOf(record.effect);
    if (
      cancelled &&
      !model.lateReplies &&
      (kind === "request" || kind === "upload")
    ) {
      await recorder.resolve(record.id, failed("cancelled"));
      continue;
    }
    const given = answer(model, record);
    if ("reply" in given) await recorder.reply(record.id, given.reply);
    else await recorder.resolve(record.id, given);
  }
}

function recorderFor(model, counter) {
  return new PrintWorkflowRecorder({
    now: (record) => ({
      cancelFirst: model.on(record, ++counter.index, model) === "cancel",
      outcome: answer(model, record),
    }),
  });
}

const scenarios = [];
const totals = new Map();
async function scenario(name, model, start = (r) => r.run(intent())) {
  const counter = { index: 0 };
  const recorder = recorderFor(model, counter);
  await start(recorder);
  await settle(recorder, model, counter);
  totals.set(name, counter.index);
  scenarios.push({ name, records: encodeRecords(recorder.records) });
  return recorder;
}
const last = (recorder) => recorder.records.at(-1).step.state;
const stored = (path) => (r) => r.startStored({ text: units(path) });

// --- Sending --------------------------------------------------------------------------
const sent = await scenario("upload and print with both options", printer());
assert.equal(last(sent).submitted.startedPrint, true);
await scenario(
  "upload only, options ignored",
  printer({
    decide: () => ({
      choice: "upload",
      overwrite: false,
      startOptions: ["timelapse", "bedLeveling"],
    }),
  }),
);
await scenario(
  "upload and print with no options",
  printer({
    decide: () => ({
      choice: "uploadAndPrint",
      overwrite: false,
      startOptions: [],
    }),
  }),
);
await scenario(
  "operator declines",
  printer({
    decide: () => ({ choice: "cancel", overwrite: true, startOptions: [] }),
  }),
);
await scenario("out-of-order replies", printer({ lifo: true }));
const overwriting = (choice) =>
  printer({
    files: new Map([
      ["Model_Plate_1.gcode", { size: 20, modified: 10.5 }],
      ["other.gcode", { size: 10, modified: 1 }],
    ]),
    decide: () => ({ choice, overwrite: true, startOptions: ["timelapse"] }),
  });
await scenario("overwrite an existing file", overwriting("upload"));
await scenario("overwrite and print", overwriting("uploadAndPrint"));
await scenario(
  "overwrite while another file prints",
  Object.assign(overwriting("upload"), {
    printState: "printing",
    printing: "other.gcode",
    virtualSd: true,
  }),
);
await scenario(
  "an active file cannot be replaced",
  Object.assign(overwriting("upload"), {
    printState: "paused",
    printing: "Model_Plate_1.gcode",
  }),
);
await scenario(
  "an active virtual SD card with no reported file blocks a replacement",
  Object.assign(overwriting("upload"), { virtualSd: true }),
);
await scenario(
  "replacement during the dialog is rejected",
  Object.assign(overwriting("upload"), {
    on: (record, _, model) => {
      if (kindOf(record.effect) === "confirm")
        model.files.set("Model_Plate_1.gcode", { size: 30, modified: 20 });
    },
  }),
);
await scenario(
  "a target created during the dialog needs another confirmation",
  printer({
    decide: () => ({ choice: "upload", overwrite: true, startOptions: [] }),
    on: (record, _, model) => {
      if (kindOf(record.effect) === "confirm")
        model.files.set("Model_Plate_1.gcode", { size: 12, modified: 12 });
    },
  }),
);
await scenario(
  "a target deleted during the dialog needs another confirmation",
  Object.assign(overwriting("upload"), {
    on: (record, _, model) => {
      if (kindOf(record.effect) === "confirm")
        model.files.delete("Model_Plate_1.gcode");
    },
  }),
);
await scenario(
  "unreadable existing metadata forbids replacing it",
  Object.assign(overwriting("upload"), {
    override: (operation) =>
      operation === "print_file_identity" ? failed("timeout") : undefined,
  }),
);
await scenario(
  "unreliable existing metadata still allows a unique name",
  Object.assign(overwriting("upload"), {
    decide: () => ({ choice: "upload", overwrite: false, startOptions: [] }),
    override: (operation, path) =>
      operation === "print_file_identity"
        ? reply({ filename: query(path, "filename"), size: -1, modified: 1 })
        : undefined,
  }),
);
await scenario(
  "the unique name taken during the dialog",
  printer({
    on: (record, _, model) => {
      if (kindOf(record.effect) === "confirm")
        model.files.set(UNIQUE(0), { size: 1, modified: 1 });
    },
  }),
);
await scenario(
  "a known collision draws a new name",
  printer({
    files: new Map([
      [UNIQUE(0), { size: 1, modified: 1 }],
      [UNIQUE(1), { size: 1, modified: 1 }],
    ]),
  }),
);
await scenario(
  "sixteen collisions reserve no name",
  printer({
    files: new Map(
      Array.from({ length: 16 }, (_, i) => [
        UNIQUE(i),
        { size: 1, modified: 1 },
      ]),
    ),
  }),
);
await scenario(
  "random bytes spell the full range",
  printer({
    random: () => [
      0, 1, 15, 16, 127, 128, 254, 255, 9, 10, 160, 171, 205, 239, 250, 7,
    ],
  }),
);

// Readiness, mapping and capabilities before the dialog.
for (const [name, overrides] of [
  [
    "an unknown print state blocks before confirmation",
    { printState: "future-state" },
  ],
  [
    "an unreported virtual SD card blocks before confirmation",
    {
      override: (op) =>
        op === "print_readiness"
          ? reply({
              status: {
                webhooks: { state: "ready" },
                print_stats: { state: "standby" },
              },
            })
          : undefined,
    },
  ],
  [
    "a failed readiness query blocks before confirmation",
    {
      override: (op) =>
        op === "print_readiness" ? failed("timeout") : undefined,
    },
  ],
  [
    "a readiness reply that is not JSON blocks",
    {
      override: (op) =>
        op === "print_readiness" ? { reply: "{oops" } : undefined,
    },
  ],
  ["a printer without file management blocks", { components: ["timelapse"] }],
  [
    "an unreported component list blocks",
    {
      override: (op) => (op === "server_info" ? failed("network") : undefined),
    },
  ],
  [
    "Klipper shutdown still allows upload only",
    {
      klippy: "shutdown",
      decide: () => ({ choice: "upload", overwrite: false, startOptions: [] }),
    },
  ],
  ["Klipper shutdown refuses a print", { klippy: "shutdown" }],
  [
    "a busy printer allows upload only",
    {
      printState: "printing",
      printing: "other.gcode",
      virtualSd: true,
      decide: () => ({ choice: "upload", overwrite: false, startOptions: [] }),
    },
  ],
  [
    "a busy printer refuses a print",
    { printState: "complete", virtualSd: true },
  ],
  ["unreported slots", { slots: null }],
  [
    "slots that are not a reply",
    {
      override: (op) =>
        op === "query_filament_slots" ? reply({ status: {} }) : undefined,
    },
  ],
  [
    "a missing slot blocks a print",
    {
      slots: {
        filament_color_rgba: ["FF0000FF"],
        filament_type: ["PLA"],
        filament_vendor: ["Elegoo"],
      },
    },
  ],
  [
    "a missing slot still allows upload only",
    {
      slots: { filament_color_rgba: ["FF0000FF"], filament_type: ["PLA"] },
      decide: () => ({ choice: "upload", overwrite: false, startOptions: [] }),
    },
  ],
  [
    "material and colour mismatches warn",
    {
      slots: {
        filament_color_rgba: ["0000FFFF", "00FF00FF"],
        filament_type: ["PETG", "PLA-CF"],
        filament_sub_type: ["HF", ""],
        filament_vendor: ["Elegoo", "Generic"],
      },
    },
  ],
  [
    "an unavailable option cannot be chosen",
    {
      components: ["file_manager"],
      objects: ["webhooks"],
      commands: {},
      decide: () => ({
        choice: "uploadAndPrint",
        overwrite: false,
        startOptions: ["timelapse"],
      }),
    },
  ],
  [
    "levelling offered through G29 alone",
    { commands: { G29: "Probe" }, objects: [] },
  ],
  [
    "capability queries that fail leave options unknown",
    {
      override: (op) =>
        op === "printer_objects" || op === "gcode_help"
          ? failed("httpError", 404)
          : undefined,
      decide: () => ({
        choice: "uploadAndPrint",
        overwrite: false,
        startOptions: [],
      }),
    },
  ],
])
  await scenario(name, printer(overrides));
await scenario("single tool, slots unreported", printer({ slots: null }), (r) =>
  r.run(
    intent({
      usage: {
        tools: [0],
        multiMaterial: false,
        declaredColors: [],
        declaredMaterials: [],
      },
    }),
  ),
);
await scenario(
  "an empty slot list",
  printer({ slots: { filament_color_rgba: [] } }),
  (r) =>
    r.run(
      intent({
        usage: {
          tools: [3],
          multiMaterial: false,
          declaredColors: [],
          declaredMaterials: [],
        },
      }),
    ),
);
await scenario(
  "an empty artifact is refused after confirmation",
  printer(),
  (r) => r.run(intent({ byteLength: 0 })),
);
await scenario("a name that sanitizes to the default", printer(), (r) =>
  r.run(intent({ filename: units("../???.3mf") })),
);
await scenario("a large artifact", printer(), (r) =>
  r.run(
    intent({
      byteLength: 97_517_568,
      filename: units("C:\\prints\\Big part.GCODE"),
    }),
  ),
);
for (const hash of [
  `sha256:${"0123456789ABCDEF".repeat(4)}`,
  `sha256:${"0".repeat(63)}`,
  `sha256:${"0".repeat(64)}\n`,
  "sha512:" + "0".repeat(64),
  "",
])
  await scenario(
    `an artifact without exact identity ${JSON.stringify(hash)}`,
    printer(),
    (r) => r.run(intent({ outputHash: units(hash) })),
  );
await scenario(
  "the session cannot be captured",
  printer({
    capture: {
      sessionFailed: { text: units("Connect to the selected printer first.") },
    },
  }),
);

// Listings.
for (const [name, value] of [
  ["a failed listing", failed("httpError", 503, "Service\nunavailable")],
  ["a listing that is not an array", reply({ files: [] })],
  ["a listing entry without a path", reply([{ path: "a.gcode" }, { size: 1 }])],
  ["a listing entry with an empty path", reply([{ path: "" }])],
  ["a listing entry that is an array", reply([["a.gcode"]])],
  ["a listing that is not JSON", { reply: "[" }],
  ["an empty listing", reply([])],
])
  await scenario(
    name,
    printer({ override: (op) => (op === "list_gcodes" ? value : undefined) }),
  );

// Uploads and verification.
const uploadReply = (patch) => (op, name) =>
  op === "upload_gcode"
    ? typeof patch === "function"
      ? patch(name)
      : reply({
          item: { root: "gcodes", path: name, size: 1234567, ...patch.item },
          print_started: false,
          print_queued: false,
          ...patch.top,
        })
    : undefined;
for (const [name, override] of [
  [
    "a failed upload names the server's words",
    uploadReply(() =>
      failed("httpError", 413, "  Request\tEntity  Too Large  "),
    ),
  ],
  ["a failed upload without a code", uploadReply(() => failed())],
  [
    "an upload reply that is not JSON",
    uploadReply(() => ({ reply: "<html>" })),
  ],
  ["an upload to another root", uploadReply({ item: { root: "config" } })],
  [
    "an upload under another name",
    uploadReply({ item: { path: "other.gcode" } }),
  ],
  ["an upload of another size", uploadReply({ item: { size: 1 } })],
  ["an upload whose size is text", uploadReply({ item: { size: "1234567" } })],
  [
    "an upload that started printing",
    uploadReply({ top: { print_started: true } }),
  ],
  [
    "an upload that may have queued",
    uploadReply({ top: { print_queued: null } }),
  ],
  [
    "an upload reply without an item",
    uploadReply(() => reply({ print_started: false, print_queued: false })),
  ],
  ["an upload reply of null", uploadReply(() => reply(null))],
  ["an upload reply that is an array", uploadReply(() => reply([]))],
  [
    "an unverifiable size",
    (op) => (op === "verify_upload" ? failed("network") : undefined),
  ],
  [
    "a size that is not reported",
    (op) => (op === "verify_upload" ? reply({ filename: "x" }) : undefined),
  ],
  [
    "a size that is not a number",
    (op) => (op === "verify_upload" ? reply({ size: "1234567" }) : undefined),
  ],
  [
    "an infinite size",
    (op) => (op === "verify_upload" ? { reply: '{"size": 1e400}' } : undefined),
  ],
  [
    "a fractional stored size",
    (op) => (op === "verify_upload" ? reply({ size: 1234566.5 }) : undefined),
  ],
  [
    "a tiny stored size",
    (op) => (op === "verify_upload" ? reply({ size: 1e-7 }) : undefined),
  ],
  [
    "unreliable metadata after upload",
    (op, path) =>
      op === "print_file_identity"
        ? reply({
            filename: `${query(path, "filename")}x`,
            size: 1,
            modified: 1,
          })
        : undefined,
  ],
  [
    "unreadable metadata after upload",
    (op) => (op === "print_file_identity" ? failed("network") : undefined),
  ],
  [
    "metadata that is not JSON after upload",
    (op) => (op === "print_file_identity" ? { reply: "nope" } : undefined),
  ],
])
  await scenario(name, printer({ override }));

// Drift after the dialog: each change at each later readiness query.
const after = (operation, change) => {
  let seen = false;
  return (record, _, model) => {
    const send = record.effect.request ?? record.effect.upload;
    if (send && fromUnits(send.operation) === operation) seen = true;
    if (seen) change(model, record);
  };
};
for (const [name, change] of [
  ["artifact", (m) => (m.artifact = false)],
  ["session", (m) => (m.session = false)],
  [
    "mapping",
    (m) => (m.slots = { ...m.slots, filament_type: ["PETG", "PLA"] }),
  ],
  ["readiness", (m) => (m.printState = "printing")],
  ["klippy", (m) => (m.klippy = "error")],
  ["capabilities", (m) => (m.components = ["timelapse"])],
  ["preparation command", (m) => (m.commands = { G29: "Probe" })],
  ["timelapse", (m) => (m.components = ["file_manager"])],
  // Before the upload's own reply, the rewrite is overwritten by it.
  [
    "stored file",
    (m) => m.files.set(UNIQUE(0), { size: 1234567, modified: 101 }),
  ],
  ["slot removed", (m) => (m.slots = { ...m.slots, filament_exist: [1, 0] })],
])
  for (const operation of ["upload_gcode", "timelapse_enable", "bed_leveling"])
    await scenario(
      `${name} drift after ${operation}`,
      printer({ on: after(operation, change) }),
    );
await scenario(
  "readiness changes between the checks before a mutation",
  printer({
    on: (() => {
      let readiness = 0;
      return (record, _, model) => {
        const send = record.effect.request;
        if (
          send &&
          fromUnits(send.operation) === "print_readiness" &&
          ++readiness === 6
        )
          model.printState = "cancelled";
        if (
          send &&
          fromUnits(send.operation) === "print_file_identity" &&
          readiness >= 6
        )
          model.virtualSd = true;
      };
    })(),
  }),
);
await scenario(
  "drift in upload-only after verification",
  printer({
    decide: () => ({ choice: "upload", overwrite: false, startOptions: [] }),
    on: after("verify_upload", (m) => (m.components = [])),
  }),
);

// Uncertain outcomes and their reconciliation.
const isReconcile = (record) => kindOf(record.effect) === "reconcile";
const uncertain = (operation, overrides = {}) =>
  printer({
    override: (op, _, model, record) => {
      if (isReconcile(record) && model.reconcile) return model.reconcile(model);
      if (op !== operation) return undefined;
      if (operation.startsWith("start")) {
        model.printState = "printing";
        model.printing = query(
          fromUnits(record.effect.request.path),
          "filename",
        );
        model.virtualSd = true;
      }
      return failed("timeout");
    },
    ...overrides,
  });
await scenario("an uncertain timelapse request", uncertain("timelapse_enable"));
await scenario("an uncertain levelling request", uncertain("bed_leveling"));
await scenario(
  "an uncertain start reconciled as printing",
  uncertain("start_print"),
);
for (const [name, reconcile] of [
  ["times out", () => failed("timeout")],
  ["is cancelled with the session", () => failed("cancelled")],
  ["is not JSON", () => ({ reply: "" })],
  [
    "reports an unknown state",
    () =>
      reply({
        status: {
          webhooks: { state: "ready" },
          print_stats: { state: "warming" },
          virtual_sdcard: { is_active: false },
        },
      }),
  ],
  [
    "reports no file",
    () =>
      reply({
        status: {
          webhooks: { state: "ready" },
          print_stats: { state: "standby", filename: "" },
          virtual_sdcard: { is_active: false },
        },
      }),
  ],
])
  await scenario(
    `an uncertain start whose reconciliation ${name}`,
    uncertain("start_print", { reconcile }),
  );
await scenario(
  "an uncertain start after the session changed",
  uncertain("start_print", {
    on: (record, _, model) => {
      if (
        kindOf(record.effect) === "request" &&
        fromUnits(record.effect.request.operation) === "start_print"
      )
        model.session = false;
    },
  }),
);
await scenario(
  "a cancel during reconciliation leaves the query running",
  uncertain("bed_leveling", {
    on: (record) => (isReconcile(record) ? "cancel" : undefined),
  }),
);
await scenario(
  "a start the printer accepted stays started when the session changes",
  printer({
    on: (record, _, model) => {
      if (
        kindOf(record.effect) === "request" &&
        fromUnits(record.effect.request.operation) === "start_print"
      ) {
        model.session = false;
        model.artifact = false;
        return "cancel";
      }
      return undefined;
    },
    lateReplies: true,
  }),
);

// Cancellation, session loss and staleness at every effect of a full send.
const full = totals.get("upload and print with both options");
for (let at = 1; at <= full; at++) {
  await scenario(
    `cancel at effect ${at}`,
    printer({ on: (_, index) => (index === at ? "cancel" : undefined) }),
  );
  await scenario(
    `cancel at effect ${at}, replies arriving anyway`,
    printer({
      lateReplies: true,
      on: (_, index) => (index === at ? "cancel" : undefined),
    }),
  );
}
const nth = (kind, at, change) => {
  let count = 0;
  return (record, _, model) => {
    if (kindOf(record.effect) === kind && ++count === at) change(model);
  };
};
for (const [kind, change] of [
  ["sessionCurrent", (m) => (m.session = false)],
  ["artifactCurrent", (m) => (m.artifact = false)],
]) {
  let at = 1;
  for (;;) {
    const recorder = await scenario(
      `${kind} false at check ${at}`,
      printer({ on: nth(kind, at, change) }),
    );
    if ("submitted" in last(recorder)) {
      scenarios.pop();
      break;
    }
    at++;
  }
}
await scenario(
  "cancel while the operator decides",
  printer({
    on: (record) =>
      kindOf(record.effect) === "confirm" ? "cancel" : undefined,
  }),
);
await scenario(
  "cancel during the upload",
  printer({
    on: (record) => (kindOf(record.effect) === "upload" ? "cancel" : undefined),
  }),
);
await scenario(
  "cancel during the upload, which completes anyway",
  printer({
    lateReplies: true,
    on: (record) => (kindOf(record.effect) === "upload" ? "cancel" : undefined),
  }),
);
await scenario(
  "cancel while capturing the session",
  printer({
    on: (record) =>
      kindOf(record.effect) === "captureSession" ? "cancel" : undefined,
  }),
);
await scenario(
  "cancel while capturing a session that fails",
  printer({
    capture: {
      sessionFailed: { text: units("The Moonraker operation was cancelled.") },
    },
    on: (record) =>
      kindOf(record.effect) === "captureSession" ? "cancel" : undefined,
  }),
);

// --- Stored reprints ------------------------------------------------------------------
const reprinting = (overrides = {}) =>
  printer({
    files: new Map([
      ["projects/Part \u00e9.gcode", { size: 20, modified: 10 }],
    ]),
    ...overrides,
  });
const STORED = "projects/Part \u00e9.gcode";
const reprinted = await scenario(
  "a stored reprint",
  reprinting(),
  stored(` /${STORED}/ `),
);
assert.equal(fromUnits(last(reprinted).started.text), STORED);
for (const [name, overrides] of [
  [
    "a stored reprint declined",
    {
      decide: () => ({ choice: "cancel", overwrite: false, startOptions: [] }),
    },
  ],
  [
    "a stored reprint answered with upload is declined",
    {
      decide: () => ({ choice: "upload", overwrite: false, startOptions: [] }),
    },
  ],
  [
    "a stored reprint on a busy printer",
    { printState: "printing", printing: "x.gcode", virtualSd: true },
  ],
  ["a stored reprint with unknown readiness", { klippy: "startup" }],
  ["a stored reprint of a missing file", { files: new Map() }],
  [
    "a stored reprint with unreliable metadata",
    {
      override: (op) =>
        op === "print_file_identity"
          ? reply({ filename: STORED, size: 1.5, modified: 1 })
          : undefined,
    },
  ],
  [
    "a stored reprint whose file changes in the dialog",
    {
      on: (record, _, m) =>
        kindOf(record.effect) === "confirm"
          ? m.files.set(STORED, { size: 20, modified: 11 })
          : undefined,
    },
  ],
  [
    "a stored reprint whose readiness changes in the dialog",
    {
      on: (record, _, m) =>
        kindOf(record.effect) === "confirm"
          ? (m.printState = "printing")
          : undefined,
    },
  ],
  [
    "a stored reprint whose session changes in the dialog",
    {
      on: (record, _, m) =>
        kindOf(record.effect) === "confirm" ? (m.session = false) : undefined,
    },
  ],
  [
    "a stored reprint whose session cannot be captured",
    {
      capture: {
        sessionFailed: {
          text: units("Connect to the selected printer first."),
        },
      },
    },
  ],
  [
    "a stored reprint cancelled in the dialog",
    {
      on: (record) =>
        kindOf(record.effect) === "confirm" ? "cancel" : undefined,
    },
  ],
])
  await scenario(name, reprinting(overrides), stored(STORED));
const storedUncertain = (reconcile, session = true) =>
  reprinting({
    override: (op, _, model, record) => {
      if (isReconcile(record) && reconcile) return reconcile();
      if (op !== "start_stored_print") return undefined;
      model.printState = "printing";
      model.printing = STORED;
      model.session = session;
      return failed("network");
    },
  });
await scenario(
  "a stored reprint with an uncertain start",
  storedUncertain(),
  stored(STORED),
);
await scenario(
  "a stored reprint uncertain after the session changed",
  storedUncertain(undefined, false),
  stored(STORED),
);
await scenario(
  "a stored reprint whose reconciliation times out",
  storedUncertain(() => failed("timeout")),
  stored(STORED),
);
const storedFull = totals.get("a stored reprint");
for (let at = 1; at <= storedFull; at++)
  await scenario(
    `a stored reprint cancelled at effect ${at}`,
    reprinting({ on: (_, index) => (index === at ? "cancel" : undefined) }),
    stored(STORED),
  );
for (let at = 1; at <= 4; at++)
  await scenario(
    `a stored reprint whose session is stale at check ${at}`,
    reprinting({ on: nth("sessionCurrent", at, (m) => (m.session = false)) }),
    stored(STORED),
  );
for (const path of [
  "",
  "   ",
  "/",
  "../part.gcode",
  "a/./b.gcode",
  "projects/..",
  "odd\ud800.gcode",
  "\udc00",
])
  await scenario(
    `a stored path ${JSON.stringify(path)} is refused`,
    reprinting(),
    stored(path),
  );

// --- One controller, many calls -------------------------------------------------------
{
  const model = printer();
  const counter = { index: 0 };
  const recorder = recorderFor(model, counter);
  await recorder.cancel();
  await recorder.resolve(1, { current: true });
  await recorder.reply(1, "{}");
  await recorder.run(intent());
  await recorder.run(intent());
  await recorder.startStored({ text: units("a.gcode") });
  const confirmAt = () =>
    recorder.pending().find((r) => kindOf(r.effect) === "confirm");
  while (!confirmAt()) {
    const record = recorder.pending()[0];
    const given = answer(model, record);
    if ("reply" in given) await recorder.reply(record.id, given.reply);
    else await recorder.resolve(record.id, given);
  }
  const confirm = confirmAt();
  await recorder.reply(confirm.id, "{}");
  await recorder.resolve(confirm.id, { current: true });
  await recorder.resolve(confirm.id, failed("cancelled"));
  await recorder.resolve(confirm.id + 100, { current: true });
  await recorder.resolve(confirm.id, { decision: model.decide() });
  let request = recorder.pending()[0];
  await recorder.resolve(request.id, { decision: model.decide() });
  await recorder.resolve(request.id, { session: { text: units("x") } });
  await settle(recorder, model, counter);
  // A second send continues the ids, and a stored reprint follows it.
  await recorder.run(intent({ filename: units("second.gcode") }));
  await settle(recorder, model, counter);
  await recorder.startStored({ text: units(UNIQUE(0)) });
  await settle(recorder, model, counter);
  await recorder.cancel();
  // Dispose withdraws an open confirmation and refuses anything later.
  await recorder.run(intent());
  while (!confirmAt()) {
    request = recorder.pending()[0];
    const given = answer(model, request);
    if ("reply" in given) await recorder.reply(request.id, given.reply);
    else await recorder.resolve(request.id, given);
  }
  const open = confirmAt();
  await recorder.dispose();
  await recorder.resolve(open.id, { decision: model.decide() });
  await recorder.run(intent());
  await recorder.startStored({ text: units("a.gcode") });
  await recorder.dispose();
  await recorder.cancel();
  scenarios.push({
    name: "one controller, many calls",
    records: encodeRecords(recorder.records),
  });
}

// --- Output ---------------------------------------------------------------------------
const steps = scenarios.reduce((n, s) => n + s.records.length, 0);
const sources = [
  "tools/cross-platform/printer-workflow-vectors.mjs",
  "web/src/printer/PrintWorkflowExchange.ts",
  "web/src/printer/PrintWorkflowController.ts",
  "web/src/printer/PrintJobSubmission.ts",
  "web/src/printer/PrintStartOptions.ts",
  "web/src/printer/PrintToolMapping.ts",
  "web/src/printer/MoonrakerFilamentSlots.ts",
  "web/src/printer/PrinterStorage.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    scenarios,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-workflow-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer workflow reference drift",
  );
console.log(
  `Printer workflow references: ${scenarios.length} scenarios, ${steps} steps.`,
);
