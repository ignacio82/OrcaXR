import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const id = units("import:fixture:\u0000\ud800\udfff");
const name = units("Plate \ud800");
const commands = [
  { addPlate: { plateId: id, name, order: 0, activate: false } },
  {
    duplicatePlate: {
      sourcePlateId: id,
      plateId: units("import:fixture:copy"),
      objects: [
        {
          objectId: id,
          volumeIds: [id],
          instanceIds: [id],
          layerRangeIds: [id],
        },
      ],
      customGcodeIds: [id],
      thumbnailIds: [id],
    },
  },
  { deletePlate: { plateId: id } },
  { activatePlate: { plateId: id } },
  { renamePlate: { plateId: id, name } },
  { reorderPlates: { plateIds: [id, units("import:fixture:second")] } },
  { setPlatePrintable: { plateId: id, printable: true } },
];
const cases = [];
function valid(label, value, input = JSON.stringify(value), kind = "Intent") {
  cases.push({ label, kind, input, expected: structuredClone(value) });
}
function invalid(label, input, kind = "Intent") {
  cases.push({ label, kind, input, expected: null });
}
for (const command of commands) {
  const operation = Object.keys(command)[0];
  const intent = { version: 1, command };
  valid(operation, intent);
  const payload = command[operation];
  for (const key of Object.keys(payload)) {
    const missing = structuredClone(intent);
    delete missing.command[operation][key];
    invalid(`${operation}:missing:${key}`, JSON.stringify(missing));
    const nullValue = structuredClone(intent);
    nullValue.command[operation][key] = null;
    invalid(`${operation}:null:${key}`, JSON.stringify(nullValue));
    invalid(
      `${operation}:duplicate:${key}`,
      JSON.stringify(intent).replace(`"${key}":`, `"${key}":null,"${key}":`),
    );
    const wrong = structuredClone(intent);
    wrong.command[operation][key] =
      typeof payload[key] === "boolean"
        ? 1
        : typeof payload[key] === "number"
          ? "0"
          : {};
    invalid(`${operation}:wrong:${key}`, JSON.stringify(wrong));
  }
  const extra = structuredClone(intent);
  extra.command[operation].extra = false;
  invalid(`${operation}:extra`, JSON.stringify(extra));
  const positional = structuredClone(intent);
  positional.command[operation] = Object.values(payload);
  invalid(`${operation}:positional`, JSON.stringify(positional));
  invalid(
    `${operation}:unknown-variant`,
    JSON.stringify({ version: 1, command: { unknown: payload } }),
  );
}
const add = { version: 1, command: commands[0] };
const raw = JSON.stringify(add);
for (const version of ["1.0", "1e0", "0.1e1", "1.00000000000000001"])
  valid(
    `version:${version}`,
    add,
    raw.replace('"version":1', `"version":${version}`),
  );
for (const version of ["0", "2", "-1", "1.1", "true", "null", '"1"', "1e400"])
  invalid(
    `version:${version}`,
    raw.replace('"version":1', `"version":${version}`),
  );
for (const order of ["-0", "0.0", "0e20"])
  valid(`order:${order}`, add, raw.replace('"order":0', `"order":${order}`));
for (const order of [
  "9007199254740991",
  "9007199254740991.1",
  "9.007199254740991e15",
]) {
  const expected = structuredClone(add);
  expected.command.addPlate.order = 9007199254740991;
  valid(
    `order:${order}`,
    expected,
    raw.replace('"order":0', `"order":${order}`),
  );
}
for (const order of ["-1", "0.5", "1e309", '"0"'])
  invalid(`order:${order}`, raw.replace('"order":0', `"order":${order}`));
for (const order of [9007199254740992, 1e100, Number.MAX_VALUE]) {
  const value = structuredClone(add);
  value.command.addPlate.order = order;
  valid(`finite integer order ${order}`, value);
}
valid("escaped field name", add, raw.replace('"version"', '"vers\\u0069on"'));
valid("JSON whitespace", add, " \t\r\n" + raw + " \r\n");
for (const [label, input] of [
  ["duplicate envelope", raw.replace('"version":1', '"version":1,"version":1')],
  [
    "duplicate escaped",
    raw.replace('"version":1', '"version":1,"vers\\u0069on":1'),
  ],
  ["unknown envelope", raw.replace('"version":1', '"extra":0,"version":1')],
  [
    "multiple variants",
    JSON.stringify({ version: 1, command: { ...commands[0], ...commands[2] } }),
  ],
  ["empty command", '{"version":1,"command":{}}'],
  ["positional envelope", JSON.stringify([1, commands[0]])],
  ["trailing comma", raw.slice(0, -1) + ",}"],
  ["leading zero", raw.replace('"version":1', '"version":01')],
  ["trailing value", raw + "null"],
  ["comment", raw + "// no"],
  ["BOM", "\uFEFF" + raw],
  ["non ASCII wire", raw.replace('"version"', '"versión"')],
  ["literal control", raw.replace('"version"', '"ver\nversion"')],
  ["unpaired escape key", raw.replace('"version"', '"\\ud800"')],
  ["deep nesting", "[".repeat(14) + "0" + "]".repeat(14)],
  ["prototype key", '{"__proto__":{},"version":1,"command":{}}'],
  ["wrong root", "null"],
  ["empty", ""],
  ["truncated", raw.slice(0, -1)],
])
  invalid(label, input);
