// Independent G-code expectations: malformed numbers, over-long lines,
// truncated and rejected arcs, unsupported and invalid commands, letters
// outside ASCII, every allocation cap, BOM/CRLF handling and modal
// kinematics — each written by hand from the pinned semantics, not taken
// from either parser. The browser parser must meet them before they are
// written, and the Rust parser meets the same file, so the two adapters
// cannot agree on a new bug unnoticed (the replay corpora only compare them
// with each other).
//
// Also: invalid UTF-8 at the decode boundary. Hosts read G-code bytes as
// `TextDecoder('utf-8', { fatal: false })` does; hand-picked and seeded
// random byte strings, whole and split into streamed chunks, record Node's
// WHATWG decoder output for the Rust decoder native hosts use.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  GCODE_RECORD_KIND_NAMES,
  parseRichGcodeModel,
} from "../../web/src/slicer/RichGcodeModel.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const f32 = Math.fround;

// --- Hand-written expectations -----------------------------------------------------
// A record is [kind, endX, endY, endZ, deltaE, line]; a warning is
// [code, severity, line]. Positions are Float32 as the columns store them.
const W = "warning";
const E = "error";
const cases = [
  {
    name: "malformed numbers",
    gcode: "G1 X1.2.3 Y--1 Z1e400 E1e39 F+.5e3\n",
    // `1.2` reads up to the second point; `.` and `3` are stray tokens; `--1`
    // has no number; 1e400 is past float64 and 1e39 past float32.
    warnings: [
      ["malformed-token", W, 1],
      ["malformed-token", W, 1],
      ["invalid-parameter", W, 1],
      ["invalid-parameter", W, 1],
      ["invalid-parameter", W, 1],
    ],
    records: [["travel", f32(1.2), 0, 0, 0, 1]],
  },
  {
    name: "over-long lines",
    limits: { lineCharacters: 24 },
    // Line 4 and 5 are exactly 24 characters (5 before its CR); 2 and 6 are
    // longer and skipped whole.
    gcode:
      "G1 X5\nG1 X10 ; this comment is long enough\nG1 X20\nG1 X40 ;aaaaaaaaaaaaaaaa\nG1 X50 ;aaaaaaaaaaaaaaaa\r\nG1 X60 ;aaaaaaaaaaaaaaaaa\n",
    warnings: [
      ["source-line-too-long", W, 2],
      ["source-line-too-long", W, 6],
    ],
    records: [
      ["travel", 5, 0, 0, 0, 1],
      ["travel", 20, 0, 0, 0, 3],
      ["travel", 40, 0, 0, 0, 4],
      ["travel", 50, 0, 0, 0, 5],
    ],
  },
  {
    name: "truncated arcs",
    // A centreless arc still moves the modal endpoint (line 3 starts at
    // X10); P must truncate to one turn; `G2X5` and `G02` are not the exact
    // arc spellings and are ignored; R is not a centre.
    gcode: "G1 X0 Y0\nG2 X10 Y0\nG1 X10 Y5\nG3 X10 Y5 I-5 P2\nG2X5 Y5 I1\nG02 X0 Y0 I-5\nG2 X10 Y5 R5\n",
    warnings: [
      ["missing-arc-center", E, 2],
      ["invalid-arc-turns", E, 4],
      ["missing-arc-center", E, 7],
    ],
    records: [["travel", 10, 5, 0, 0, 3]],
  },
  {
    name: "a rejected arc word ends the parse",
    gcode: "G1 X1\nG2 X10 Y0 I1e39\nG1 X5\n",
    warnings: [
      ["invalid-parameter", W, 2],
      ["arc-parameter-range", E, 2],
    ],
    records: [["travel", 1, 0, 0, 0, 1]],
    parsedLines: 2,
    termination: "numeric-cap",
  },
  {
    name: "unsupported and invalid commands",
    gcode: [
      "M600",
      "G28",
      "G29 ; probe",
      "Q5",
      "5 X1",
      "#",
      "N12 G1 X3",
      "N-1 G1 X4",
      "N9.5 G1 X4",
      "G1.5 X9",
      "T300",
      "T255",
      "G1 X3 X6",
      "G1 X7 *57",
      "G1 X8 (comment X99)",
      "",
    ].join("\n"),
    warnings: [
      ["invalid-command", W, 5],
      ["invalid-command", W, 6],
      ["invalid-command-line-number", W, 8],
      ["invalid-command-line-number", W, 9],
      ["invalid-command", W, 10],
      ["invalid-tool-command", W, 11],
      ["duplicate-parameter", W, 13],
    ],
    records: [
      ["travel", 3, 0, 0, 0, 7],
      ["travel", 6, 0, 0, 0, 13],
      ["travel", 7, 0, 0, 0, 14],
      ["travel", 8, 0, 0, 0, 15],
    ],
  },
  {
    name: "letters outside ASCII",
    // Upstream reads bytes: nothing outside ASCII is a letter, whatever its
    // Unicode upper case (ı → I, ſ → S, ß → SS). An astral character is two
    // UTF-16 units, so two stray tokens.
    gcode: "G1 ı" + "5 X1\nſ1 X2\nG1 X3 ß4\nG1 \u{1f600} X4\nｇ1 X5\n",
    warnings: [
      ["malformed-token", W, 1],
      ["malformed-token", W, 1],
      ["invalid-command", W, 2],
      ["malformed-token", W, 3],
      ["malformed-token", W, 3],
      ["malformed-token", W, 4],
      ["malformed-token", W, 4],
      ["invalid-command", W, 5],
    ],
    records: [
      ["travel", 1, 0, 0, 0, 1],
      ["travel", 3, 0, 0, 0, 3],
      ["travel", 4, 0, 0, 0, 4],
    ],
  },
  {
    name: "record cap",
    limits: { records: 3 },
    gcode: "G1 X1\nG1 X2\nG1 X3\nG1 X4\nG1 X5\n",
    warnings: [["record-cap", W, 4]],
    records: [
      ["travel", 1, 0, 0, 0, 1],
      ["travel", 2, 0, 0, 0, 2],
      ["travel", 3, 0, 0, 0, 3],
    ],
    parsedLines: 4,
    termination: "record-cap",
  },
  {
    name: "warning cap",
    limits: { warnings: 2 },
    // The last kept warning becomes the cap notice at the first one dropped.
    gcode: "#\n#\n#\n#\nG1 X1\n",
    warnings: [
      ["invalid-command", W, 1],
      ["warning-cap", W, 3],
    ],
    records: [["travel", 1, 0, 0, 0, 5]],
  },
  {
    name: "line cap",
    limits: { lines: 2 },
    gcode: "G1 X1\nG1 X2\nG1 X3\n",
    warnings: [["source-line-cap", W, 3]],
    records: [
      ["travel", 1, 0, 0, 0, 1],
      ["travel", 2, 0, 0, 0, 2],
    ],
    parsedLines: 2,
    termination: "line-cap",
  },
  {
    name: "input cap",
    limits: { inputCharacters: 14 },
    // 14 characters end inside line 3, which is reported and not parsed.
    gcode: "G1 X1\nG1 X22\nG1 X3\n",
    warnings: [
      ["input-character-cap", W, 0],
      ["truncated-source-line", W, 3],
    ],
    records: [
      ["travel", 1, 0, 0, 0, 1],
      ["travel", 22, 0, 0, 0, 2],
    ],
    parsedLines: 3,
    termination: "input-cap",
  },
  {
    name: "path point cap",
    limits: { pathPoints: 1 },
    gcode: "G1 X10 Y0\nG3 X-10 Y0 I-10 J0\nG1 X0\n",
    warnings: [["arc-path-point-cap", E, 2]],
    records: [["travel", 10, 0, 0, 0, 1]],
    parsedLines: 2,
    termination: "path-point-cap",
  },
  {
    name: "byte-order mark and CRLF",
    // Only line 1 may begin with a byte-order mark.
    gcode: "﻿G1 X1\r\nG1 X2\r\n﻿G1 X3\n",
    warnings: [["invalid-command", W, 3]],
    records: [
      ["travel", 1, 0, 0, 0, 1],
      ["travel", 2, 0, 0, 0, 2],
    ],
  },
  {
    name: "modal kinematics",
    gcode: [
      "G1 Z0.3 F600",
      "G1 X10 Y0 E1",
      "G1 E-0.5",
      "G1 E1",
      "G91",
      "G1 X5 Y5",
      "G1 X-5 E0.25",
      "G90",
      "M83",
      "G1 X0 Y5 E0.5",
      "G92 X100",
      "G1 X110",
      "G20",
      "G1 X1",
      "G21",
      ";LAYER_CHANGE",
      "G1 Z0.6",
      "",
    ].join("\n"),
    warnings: [],
    // Absolute E-0.5 after E1 retracts 1.5 and E1 restores it; G91 moves E too;
    // M83 makes E relative under G90; G92 X100 at X0 puts the origin at
    // -100; G20 scales by Float32 25.4.
    records: [
      ["travel", 0, 0, f32(0.3), 0, 1],
      ["extrude", 10, 0, f32(0.3), 1, 2],
      ["retract", 10, 0, f32(0.3), -1.5, 3],
      ["unretract", 10, 0, f32(0.3), 1.5, 4],
      ["travel", 15, 5, f32(0.3), 0, 6],
      ["extrude", 10, 5, f32(0.3), 0.25, 7],
      ["extrude", 0, 5, f32(0.3), 0.5, 10],
      ["travel", 10, 5, f32(0.3), 0, 12],
      ["travel", f32(-100 + f32(25.4)), 5, f32(0.3), 0, 14],
      ["layer-change", f32(-100 + f32(25.4)), 5, f32(0.3), 0, 16],
      ["travel", f32(-100 + f32(25.4)), 5, f32(0.6), 0, 17],
    ],
    layerCount: 1,
  },
];

