// Printer console references from the production browser
// (`PrinterConsoleExchange.ts` over `PrinterConsole.ts`): how scripts are
// named and assessed (line numbers, glued parameters, comments, line
// endings, macros, Jinja, case mapping, every table entry, a running job),
// what a send or macro listing sends or why it is refused, how each transport
// outcome finishes, how configuration replies of every shape read into
// macros and their parameters, how invocations are spelled or refused, and
// how transcript lines are redacted, classified and recalled. Replayed by
// Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerConsoleAssess,
  answerConsoleFinish,
  answerConsoleLine,
  answerConsoleNotification,
  answerConsolePlan,
  answerConsoleRead,
  answerConsoleRecent,
  answerMacroInvocation,
} from "../../web/src/printer/PrinterConsoleExchange.ts";
import {
  encodeProjectConsoleFinish,
  encodeProjectConsoleLine,
  encodeProjectConsoleLineRequest,
  encodeProjectConsoleNotificationRequest,
  encodeProjectConsoleOperation,
  encodeProjectConsolePlan,
  encodeProjectConsoleRecentRequest,
  encodeProjectConsoleResult,
  encodeProjectGcodeAssessRequest,
  encodeProjectGcodeAssessment,
  encodeProjectMacroInvocation,
  encodeProjectMacroInvocationRequest,
  encodeProjectOptionalConsoleLine,
  encodeProjectTextList,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };

// Seeded, so the corpus is the same every run.
let seed = 0xc0de;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

const tableCommands = [
  "M112",
  "M999",
  "RESTART",
  "FIRMWARE_RESTART",
  "M84",
  "M18",
  "FORCE_MOVE",
  "SET_KINEMATIC_POSITION",
  "M303",
  "PID_CALIBRATE",
  "BED_MESH_CALIBRATE",
  "DELTA_CALIBRATE",
  "PROBE",
  "PROBE_ACCURACY",
  "Z_ENDSTOP_CALIBRATE",
  "SDCARD_RESET_FILE",
  "G0",
  "G1",
  "G2",
  "G3",
  "G28",
  "G29",
  "M104",
  "M109",
  "M140",
  "M190",
  "SET_HEATER_TEMPERATURE",
  "M106",
  "M204",
  "SET_VELOCITY_LIMIT",
  "M24",
  "M25",
  "PAUSE",
  "RESUME",
  "CANCEL_PRINT",
  "SET_GCODE_OFFSET",
  "M105",
  "M114",
  "M115",
  "M119",
  "M31",
  "STATUS",
  "HELP",
  "GET_POSITION",
  "QUERY_ENDSTOPS",
  "QUERY_PROBE",
  "DUMP_TMC",
  "BED_MESH_OUTPUT",
  "SHOW",
];
const lines = [
  "",
  "   ",
  "; only a comment",
  "M105",
  "m105 ; temps",
  "G28",
  "G1 X10 Y10 F3000",
  "G1X10Y10",
  "N10 M112",
  "n10 m112 ; stop",
  "N10",
  "N",
  "M112X",
  "M112*45",
  "M84E",
  "1 M112",
  "M 112",
  "123",
  "=M112",
  "*",
  "**5",
  "_MACRO",
  "PRINT_START2 BED=60",
  "SET_PIN PIN=led VALUE=1 ; on",
  "LOAD_FILAMENT TEMP=220",
  "{% if params.X %}",
  "{params.TEMP|default(200)}",
  "M117 Hello World",
  "ſdcard_reset_file",
  "straße",
  "ıd",
  "ﬀ",
  "M112\u2028G28",
  "\tG28\t",
  "x\uD800y",
  "\uFEFFM112",
  "M1 12",
];
const scripts = [...lines, ...tableCommands];
for (const command of tableCommands) scripts.push(command.toLowerCase());
scripts.push(
  "G28\nM105",
  "G28\r\nM112\r\n",
  "M105\nM105\nM114",
  "M84\nM18",
  "PID_CALIBRATE HEATER=extruder TARGET=210\nM303",
  "M105\n\n\n",
  "\n\n",
  "MY_MACRO\nOTHER_MACRO\nMY_MACRO",
  "G1 X1\nG1 X2\nUNKNOWN_ONE\nunknown_one",
);
for (let i = 0; i < 60; i++)
  scripts.push(
    Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
      pick([...lines, ...tableCommands]),
    ).join(pick(["\n", "\r\n"])),
  );
const states = [
  undefined,
  "standby",
  "printing",
  "paused",
  "complete",
  "cancelled",
  "error",
  "unknown",
];
const assessCases = [];
for (const script of scripts) {
  for (const state of [undefined, pick(states.slice(1))]) {
    const request = {
      script: units(script),
      jobState: state === undefined ? absent : { value: state },
    };
    assessCases.push({
      requestJson: encodeProjectGcodeAssessRequest(request),
      replyJson: encodeProjectGcodeAssessment(answerConsoleAssess(request)),
    });
  }
}