for (const unit of [-1, 65536, 0.5, "65", null, true]) {
  const value = structuredClone(add);
  value.command.addPlate.plateId = [unit];
  invalid(`bad unit ${JSON.stringify(unit)}`, JSON.stringify(value));
}
for (const key of ["name", "plateId"]) {
  const value = structuredClone(add);
  value.command.addPlate[key] = [];
  invalid(`empty ${key}`, JSON.stringify(value));
}
const longName = {
  version: 1,
  command: { renamePlate: { plateId: id, name: Array(120).fill(0) } },
};
valid("120 unit rename", longName);
longName.command.renamePlate.name.push(0);
invalid("121 unit rename", JSON.stringify(longName));
const addedName = structuredClone(add);
addedName.command.addPlate.name = Array(160).fill(65);
valid("160 unit added name", addedName);
addedName.command.addPlate.name.push(65);
invalid("161 unit added name", JSON.stringify(addedName));
const unitsBoundary = structuredClone(add);
unitsBoundary.command.addPlate.plateId = [0, 55296, 56319, 56320, 57343, 65535];
valid("unit boundaries", unitsBoundary);
const decimalUnits = structuredClone(add);
decimalUnits.command.addPlate.plateId = [65, 65, 0];
valid(
  "unit numeric value semantics",
  decimalUnits,
  JSON.stringify(decimalUnits).replace("[65,65,0]", "[65.0,6.5e1,-0]"),
);
for (const malformed of [
  "+0",
  ".0",
  "-00",
  "NaN",
  "Infinity",
  "01",
  "1.",
  "1e",
  "1e+",
  "0x0",
])
  invalid(
    `non JSON numeric ${malformed}`,
    raw.replace('"order":0', `"order":${malformed}`),
  );
invalid("invalid field escape", raw.replace('"version"', '"ver\\sion"'));
invalid("single quoted field", raw.replace('"version"', "'version'"));
for (const token of ["False", "FALSE", "TRUE", "True", "undefined"])
  invalid(
    `non JSON boolean ${token}`,
    raw.replace('"activate":false', `"activate":${token}`),
  );
invalid("leading array comma", raw.replace('"name":[', '"name":[, '));
invalid(
  "trailing array comma",
  raw.replace(JSON.stringify(name), JSON.stringify(name).slice(0, -1) + ",]"),
);
invalid("array null gap", raw.replace('"name":[', '"name":[null, '));
const nested = { version: 1, command: commands[1] };
for (const field of ["objectId", "volumeIds", "instanceIds", "layerRangeIds"]) {
  const missing = structuredClone(nested);
  delete missing.command.duplicatePlate.objects[0][field];
  invalid(`nested object missing ${field}`, JSON.stringify(missing));
  invalid(
    `nested object duplicate ${field}`,
    JSON.stringify(nested).replace(
      `"${field}":`,
      `"${field}":null,"${field}":`,
    ),
  );
}
const nestedExtra = structuredClone(nested);
nestedExtra.command.duplicatePlate.objects[0].extra = 1;
invalid("nested unknown field", JSON.stringify(nestedExtra));
const nestedPositional = structuredClone(nested);
nestedPositional.command.duplicatePlate.objects[0] = Object.values(
  nested.command.duplicatePlate.objects[0],
);
invalid("nested positional object", JSON.stringify(nestedPositional));
const batch = { version: 1, label: units("Atomic \udfff"), commands };
valid("all commands batch", batch, JSON.stringify(batch), "Batch");
valid("empty batch", { ...batch, commands: [] }, undefined, "Batch");
valid(
  "64 command batch",
  { ...batch, commands: Array(64).fill(commands[2]) },
  undefined,
  "Batch",
);
invalid(
  "65 command batch",
  JSON.stringify({ ...batch, commands: Array(65).fill(commands[2]) }),
  "Batch",
);
invalid("missing label", JSON.stringify({ version: 1, commands }), "Batch");
invalid(
  "callback transaction",
  '{"version":1,"label":[65],"callback":"execute()","commands":[]}',
  "Batch",
);