/** The parts of a model the expectations name. */
function summary(model) {
  const c = model.columns;
  return {
    warnings: model.warnings.map((w) => [w.code, w.severity, w.line]),
    records: Array.from({ length: c.count }, (_, i) => [
      GCODE_RECORD_KIND_NAMES[c.kind[i]],
      c.endX[i],
      c.endY[i],
      c.endZ[i],
      c.deltaE[i],
      c.sourceLine[i],
    ]),
    layerCount: model.layerCount,
    parsedLines: model.parsedLines,
    complete: model.complete,
    termination: model.terminationReason ?? null,
  };
}
const oracle = cases.map((c) => {
  const lines = c.gcode.split("\n");
  const expected = {
    warnings: c.warnings,
    records: c.records,
    layerCount: c.layerCount ?? 0,
    parsedLines: c.parsedLines ?? (c.gcode.endsWith("\n") ? lines.length - 1 : lines.length),
    complete: c.termination === undefined,
    termination: c.termination ?? null,
  };
  const actual = summary(parseRichGcodeModel(c.gcode, c.limits ? { limits: c.limits } : {}));
  assert.deepEqual(actual, expected, `browser parser misses the expectation for ${c.name}`);
  return { name: c.name, gcode: units(c.gcode), options: { limits: c.limits ?? {} }, expected };
});