const sendScripts = [
  ...lines,
  "M105\nG28",
  "  G28  ",
  "a".repeat(4096),
  ` ${"a".repeat(4096)} `,
  "a".repeat(4097),
  "query?&#=+%20 😀",
];
const operations = [
  { macros: {} },
  ...sendScripts.map((script) => ({ send: { text: units(script) } })),
];
const planCases = operations.map((operation) => ({
  requestJson: encodeProjectConsoleOperation(operation),
  replyJson: "",
  operation,
}));
for (const c of planCases) {
  c.replyJson = encodeProjectConsolePlan(await answerConsolePlan(c.operation));
  delete c.operation;
}

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
      httpStatus: code === "httpError" ? { value: 400 } : absent,
      detail: code === "httpError" ? { value: units("bad") } : absent,
    },
  })),
];
const finishCases = [];
for (const operation of operations)
  for (const outcome of outcomes) {
    if (random() > 0.3 && !("done" in outcome)) continue;
    const request = { operation, outcome };
    finishCases.push({
      requestJson: encodeProjectConsoleFinish(request),
      replyJson: encodeProjectConsoleResult(await answerConsoleFinish(request)),
    });
  }

// Configuration replies: every macro section, body and description shape.
const sections = [
  "gcode_macro load_filament",
  "GCODE_MACRO Bar",
  "Gcode_Macro mixed_Case",
  "gcode_macro\tTABBED",
  "gcode_macro   spaced  ",
  "gcode_macro  ",
  "gcode_macro \t",
  "gcode_macro \n",
  "gcode_macro x\ny",
  "gcode_macro \u00a0nbsp",
  "gcode_macrox",
  "gcode_macro",
  "gcode_macro straße",
  "extruder",
  "printer",
  "gcode_macro foo",
  "gcode_macro FOO",
  "gcode_macro two words",
];
const bodies = [
  "",
  "   ",
  "M105",
  "G28\nG1 Z10",
  "M84",
  "{% if params.X %}\nG28\n{% endif %}",
  "M109 S{params.TEMP|default(200)}\nG1 E{params['LENGTH']|default('50')} F{params.SPEED}",
  "{params.T} {params.T|default(1)}",
  '{params["Q"] | default( "q" )} {params[ \'A B\' ]}',
  "{rawparams} {params.1x} {params.} {params[]} {params['']}",
  "{params.X|default(min(1,2))} {params.Y |default()}",
  '{params.Z|default(\'mixed")} {params.W|default("line\nbreak")}',
  "{params.lower|default(  ' spaced '  )}",
  "PARAMS.X params.X_Y9 params.ü",
  "SET_HEATER_TEMPERATURE HEATER=extruder TARGET={params.T}",
  "M112",
  "FORCE_MOVE STEPPER=stepper_z DISTANCE=-10",
];
const descriptions = [
  undefined,
  "G-Code macro",
  "g-code MACRO",
  "  Loads filament  ",
  "",
  "   ",
  7,
];
function settingsReply() {
  const settings = {};
  for (let i = 0, n = 1 + Math.floor(random() * 6); i < n; i++) {
    const section = pick(sections);
    const value = pick([null, "text", [], ...Array(8).fill("record")]);
    if (value !== "record") {
      settings[section] = value;
      continue;
    }
    const entry = {};
    const body = pick([...bodies, undefined, 3]);
    if (body !== undefined) entry.gcode = body;
    const description = pick(descriptions);
    if (description !== undefined) entry.description = description;
    settings[section] = entry;
  }
  return settings;
}
const configReplies = [
  JSON.stringify(null),
  JSON.stringify({}),
  JSON.stringify({ status: null }),
  JSON.stringify({ status: { configfile: [] } }),
  JSON.stringify({ status: { configfile: { settings: "no" } } }),
  JSON.stringify({ status: { configfile: { settings: {} } } }),
  JSON.stringify({
    status: {
      configfile: {
        settings: Object.fromEntries(
          sections.map((section, i) => [
            section,
            { gcode: bodies[i % bodies.length], description: "Does a thing" },
          ]),
        ),
      },
    },
  }),
  JSON.stringify({
    status: {
      configfile: {
        settings: Object.fromEntries(
          bodies.map((gcode, i) => [`gcode_macro body_${i}`, { gcode }]),
        ),
      },
    },
  }),
  '{"status":{"configfile":{"settings":{"gcode_macro dup":{"gcode":"M105"},"gcode_macro dup":{"gcode":"M112"}}}}}',
];
for (let i = 0; i < 40; i++)
  configReplies.push(
    JSON.stringify({ status: { configfile: { settings: settingsReply() } } }),
  );
const readCases = [];
for (const reply of configReplies)
  readCases.push({ operation: { macros: {} }, reply });
readCases.push({ operation: { send: { text: units("M105") } }, reply: "{}" });
readCases.push({ operation: { send: { text: units("") } }, reply: '"ok"' });
const readRecords = [];
for (const { operation, reply } of readCases)
  readRecords.push({
    operationJson: encodeProjectConsoleOperation(operation),
    reply,
    replyJson: encodeProjectConsoleResult(
      await answerConsoleRead(operation, reply),
    ),
  });

