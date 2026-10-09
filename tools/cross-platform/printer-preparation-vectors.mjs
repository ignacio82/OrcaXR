// Print preparation and submission-check references from the production
// browser (`PrintPreparationExchange.ts` over `PrintStartOptions.ts` and
// `PrintJobSubmission.ts`): capability lists parsed from object, help and
// server replies of every shape; start options assessed from known, unknown
// and oddly spelled capabilities; preparation plans for every choice of
// options, including unavailable and unnamed ones, and what each step posts;
// readiness from replies and failed queries; sanitized upload names; how a
// transport failure reads with and without status and server text; and
// stored-file identities. Replayed by Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerFileIdentity,
  answerGcodeCommands,
  answerPrintPreparationPlan,
  answerPrintPreparationSend,
  answerPrintReadiness,
  answerPrintReadinessFailure,
  answerPrintStartOptions,
  answerPrinterObjects,
  answerSanitizeFilename,
  answerServerComponents,
  answerTransportFailure,
} from "../../web/src/printer/PrintPreparationExchange.ts";
import {
  decodeProjectPrintPreparationPlanRequest,
  decodeProjectPrintPreparationStep,
  decodeProjectPrinterCapabilityReport,
  decodeProjectTransportFailure,
  encodeProjectOptionalTextList,
  encodeProjectPrintFileIdentityReply,
  encodeProjectPrintPreparationPlan,
  encodeProjectPrintPreparationPlanRequest,
  encodeProjectPrintPreparationStep,
  encodeProjectPrintReadiness,
  encodeProjectPrintReadinessFailure,
  encodeProjectPrintStartOptions,
  encodeProjectPrinterCapabilityReport,
  encodeProjectPrinterSend,
  encodeProjectPrinterText,
  encodeProjectTransportFailure,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const list = (names) =>
  names === undefined ? absent : { value: names.map(units) };
const json = (value) =>
  typeof value === "string" ? value : JSON.stringify(value);

// --- Capability lists -------------------------------------------------------------------
const capabilities = [];
const PARSERS = {
  objects: answerPrinterObjects,
  components: answerServerComponents,
  commands: answerGcodeCommands,
};
const payloads = [
  {
    result: {
      objects: ["webhooks", "bed_mesh", "extruder stepper", "heater_bed"],
    },
  },
  { objects: ["gcode_move", 7, null, "BED_MESH", " bed_mesh"] },
  { result: null, objects: ["bed_mesh"] },
  { result: [], objects: ["bed_mesh"] },
  { result: { objects: "bed_mesh" } },
  { result: { components: ["file_manager", "timelapse", "history"] } },
  { components: ["TIMELAPSE", "timelapse extra", "İ"] },
  {
    result: {
      BED_MESH_CALIBRATE: "Perform Mesh Bed Leveling",
      G28: "Home",
      10: "x",
      2: "y",
      é: "z",
    },
  },
  { G29: "Probe", "PRINT_START extra": "m" },
  '{"result": {"G29": "a", "G29": "b", "__proto__": "c"}}',
  { result: [] },
  { result: "x" },
  [],
  null,
  '"text"',
  7,
  {},
];
for (const [kind, parse] of Object.entries(PARSERS))
  for (const payload of payloads) {
    const text = json(payload);
    capabilities.push({
      kind,
      text,
      replyJson: encodeProjectOptionalTextList(parse(JSON.parse(text))),
    });
  }

// --- Start options --------------------------------------------------------------------------
const options = [];
const optionLists = [];
const REPORTS = [];
const OBJECTS = [
  undefined,
  [],
  ["bed_mesh"],
  ["BED_MESH extra"],
  [" bed_mesh"],
  ["bed_mesh_extra"],
  ["heater_bed", "Bed_Mesh"],
];
const COMMANDS = [
  undefined,
  [],
  ["BED_MESH_CALIBRATE"],
  ["g29"],
  ["G29 extra", "M104"],
  ["bed_mesh_calibrate", "G29"],
  ["İG29"],
];
const COMPONENTS = [
  undefined,
  [],
  ["timelapse"],
  ["TIMELAPSE"],
  ["\ttimelapse"],
  ["timelapse2"],
];
for (const objects of OBJECTS)
  for (const commands of COMMANDS)
    for (const components of COMPONENTS)
      REPORTS.push({
        objects: list(objects),
        commands: list(commands),
        components: list(components),
      });
for (const report of REPORTS) {
  const decoded = decodeProjectPrinterCapabilityReport(
    encodeProjectPrinterCapabilityReport(report),
  );
  const reply = answerPrintStartOptions(decoded);
  optionLists.push(reply);
  options.push({
    requestJson: encodeProjectPrinterCapabilityReport(decoded),
    replyJson: encodeProjectPrintStartOptions(reply),
  });
}

// --- Plans and sends ---------------------------------------------------------------------------
const plans = [];
const steps = new Map();
const distinctLists = new Map(optionLists.map((l) => [JSON.stringify(l), l]));
const extraLists = [
  [],
  [
    {
      ...optionLists[0][0],
      available: true,
      command: { value: units("M999") },
    },
  ],
  [
    { ...optionLists[0][0], available: true, command: absent },
    optionLists[0][1],
  ],
  [optionLists[0][1], { ...optionLists[0][1], available: true }],
];
const ENABLED = [
  [],
  ["bedLeveling"],
  ["timelapse"],
  ["bedLeveling", "timelapse"],
  ["timelapse", "bedLeveling", "bedLeveling"],
];
for (const optionList of [...distinctLists.values(), ...extraLists])
  for (const enabled of ENABLED) {
    const request = decodeProjectPrintPreparationPlanRequest(
      encodeProjectPrintPreparationPlanRequest({
        options: optionList,
        enabled,
      }),
    );
    const reply = answerPrintPreparationPlan(request);
    if ("steps" in reply)
      for (const step of reply.steps) steps.set(JSON.stringify(step), step);
    plans.push({
      requestJson: encodeProjectPrintPreparationPlanRequest(request),
      replyJson: encodeProjectPrintPreparationPlan(reply),
    });
  }
const sends = [];
const extraSteps = [
  {
    id: "bedLeveling",
    label: units("bed levelling"),
    kind: "leveling",
    command: { value: units("BED_MESH_CALIBRATE PROFILE=a&b c/ü🧩") },
  },
  {
    id: "bedLeveling",
    label: units("bed levelling"),
    kind: "leveling",
    command: { value: [] },
  },
];
for (const step of [...steps.values(), ...extraSteps]) {
  const decoded = decodeProjectPrintPreparationStep(
    encodeProjectPrintPreparationStep(step),
  );
  sends.push({
    requestJson: encodeProjectPrintPreparationStep(decoded),
    replyJson: encodeProjectPrinterSend(
      await answerPrintPreparationSend(decoded),
    ),
  });
}

// --- Readiness --------------------------------------------------------------------------------
const readiness = [];
const status = (webhooks, stats, sd) => ({
  status: {
    ...(webhooks === undefined ? {} : { webhooks }),
    ...(stats === undefined ? {} : { print_stats: stats }),
    ...(sd === undefined ? {} : { virtual_sdcard: sd }),
  },
});
const KLIPPY = [
  undefined,
  "ready",
  "startup",
  "shutdown",
  "error",
  "READY",
  "",
  7,
];
const PRINT = [
  undefined,
  "standby",
  "printing",
  "paused",
  "complete",
  "cancelled",
  "error",
  "canceled",
  "",
];
for (const klippy of KLIPPY)
  for (const print of PRINT)
    for (const active of [undefined, false, true]) {
      const payload = status(
        klippy === undefined ? undefined : { state: klippy },
        print === undefined
          ? undefined
          : {
              state: print,
              filename:
                print === "printing"
                  ? "job \ud800.gcode"
                  : print === "paused"
                    ? ""
                    : "done.gcode",
            },
        active === undefined ? undefined : { is_active: active },
      );
      const text = json(payload);
      readiness.push({
        text,
        replyJson: encodeProjectPrintReadiness(
          await answerPrintReadiness(JSON.parse(text)),
        ),
      });
    }
for (const payload of [
  null,
  [],
  '"x"',
  { status: [] },
  { status: { webhooks: "ready" } },
]) {
  const text = json(payload);
  readiness.push({
    text,
    replyJson: encodeProjectPrintReadiness(
      await answerPrintReadiness(JSON.parse(text)),
    ),
  });
}
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
const readinessFailures = [];
for (const code of [undefined, ...CODES]) {
  const request = {
    transportCode: code === undefined ? absent : { value: code },
  };
  readinessFailures.push({
    requestJson: encodeProjectPrintReadinessFailure(request),
    replyJson: encodeProjectPrintReadiness(
      await answerPrintReadinessFailure(request),
    ),
  });
}

// --- Names, failures, identities ---------------------------------------------------------------------
const filenames = [];
for (const name of [
  "Plate 1.gcode",
  "dir/sub\\Model.GCODE",
  "  spaced name.3mf  ",
  ".hidden.gcode",
  "__under__.gcode",
  "a_ b.gcode",
  "no-extension",
  "dots.in.name.gcode.bak",
  "café 🧩 part.gcode",
  "\ud800lone",
  "",
  "/",
  "x".repeat(130) + ".gcode",
  "._.-_.gcode",
  "trailing.",
  "multi\nline.gcode",
  " nbsp.gcode ",
  "a/b/",
  "Model.gco",
  "UPPER.Gcode",
]) {
  filenames.push({
    requestJson: encodeProjectPrinterText({ text: units(name) }),
    replyJson: encodeProjectPrinterText({
      text: answerSanitizeFilename(units(name)),
    }),
  });
}
const failures = [];
for (const code of [undefined, "httpError", "network", "forbidden"])
  for (const httpStatus of [undefined, 404, 99, 600, 500.5, 599, 100])
    for (const detail of [
      undefined,
      "",
      "Method Not Allowed",
      "  multi\n\tline \u0007 text  ",
      "\u0000\u0001",
      "x".repeat(250),
      "\ud800 lone   sep",
    ]) {
      const request = decodeProjectTransportFailure(
        encodeProjectTransportFailure({
          code: code === undefined ? absent : { value: code },
          httpStatus: httpStatus === undefined ? absent : { value: httpStatus },
          detail: detail === undefined ? absent : { value: units(detail) },
        }),
      );
      failures.push({
        requestJson: encodeProjectTransportFailure(request),
        replyJson: encodeProjectPrinterText({
          text: answerTransportFailure(request),
        }),
      });
    }
const identities = [];
for (const [payload, filename] of [
  [{ filename: "a.gcode", size: 1024, modified: 1700000000.5 }, "a.gcode"],
  [{ filename: "a.gcode", size: 1024, modified: 0 }, "a.gcode"],
  [{ filename: "b.gcode", size: 1024, modified: 1 }, "a.gcode"],
  [{ filename: "a.gcode", size: 1.5, modified: 1 }, "a.gcode"],
  [{ filename: "a.gcode", size: -1, modified: 1 }, "a.gcode"],
  [{ filename: "a.gcode", size: 9007199254740992, modified: 1 }, "a.gcode"],
  [{ filename: "a.gcode", size: 9007199254740991, modified: 1 }, "a.gcode"],
  [{ filename: "a.gcode", size: "1", modified: 1 }, "a.gcode"],
  [{ filename: "a.gcode", size: 1, modified: -1 }, "a.gcode"],
  [{ filename: "a.gcode", size: 1 }, "a.gcode"],
  ['{"filename": "a.gcode", "size": 1, "modified": 1e400}', "a.gcode"],
  [{ filename: "caf\u00e9.gcode", size: 0, modified: 2 }, "caf\u00e9.gcode"],
  [[], "a.gcode"],
  [null, "a.gcode"],
]) {
  const text = json(payload);
  identities.push({
    text,
    requestJson: encodeProjectPrinterText({ text: units(filename) }),
    replyJson: encodeProjectPrintFileIdentityReply(
      await answerFileIdentity(JSON.parse(text), units(filename)),
    ),
  });
}

const sources = [
  "tools/cross-platform/printer-preparation-vectors.mjs",
  "web/src/printer/PrintPreparationExchange.ts",
  "web/src/printer/PrintStartOptions.ts",
  "web/src/printer/PrintJobSubmission.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    capabilities,
    options,
    plans,
    sends,
    readiness,
    readinessFailures,
    filenames,
    failures,
    identities,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-preparation-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer preparation reference drift",
  );
console.log(
  `Printer preparation: ${capabilities.length} capability replies, ${options.length} assessments, ${plans.length} plans, ${sends.length} sends, ${readiness.length + readinessFailures.length} readiness, ${filenames.length} names, ${failures.length} failures, ${identities.length} identities`,
);