// --- UTF-8 decoding ----------------------------------------------------------------
let state = 0x9e3779b97f4a7c15n;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return Number(((state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 32n);
};
const tricky = [
  [],
  [0xef, 0xbb, 0xbf],
  [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x47],
  [0xef, 0xbb],
  [0x47, 0x31, 0x20, 0x58, 0xff, 0x31],
  [0xc0, 0xaf],
  [0xe0, 0x80, 0xaf],
  [0xed, 0xa0, 0x80],
  [0xed, 0x9f, 0xbf],
  [0xf4, 0x90, 0x80, 0x80],
  [0xf4, 0x8f, 0xbf, 0xbf],
  [0xf0, 0x9f, 0x98],
  [0xf0, 0x9f, 0x98, 0x80, 0xf0, 0x9f],
  [0xe2, 0x82, 0x41],
  [0x80, 0x80, 0xbf],
  [0xc3],
  [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x90, 0x8d, 0x88],
  [0xf8, 0x88, 0x80, 0x80, 0x80],
  [0xfe, 0xff, 0xc2, 0x80],
];
const alphabet = [0x00, 0x0a, 0x0d, 0x20, 0x47, 0x31, 0x7f, 0x80, 0x9f, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xe1, 0xed, 0xee, 0xef, 0xbb, 0xf0, 0xf1, 0xf4, 0xf5, 0xff];
const random = Array.from({ length: 300 }, () =>
  Array.from({ length: next() % 24 }, () => (next() % 4 === 0 ? next() & 0xff : alphabet[next() % alphabet.length])),
);
const decode = (bytes, splits) => {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let from = 0;
  for (const at of splits) {
    text += decoder.decode(Uint8Array.from(bytes.slice(from, at)), { stream: true });
    from = at;
  }
  text += decoder.decode(Uint8Array.from(bytes.slice(from)));
  return units(text);
};
const utf8 = [...tricky, ...random].map((bytes) => {
  // Every split point once, then a seeded run of several chunks.
  const splits = bytes.length < 2 ? [] : [1 + (next() % (bytes.length - 1))];
  const several = Array.from({ length: Math.min(3, bytes.length) }, () => next() % (bytes.length + 1)).sort((a, b) => a - b);
  const whole = decode(bytes, []);
  for (const chunks of [splits, several]) assert.deepEqual(decode(bytes, chunks), whole, "streaming changes the text");
  return { bytes, splits: several, units: whole };
});

// --- Differential fuzz ---------------------------------------------------------
// Seeded documents mixing valid commands with malformed numbers, stray and
// non-ASCII characters, checksums, comments, tags, arcs and small caps. The
// browser's summary is recorded and the Rust parser must reproduce it: the
// hand-written cases cannot list every spelling, and a difference anywhere
// is a bug in one of the two.
const pick = (list) => list[next() % list.length];
const numbers = ["0", "1", "-2.5", "10.125", ".5", "+.5e3", "1.2.3", "--1", "1e400", "1e39", "", "nan", "0x10", "3.", "-0", "1e-50", "200", "7e1"];
const letters = ["X", "Y", "Z", "E", "F", "I", "J", "P", "R", "S", "T", "x", "e", "\u0131", "\u017f", "\u00df"];
const noise = [" *57", " (note X9)", " ; trailing", "\t", " \u{1f600}", " \u00e9", "#", " .", "  "];
const commands = ["G0", "G1", "G1", "G1", "G2", "G3", "G02", "g1", "G92", "G90", "G91", "G20", "G21", "M82", "M83", "M104", "M106", "M107", "M109", "T0", "T1", "T3", "T255", "T300", "Q7", "N5 G1", "N-2 G1", "G1.5", "\ufeffG1"];
const tags = [";LAYER_CHANGE", ";TYPE:Outer wall", ";TYPE:", ";HEIGHT:0.2", ";HEIGHT:x", ";WIDTH:0.45", ";WIPE_START", ";WIPE_END", ";COLOR_CHANGE,T1,#FF0000", ";PAUSE_PRINT", "; MANUAL_TOOL_CHANGE T2", ""];
const fuzzLine = () => {
  if (next() % 6 === 0) return pick(tags);
  let line = pick(commands);
  for (let words = next() % 5; words > 0; words -= 1) {
    line += (next() % 3 ? " " : "") + pick(letters) + pick(numbers);
    if (next() % 7 === 0) line += pick(noise);
  }
  if (next() % 9 === 0) line += " ;" + "x".repeat(next() % 70);
  return line;
};
const capOptions = () =>
  next() % 3
    ? {}
    : {
        limits: Object.fromEntries(
          [
            ["records", 1 + (next() % 20)],
            ["warnings", 1 + (next() % 8)],
            ["lines", 1 + (next() % 30)],
            ["lineCharacters", 8 + (next() % 56)],
            ["pathPoints", 1 + (next() % 60)],
            ["inputCharacters", 10 + (next() % 400)],
          ].filter(() => next() % 3 === 0),
        ),
      };
const fuzz = Array.from({ length: 400 }, () => {
  const lines = Array.from({ length: 1 + (next() % 24) }, fuzzLine);
  const gcode = lines.join(next() % 4 ? "\n" : "\r\n") + (next() % 2 ? "\n" : "");
  const options = capOptions();
  return { gcode: units(gcode), options: { limits: options.limits ?? {} }, expected: summary(parseRichGcodeModel(gcode, options)) };
});

const sources = [
  "tools/cross-platform/gcode-oracle-vectors.mjs",
  "web/src/slicer/RichGcodeModel.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
      engine: { node: process.versions.node },
      oracle,
      fuzz,
      utf8,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/gcode-oracle-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "G-code oracle drift");
console.log(
  `G-code oracle: ${oracle.length} hand-written cases (${oracle.reduce((n, c) => n + c.expected.warnings.length, 0)} warnings, ${oracle.reduce((n, c) => n + c.expected.records.length, 0)} records) met by the browser; ${fuzz.length} fuzzed documents (${fuzz.reduce((n, c) => n + c.expected.warnings.length, 0)} warnings, ${fuzz.filter((c) => !c.expected.complete).length} terminated); ${utf8.length} UTF-8 decodes`,
);
