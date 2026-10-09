// Printer directory references from the production browser
// (`PrinterDirectoryExchange.ts` over `PrinterDirectory.ts`): how stored
// directories of every shape load (corrupt, partial, repeated ids, too many
// printers, stale defaults, long and broken text), how directories save, and
// what every edit makes of them — adds under every spelling of an address,
// invalid names, hosts and ports, the limit, updates of each field, removals,
// defaults and legacy adoption — along seeded edit sequences. Replayed by
// Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerDirectoryAdd,
  answerDirectoryAdopt,
  answerDirectoryLoad,
  answerDirectoryRemove,
  answerDirectorySave,
  answerDirectorySetDefault,
  answerDirectoryUpdate,
} from "../../web/src/printer/PrinterDirectoryExchange.ts";
import {
  encodeProjectPrinterDirectory,
  encodeProjectPrinterDirectoryAdd,
  encodeProjectPrinterDirectoryAdopt,
  encodeProjectPrinterDirectoryReply,
  encodeProjectPrinterDirectorySelect,
  encodeProjectPrinterDirectoryUpdate,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const finite = (value) => (value === undefined ? absent : { value });
const text = (value) =>
  value === undefined ? absent : { value: units(value) };

// Seeded, so the corpus is the same every run.
let seed = 0xd1e;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

const hosts = [
  "printer.local",
  "Printer.local",
  "http://printer.local:7125",
  "printer.local:7125",
  "http://PRINTER.LOCAL/",
  "printer.local:8080",
  "http://printer.local:7125/two",
  "192.168.1.228",
  "http://192.168.1.228",
  "  192.168.1.51  ",
  "fd00::1:5",
  "[fd00::1:5]:7125",
  "https://printer.example",
  "printer local",
  "http://",
  "ftp://printer.local",
  "http://user:pw@printer.local",
  "printer.local?x=1",
  "",
  "   ",
  `${"h".repeat(2047)}😀`,
  "x\uD800y",
];
const names = [
  "Snapmaker U1",
  "  Centauri  ",
  "",
  "   ",
  `${"a".repeat(63)}😀`,
  `${"b".repeat(70)}`,
  "😀".repeat(40),
  "x\uD800",
];
const ports = [undefined, 7125, 80, 7126, 8080, 0, 65535, 65536, 1.5, -1];

const adds = [];
const updates = [];
const removes = [];
const defaults = [];
const adopts = [];
const saves = [];
const directories = [];
let next = 0;
const id = () => `printer-${++next}`;

function record(list, encode, request, reply) {
  list.push({ requestJson: encode(request), replyJson: reply });
}
const empty = { printers: [], defaultId: units("") };
for (let run = 0; run < 24; run++) {
  let directory = empty;
  for (let step = 0; step < 12; step++) {
    const kind = pick(["add", "add", "add", "update", "remove", "default"]);
    const ids = directory.printers.map((entry) => entry.id);
    const target =
      ids.length > 0 && random() < 0.9 ? pick(ids) : units("missing");
    let reply;
    if (kind === "add") {
      const request = {
        directory,
        name: units(pick(names)),
        host: units(pick(hosts)),
        port: finite(pick(ports)),
        id: units(id()),
      };
      reply = answerDirectoryAdd(request);
      record(
        adds,
        encodeProjectPrinterDirectoryAdd,
        request,
        encodeProjectPrinterDirectoryReply(reply),
      );
    } else if (kind === "update") {
      const request = {
        directory,
        id: target,
        name: random() < 0.3 ? text(pick(names)) : absent,
        host: random() < 0.4 ? text(pick(hosts)) : absent,
        port: random() < 0.3 ? finite(pick(ports.slice(1))) : absent,
        capabilities:
          random() < 0.3
            ? {
                value: Array.from({ length: pick([0, 1, 3, 40]) }, (_, i) =>
                  units(`cap-${i}`),
                ),
              }
            : absent,
        toolCount:
          random() < 0.3 ? finite(pick([1, 4, 0, -1, 1.5, 2 ** 53])) : absent,
      };
      reply = answerDirectoryUpdate(request);
      record(
        updates,
        encodeProjectPrinterDirectoryUpdate,
        request,
        encodeProjectPrinterDirectoryReply(reply),
      );
    } else {
      const request = { directory, id: target };
      const answer =
        kind === "remove" ? answerDirectoryRemove : answerDirectorySetDefault;
      reply = answer(request);
      record(
        kind === "remove" ? removes : defaults,
        encodeProjectPrinterDirectorySelect,
        request,
        encodeProjectPrinterDirectoryReply(reply),
      );
    }
    if ("directory" in reply) directory = reply.directory;
  }
  directories.push(directory);
}
// The limit: a seventeenth printer.
{
  let directory = empty;
  for (let i = 0; i < 17; i++) {
    const request = {
      directory,
      name: units(`P${i}`),
      host: units(`10.0.0.${i + 1}`),
      port: absent,
      id: units(id()),
    };
    const reply = answerDirectoryAdd(request);
    record(
      adds,
      encodeProjectPrinterDirectoryAdd,
      request,
      encodeProjectPrinterDirectoryReply(reply),
    );
    if ("directory" in reply) directory = reply.directory;
  }
  directories.push(directory);
}
for (const directory of directories)
  saves.push({
    requestJson: encodeProjectPrinterDirectory(directory),
    stored: answerDirectorySave(directory),
  });
for (const directory of [empty, directories[0], directories[1]])
  for (const legacy of [
    undefined,
    { host: "http://192.168.1.228", port: 7125 },
    { host: "  ", port: 7125 },
    { host: "printer local", port: 7125 },
    { host: "printer.local", port: 0 },
  ]) {
    const request = {
      directory,
      legacy:
        legacy === undefined
          ? absent
          : { value: { host: units(legacy.host), port: legacy.port } },
      id: units(id()),
    };
    adopts.push({
      requestJson: encodeProjectPrinterDirectoryAdopt(request),
      replyJson: encodeProjectPrinterDirectory(answerDirectoryAdopt(request)),
    });
  }

const storedTexts = [
  null,
  "",
  "not json",
  "null",
  "[]",
  '"text"',
  '{"printers":"no"}',
  '{"printers":[{"name":"nameless"}]}',
  JSON.stringify({
    printers: [
      { id: "a", name: "First", host: "http://10.0.0.5", port: 7125 },
      { id: "a", name: "Second", host: "http://10.0.0.6", port: 7125 },
      { id: "b", name: "  Third  ", host: "  10.0.0.7  ", port: "7125" },
      { id: "", name: "Blank id", host: "10.0.0.8" },
      { id: "c", name: "   ", host: "10.0.0.9" },
      { id: "d", name: "No host", host: "   " },
      { id: "e", name: "Ports", host: "10.0.0.10", port: 1.5 },
      { id: "f", name: "Caps", host: "x", capabilities: ["a", 3, "b", null] },
      { id: "g", name: "Tools", host: "y", toolCount: 0 },
      { id: "h", name: "Tools", host: "z", toolCount: 2.5 },
      { id: "i", name: "Tools", host: "w", toolCount: 3 },
      { id: "j", name: `${"a".repeat(63)}😀`, host: `${"h".repeat(2047)}😀` },
      { id: "k", name: "x\uD800", host: "h\uDC00" },
      null,
      "entry",
    ],
    defaultId: "gone",
  }),
  JSON.stringify({
    printers: Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      host: `10.0.1.${i}`,
      port: 7125,
      capabilities: Array.from({ length: 40 }, (_, j) => `c${j}`),
    })),
    defaultId: "p19",
  }),
  '{"printers":[{"id":"a","name":"A","host":"h"}],"defaultId":7}',
  '{"printers":[{"id":"a","name":"A","host":"h","id":"b"}],"defaultId":"b"}',
  ...saves.map((save) => save.stored),
];
const loads = storedTexts.map((stored) => ({
  stored,
  replyJson: encodeProjectPrinterDirectory(answerDirectoryLoad(stored)),
}));

const sources = [
  "tools/cross-platform/printer-directory-vectors.mjs",
  "web/src/printer/PrinterDirectoryExchange.ts",
  "web/src/printer/PrinterDirectory.ts",
  "web/src/printer/MoonrakerEndpoint.ts",
  "web/src/printer/PrinterWire.ts",
];
const corpus = { loads, saves, adds, updates, removes, defaults, adopts };
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
  "testdata/cross-platform/printer-directory-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer directory reference drift",
  );
console.log(
  `Printer directory references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
