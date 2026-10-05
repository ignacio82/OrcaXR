// Independent Date.parse/toFixed and actual project-validator oracles. Rust is
// never imported here. Both Node and the installed Chromium supply expectations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser } from "../../web/scripts/preview-harness.mjs";
import { createEmptyProject } from "../../web/src/project/domain/model.ts";
import {
  UuidIdSource,
  seededRandom,
} from "../../web/src/project/domain/ids.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
const root = new URL("../../", import.meta.url);
const units = (text) =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const finite = (n) => (Number.isFinite(n) ? n : null);
const dates = new Map();
function add(text, name = text) {
  if (!dates.has(text)) dates.set(text, name);
}
const seeds = [
  "",
  " ",
  "invalid",
  "0",
  "00",
  "1",
  "12",
  "13",
  "31",
  "32",
  "49",
  "50",
  "99",
  "100",
  "0000",
  "0001",
  "0099",
  "2026",
  "+002026",
  "-000001",
  "-000000",
  "2026-10",
  "2026-10-05",
  "2026-10-05T12:34:56.789Z",
  "2026-10-05T12:34:56.789",
  "2026-10-05T12:34:56+05:45",
  "Jan 1 2000",
  "Feb 2000",
  "01 Jan 2000",
  "Dec 31 99",
  "1 2",
  "1 2 3",
  "Wed, 09 Feb 1994 22:23:32 GMT",
  "Mon Oct 05 2026 12:34:56 GMT-0400 (Eastern Daylight Time)",
  "garbage 2026-10-05",
  "garbage2026-10-05",
  "Septemberish 12 2026",
  "1/2/03",
  "31/12/2026",
  "2026/1/2",
  "2026-1-2",
  "2026.1.2",
  "2026,1,2",
  "Jan 1 2000 12:34 PM",
  "Jan 1 2000 0:00 AM",
  "Jan 1 2000 24:00",
  "Jan 1 2000 1::2",
  "Jan 1 2000 1:.2",
  "Jan 1 2000 1:2:3.4",
  "Jan 1 2000 UTC+500000:00",
  "Jan 1 2000 GMT+999999999:59",
  "+275760-09-13T00:00:00.000",
  "+275760-09-13T00:00:00.001",
  "-271821-04-20T00:00:00.000",
  "-271821-04-19T23:59:59.999",
];
seeds.forEach((s) => add(s));
for (const year of [
  "-999999",
  "-271822",
  "-271821",
  "-004000",
  "-000001",
  "-000000",
  "0000",
  "0001",
  "0099",
  "0100",
  "1900",
  "2000",
  "2024",
  "2026",
  "9999",
  "+010000",
  "+275760",
  "+275761",
  "+999999",
]) {
  for (const month of ["00", "01", "02", "04", "09", "12", "13"]) {
    for (const day of ["00", "01", "28", "29", "30", "31", "32"]) {
      for (const time of ["", "T00:00:00Z", "T23:59:59.999"])
        add(`${year}-${month}-${day}${time}`);
    }
  }
}
for (const time of [
  "00:00",
  "23:59",
  "24:00",
  "24:00:00.0000",
  "24:00:00.0000000001",
  "24:00:01",
  "24:01",
  "25:00",
  "12:60",
  "12:34:60",
  "1:02",
  "01:2",
  "01::02",
  "01:02:03.",
  "01:02:03.1",
  "01:02:03.0000000001",
  "01:02:03.001234567890123",
  "01:02:03.0000000001234567890",
]) {
  for (const separator of ["T", "t", " "])
    for (const zone of [
      "",
      "Z",
      "z",
      "+05:45",
      "-2359",
      "+24:00",
      "+1:00",
      "+123",
      "Z ",
      "GMT",
    ])
      add(`2026-10-05${separator}${time}${zone}`);
}
for (const zone of [
  "UT",
  "UTC",
  "GMT",
  "Z",
  "EST",
  "EDT",
  "CST",
  "CDT",
  "MST",
  "MDT",
  "PST",
  "PDT",
  "AM",
  "PM",
  "utcgarbage",
]) {
  for (const value of [
    "",
    "+8",
    "-0830",
    "+23:59",
    "+24:00",
    "+99:99",
    "+298261:37",
    "+298262:00",
    "+500000:00",
    "+596523:14",
    "+596524:00",
    "+999999999:59",
    "+9999999999:",
    "+000000000999999999:",
    "+:",
    "-:30",
    "+08:60",
  ])
    add(`Jan 1 1970 00:00 ${zone}${value}`);
}
for (const word of [
  "Jan",
  "January",
  "Januarysuffix",
  "jan\ud800",
  "january\u2028",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
  "Unknown",
]) {
  for (const part of [
    "1 49",
    "50 1",
    "1 99",
    "0 1",
    "0001",
    "1",
    "32 1",
    "2026 31",
  ])
    add(`${word} ${part}`);
}
const whitespace = [
  9,
  10,
  11,
  12,
  13,
  0x20,
  0xa0,
  0x1680,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
  0x85,
  0x180e,
  0x200b,
  0xd800,
  0xdc00,
  0,
];
for (const unit of whitespace) {
  const ch = String.fromCharCode(unit);
  for (const text of [
    `${ch}2026-10-05`,
    `2026-10-05${ch}`,
    `Jan${ch}1${ch}2000`,
    `Jan 1 2000${ch}12:00`,
    `2026-10-05T12:00:00Z${ch}garbage`,
  ])
    add(text);
}
for (const comment of [
  "(comment)",
  "((nested))",
  "(unterminated",
  "(\0ignored",
  "(((()",
  "()",
  "))",
]) {
  for (const text of [
    `${comment}Jan 1 2000`,
    `Jan 1 2000${comment}`,
    `Jan 1 ${comment}2000`,
    `2026-10-05T00:00Z${comment}`,
  ])
    add(text);
}
let seed = 0x719ade62;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const alphabet = Array.from("0123456789-+:/.,TZJan() \t\n\0\u2028\ud800");
for (let i = 0; i < 2500; i++) {
  let text = seeds[rand() % seeds.length];
  for (let j = 0; j < 1 + (i % 3); j++) {
    const at = rand() % (text.length + 1),
      op = rand() % 3,
      ch = alphabet[rand() % alphabet.length];
    text =
      op === 0
        ? text.slice(0, at) + ch + text.slice(at)
        : op === 1
          ? text.slice(0, at) + text.slice(at + 1)
          : text.slice(0, at) + ch + text.slice(at + 1);
  }
  add(text, `mutation-${i}`);
}
const texts = [...dates.keys()];
const zones = [
  { name: "UTC", eastMs: 0 },
  { name: "Etc/GMT+12", eastMs: -12 * 3600000 },
  { name: "Etc/GMT-14", eastMs: 14 * 3600000 },
];
const originalTimezone = process.env.TZ;
const withTimezone = (zone, work) => {
  process.env.TZ = zone;
  try {
    return work();
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
};
const nodeResults = zones.map((zone) =>
  withTimezone(zone.name, () => texts.map((text) => finite(Date.parse(text)))),
);
assert.equal(
  withTimezone("UTC", () => Date.parse("Jan 1 1970 GMT+500000:00")),
  -1800000000000,
  "This corpus requires the Smi32 Node oracle",
);
const data = new DataView(new ArrayBuffer(8));
const bits = (n) => {
  data.setFloat64(0, n);
  return data.getBigUint64(0).toString(16).padStart(16, "0");
};
const fromBits = (b) => {
  data.setBigUint64(0, b);
  return data.getFloat64(0);
};
const heights = new Map();
const height = (n) => {
  if (Number.isFinite(n)) heights.set(bits(n), n);
};
const around = (n) => {
  height(n);
  const b = BigInt("0x" + bits(n));
  if (b > 0n) height(fromBits(b - 1n));
  if (b < 0xffffffffffffffffn) height(fromBits(b + 1n));
};
[
  0,
  -0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  1e-4,
  -1e-4,
  1e21,
  -1e21,
  1e20,
  -1e20,
  10000,
  10000.00005,
  Number.MAX_SAFE_INTEGER,
  1.005,
  2.675,
  0.03125,
  -0.03125,
].forEach(around);
for (let i = 0; i < 700; i++) {
  const n = (rand() % 100000001) / 10000 + 0.00005;
  around(n);
  around(-n);
  around((i * 2 + 1) / 32);
  around(-(i * 2 + 1) / 32);
}
for (let i = 0; i < 2500; i++)
  height(fromBits((BigInt(rand()) << 32n) | BigInt(rand())));
const heightEntries = [...heights].map(([b, n]) => [b, n.toFixed(4)]);
const base = createEmptyProject({
  idSource: new UuidIdSource(seededRandom(27)),
  now: "2026-10-05T00:00:00Z",
});
withTimezone("UTC", () =>
  texts.forEach((text, i) => {
    const issues = validateProjectState({
      ...base,
      createdAt: text,
      updatedAt: text,
    });
    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.path]),
      nodeResults[0][i] === null
        ? [
            ["invalid-timestamp", "createdAt"],
            ["invalid-timestamp", "updatedAt"],
          ]
        : [],
      `Project timestamp reference ${i}`,
    );
  }),
);
const pairs = [
  [0, -0],
  [0, -Number.MIN_VALUE],
  [0, Number.MIN_VALUE],
  [0.03125, 0.0313],
  [-0.03125, -0.0313],
  [10000, 10000.000049],
  [1e21, 1e21],
];
for (let i = 0; i < 120; i++) {
  const n = (i + 1) / 8;
  pairs.push([n, n + 0.000049], [n, n + 0.000051]);
}
const collisions = pairs.map(([a, b]) => {
  const state = {
    ...base,
    customGcode: [a, b].map((topZMm, i) => ({
      id: `import:gcode:${i}`,
      name: "fixture",
      scope: "plate",
      plateId: base.activePlateId,
      trigger: "before-layer",
      code: "",
      layerEvent: { type: "pause", topZMm },
    })),
  };
  const issues = validateProjectState(state).filter(
    (issue) => issue.code === "duplicate-layer-event",
  );
  const expected = a.toFixed(4) === b.toFixed(4);
  assert.deepEqual(
    issues.map((issue) => issue.path),
    expected ? ["customGcode[1].layerEvent.topZMm"] : [],
  );
  return [bits(a), bits(b), expected];
});
const localInputs = [
  "2024-03-10T01:59:59.999",
  "2024-03-10T02:00:00",
  "2024-03-10T02:30:00",
  "2024-03-10T03:00:00",
  "2024-11-03T01:30:00",
  "2024-11-03T02:00:00",
  "2024-10-06T02:15:00",
  "2024-04-07T01:45:00",
  "2011-12-30T12:00:00",
  "1900-01-01T00:00:00",
  "0001-01-01T00:00:00",
  "2026-02-31T12:34:56.789",
];
const dstZones = [
  "America/New_York",
  "Australia/Lord_Howe",
  "Pacific/Apia",
  "Asia/Kathmandu",
];
const localCivil = withTimezone("UTC", () =>
  localInputs.map((text) => Date.parse(text)),
);
const dstNode = dstZones.map((zone) =>
  withTimezone(zone, () => localInputs.map((text) => Date.parse(text))),
);
let browser;
let browserResults, dstBrowser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.emulateTimezone("UTC");
  assert.equal(
    await page.evaluate(() =>
      Number.isNaN(Date.parse("Jan 1 1970 GMT+500000:00")),
    ),
    true,
    "This corpus requires the Smi31 Chromium oracle",
  );
  browserResults = [];
  for (const zone of zones) {
    await page.emulateTimezone(zone.name);
    browserResults.push(
      await page.evaluate(
        (texts) =>
          texts.map((text) =>
            Number.isFinite(Date.parse(text)) ? Date.parse(text) : null,
          ),
        texts,
      ),
    );
  }
  dstBrowser = [];
  for (const zone of dstZones) {
    await page.emulateTimezone(zone);
    dstBrowser.push(
      await page.evaluate(
        (texts) => texts.map((text) => Date.parse(text)),
        localInputs,
      ),
    );
  }
  const browserKeys = await page.evaluate(
    (values) =>
      values.map((hex) => {
        const b = new ArrayBuffer(8),
          v = new DataView(b);
        v.setBigUint64(0, BigInt("0x" + hex));
        return v.getFloat64(0).toFixed(4);
      }),
    heightEntries.map(([b]) => b),
  );
  assert.deepEqual(
    browserKeys,
    heightEntries.map(([, value]) => value),
  );
  console.log(
    `Date/toFixed oracles: ${process.version} / ${await browser.version()}`,
  );
  await page.close();
} finally {
  await browser?.close();
}
const sources = [
  "web/src/project/domain/validation.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/canonical.ts",
  "web/src/project/domain/ids.ts",
  "tools/cross-platform/validation-value-vectors.mjs",
];
const result = {
  schemaVersion: 1,
  syntaxReference: "nodejs/node@v22.21.0/deps/v8/src/date/dateparser",
  sources: sources.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex"),
  })),
  zones,
  timestamps: texts.map((text, i) => ({
    name: JSON.stringify(dates.get(text)),
    units: units(text),
    smi32: nodeResults.map((zone) => zone[i]),
    smi31: browserResults.map((zone) => zone[i]),
  })),
  heights: heightEntries,
  collisions,
  localTimes: localInputs.map((text, i) => ({
    units: units(text),
    civil: localCivil[i],
    zones: dstZones.map((zone, j) => ({
      zone,
      smi32: dstNode[j][i],
      smi31: dstBrowser[j][i],
    })),
  })),
};
const output = JSON.stringify(result, null, 2) + "\n";
const path = new URL(
  "testdata/cross-platform/validation-value-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Validation value reference drift",
  );
console.log(
  `Validation references: ${texts.length} timestamp strings in ${zones.length} fixed zones, ${localInputs.length * dstZones.length} local DST/history conversions, ${heightEntries.length} binary64 rounding values, ${collisions.length} actual project collision checks`,
);