// Session expectations are authored here, independently of generated converters.
const generation = [0, 1, 2147483648, 4294967295];
const guard = {
  projectId: id,
  revision: 9007199254740991,
  semanticHash: units("fnv1a64:0123456789abcdef"),
  assetFingerprint: units("fnv1a64:fedcba9876543210"),
  historyRevision: 4,
};
const label = {
  text: units("History \\ud800"),
  present: true,
  truncated: false,
};
const history = {
  undoCount: 1,
  redoCount: 0,
  undoLabel: label,
  redoLabel: { text: [], present: false, truncated: false },
  dirtyCategories: ["projectData", "presets", "printerDevice"],
};
const operations = [
  {
    hello: {
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      projectSchemaVersion: 1,
      intentVersion: 1,
    },
  },
  { execute: { guard, intent: add } },
  { transaction: { guard, batch } },
  { undo: guard },
  { redo: guard },
  { query: {} },
  { cancel: { targetRequestId: 2 } },
  { close: {} },
];
const results = [
  { acknowledged: { guard, history, changed: true } },
  {
    welcome: {
      protocolVersion: 1,
      projectSchemaVersion: 1,
      intentVersion: 1,
      maxPending: 32,
      maxBytes: 1048576,
      maxNodes: 131072,
    },
  },
  { cancelled: "requested" },
  { cancelled: "notPending" },
  { closed: {} },
  { receiptUnavailable: true },
  { receiptUnavailable: false },
  ...[
    "invalidRequest",
    "unsupportedVersion",
    "wrongSession",
    "notReady",
    "duplicateRequest",
    "stale",
    "cancelled",
    "busy",
    "disposed",
    "commandFailed",
    "resourceLimit",
  ].map((error) => ({ error })),
];
for (const [kind, values] of [
  [
    "SessionRequest",
    operations.map((operation) => ({
      protocolVersion: 1,
      generation,
      requestId: 2,
      operation,
    })),
  ],
  [
    "SessionReply",
    results.map((result) => ({
      protocolVersion: 1,
      generation,
      requestId: 2,
      result,
    })),
  ],
]) {
  for (const [index, value] of values.entries()) {
    valid(`${kind}:${index}`, value, undefined, kind);
    // Walk named objects at every nesting level, including the required {}.
    function walk(object, path = []) {
      if (!object || typeof object !== "object" || Array.isArray(object))
        return;
      for (const mode of ["extra", "positional", "null"]) {
        let mutated = structuredClone(value);
        const replacement =
          mode === "extra"
            ? { ...object, unknown: false }
            : mode === "positional"
              ? Object.values(object)
              : null;
        if (!path.length) mutated = replacement;
        else {
          let parent = mutated;
          for (const step of path.slice(0, -1)) parent = parent[step];
          parent[path.at(-1)] = replacement;
        }
        invalid(
          `${kind}:${index}:${path.join(".")}:${mode}`,
          JSON.stringify(mutated),
          kind,
        );
      }
      for (const key of Object.keys(object)) {
        const missing = structuredClone(value);
        let parent = missing;
        for (const step of path) parent = parent[step];
        delete parent[key];
        invalid(
          `${kind}:${index}:${path.join(".")}:missing:${key}`,
          JSON.stringify(missing),
          kind,
        );
        walk(object[key], [...path, key]);
      }
    }
    walk(value);
    const raw = JSON.stringify(value);
    invalid(
      `${kind}:${index}:duplicate`,
      raw.replace('"requestId":2', '"requestId":2,"requestId":2'),
      kind,
    );
  }
}
for (const [field, values] of [
  [
    "generation",
    [
      [],
      [0, 1, 2],
      [0, 1, 2, 3, 4],
      [0, 0, 0, -1],
      [0, 0, 0, 4294967296],
      [0, 0, 0, "1"],
    ],
  ],
  ["requestId", [0, -1, 0.5, 9007199254740992]],
  ["protocolVersion", [-1, 0.5, "1"]],
]) {
  for (const value of values)
    invalid(
      `SessionRequest:${field}:${JSON.stringify(value)}`,
      JSON.stringify({
        protocolVersion: 1,
        generation,
        requestId: 2,
        operation: { query: {} },
        [field]: value,
      }),
      "SessionRequest",
    );
}
valid(
  "unrecognized request protocol reaches negotiation",
  { protocolVersion: 2, generation, requestId: 1, operation: operations[0] },
  undefined,
  "SessionRequest",
);
invalid(
  "unsupported reply protocol",
  JSON.stringify({
    protocolVersion: 2,
    generation,
    requestId: 1,
    result: { closed: {} },
  }),
  "SessionReply",
);
for (const result of [
  { error: "UNKNOWN" },
  { error: 1 },
  { cancelled: "cancelled" },
  { cancelled: 0 },
  {
    acknowledged: {
      guard,
      history: { ...history, dirtyCategories: ["unknown"] },
      changed: false,
    },
  },
])
  invalid(
    "unknown result enum " + JSON.stringify(result),
    JSON.stringify({ protocolVersion: 1, generation, requestId: 1, result }),
    "SessionReply",
  );

const payload = JSON.stringify({ schemaVersion: 1, cases }, null, 2) + "\n";
const path = new URL(
  "testdata/cross-platform/project-intent-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, payload);
else
  assert.equal(
    readFileSync(path, "utf8"),
    payload,
    "Project intent vectors need regeneration",
  );
console.log(`${cases.length} independently authored project intent cases.`);
