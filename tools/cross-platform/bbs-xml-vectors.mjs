// Production BBS UTF-16/XML escaping references, including invalid XML input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  xmlAttribute,
  xmlText,
} from "../../web/src/project/serialization/bbsXml.ts";
const root = new URL("../../", import.meta.url);
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const project = (units) => {
  const text = String.fromCharCode(...units);
  try {
    return { attribute: xmlAttribute(text), text: xmlText(text) };
  } catch {
    return { error: true };
  }
};
const cases = [];
const add = (units) => cases.push({ units, ...project(units) });
add([]);
add(
  [...`ampersand& quote" apostrophe' <tag> > \t\n\r`].map((c) =>
    c.charCodeAt(0),
  ),
);
for (let n = 0; n < 256; n++) add([n]);
for (const n of [
  0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xfffe, 0xffff,
]) {
  add([n]);
  add([65, n, 66]);
  add([n, 0xd800]);
  add([0xdfff, n]);
}
for (const a of [0xd800, 0xdabc, 0xdbff])
  for (const b of [0xdc00, 0xddab, 0xdfff]) {
    add([a, b]);
    add([a, b, a]);
    add([b, a, b]);
  }
const text = "&😀<α>\t\n\r'\"".repeat(1000);
add(Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)));
const digest = createHash("sha256");
let accepted = 0,
  refused = 0;
for (let point = 0; point <= 0x10ffff; point++) {
  const str = String.fromCodePoint(point),
    units = Array.from({ length: str.length }, (_, i) => str.charCodeAt(i));
  const value = project(units);
  if (value.error) {
    digest.update(`${point} ERROR\n`);
    refused++;
  } else {
    digest.update(`${point} ${value.attribute} ${value.text}\n`);
    accepted++;
  }
}
const sources = ["web/src/project/serialization/bbsXml.ts"];
const value = {
  version: 1,
  sources: Object.fromEntries(
    sources.map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(new URL(p, root)))
        .digest("hex"),
    ]),
  ),
  cases,
  scan: { accepted, refused, sha256: digest.digest("hex") },
};
const output = JSON.stringify(value, null, 2) + "\n",
  path = new URL("testdata/cross-platform/bbs-xml-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "BBS XML references are stale",
  );
console.log(
  `BBS XML: ${cases.length} cases, ${accepted} accepted and ${refused} refused single code points`,
);