// Invocations: values and names that need quoting, escaping or refusal.
const keys = [
  "temp",
  "TEMP",
  "speed",
  "a b",
  "a=b",
  "a;b",
  "a#b",
  'a"b',
  "a'b",
  "a\\b",
  "",
  "ß",
  "x\u00a0y",
  "under_score",
  "9",
];
const values = [
  "",
  "   ",
  "220",
  " 220 ",
  "hello world",
  "x#y",
  "c:\\dir",
  'say "hi"',
  "it's",
  "x;y",
  "x\ny",
  "x\ry",
  "tab\there",
  "nbsp\u00a0here",
  "a=b",
  "😀",
  "x\uD800",
  "-10.5",
];
const invocationRequests = [
  { name: units("load_filament"), values: [] },
  {
    name: units("load_filament"),
    values: [
      { key: units("temp"), value: units("220") },
      { key: units("speed"), value: units("") },
    ],
  },
  {
    name: units("SAY"),
    values: [
      { key: units("text"), value: units("first") },
      { key: units("text"), value: units("last wins") },
    ],
  },
];
for (const value of values)
  invocationRequests.push({
    name: units("m"),
    values: [{ key: units("a"), value: units(value) }],
  });
for (const key of keys)
  invocationRequests.push({
    name: units("m"),
    values: [{ key: units(key), value: units("1") }],
  });
for (let i = 0; i < 40; i++)
  invocationRequests.push({
    name: units(pick(["macro", "Mixed_Case", "ß", "two words"])),
    values: Array.from({ length: Math.floor(random() * 4) }, () => ({
      key: units(pick(keys.slice(0, 3).concat(keys.slice(11)))),
      value: units(pick(values)),
    })),
  });
const invocationCases = invocationRequests.map((request) => ({
  requestJson: encodeProjectMacroInvocationRequest(request),
  replyJson: encodeProjectMacroInvocation(answerMacroInvocation(request)),
}));

// Transcript lines: redaction on the way in, and notifications classified.
const texts = [
  "M105",
  "M117 key super-secret-key",
  "ok T:210 /0.0 B:60 /0.0",
  "see http://printer.local/server?token=abc for more",
  "api_key=topsecret and password: hunter2",
  "\u0001control\u0007runs\u001b[0m",
  "x".repeat(600),
  "",
  "   ",
  "😀 unicode",
  "Bearer abc.def.ghi",
];
const secretSets = [
  [],
  ["super-secret-key"],
  ["", "abc"],
  ["hunter2", "T:210"],
];
const lineCases = [];
for (const text of texts)
  for (const kind of ["sent", "received", "error"]) {
    const request = {
      line: { kind, text: units(text) },
      secrets: pick(secretSets).map(units),
    };
    lineCases.push({
      requestJson: encodeProjectConsoleLineRequest(request),
      replyJson: encodeProjectConsoleLine(answerConsoleLine(request)),
    });
  }
const paramsTexts = [
  '["ok"]',
  '["!! Must home axis first"]',
  '["Error: unknown"]',
  '["error lower"]',
  '["ERRORS"]',
  '["  !!x  "]',
  '["!!"]',
  '[" "]',
  "[]",
  '"bare string"',
  "{}",
  "[1]",
  "[null]",
  '[["nested"]]',
  '["key super-secret-key"]',
  '["ok", "second"]',
  "null",
];
const notificationCases = [];
for (const params of paramsTexts)
  for (const method of [
    "notify_gcode_response",
    pick(["notify_status_update", "notify_gcode_response "]),
  ]) {
    const request = {
      method: units(method),
      secrets: pick(secretSets).map(units),
    };
    notificationCases.push({
      requestJson: encodeProjectConsoleNotificationRequest(request),
      params,
      replyJson: encodeProjectOptionalConsoleLine(
        answerConsoleNotification(request, params),
      ),
    });
  }
const recentCases = [];
for (const limit of [20, 0, 1, 2, 2.5, -1, 1e300]) {
  for (let i = 0; i < 4; i++) {
    const request = {
      lines: Array.from({ length: Math.floor(random() * 12) }, () => ({
        kind: pick(["sent", "sent", "received", "error"]),
        text: units(pick(["M105", "G28", "ok", "M114", "M105"])),
      })),
      limit,
    };
    recentCases.push({
      requestJson: encodeProjectConsoleRecentRequest(request),
      replyJson: encodeProjectTextList(answerConsoleRecent(request)),
    });
  }
}

const sources = [
  "tools/cross-platform/printer-console-vectors.mjs",
  "web/src/printer/PrinterConsoleExchange.ts",
  "web/src/printer/PrinterConsole.ts",
  "web/src/printer/SessionCredentials.ts",
  "web/src/printer/PrinterWire.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const corpus = {
  assessments: assessCases,
  plans: planCases,
  finishes: finishCases,
  reads: readRecords,
  invocations: invocationCases,
  lines: lineCases,
  notifications: notificationCases,
  recents: recentCases,
};
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    ...corpus,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-console-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer console reference drift",
  );
console.log(
  `Printer console references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
