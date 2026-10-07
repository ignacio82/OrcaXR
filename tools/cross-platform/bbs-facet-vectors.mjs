// Independent BBS paint-wire and sparse-import references from production TS.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  decodeBbsFacetRoot,
  encodeBbsFacetRoot,
} from "../../web/src/project/serialization/bbsFacetCodec.ts";
import { collapseFacetRefinementRoots } from "../../web/src/project/domain/facetRefinement.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
const root = new URL("../../", import.meta.url);
assert.ok(process.argv.slice(2).every((arg) => arg === "--write"));
const table = Array.from({ length: 256 }, (_, n) =>
  n === 0 ? null : `slot:${n}`,
);
table[1] = "import:filament:\udfff\0";
table[2] = "import:filament:𐀀";
table[3] = "import:filament:\ue000";
const values = (profile) =>
  profile === "support"
    ? [null, "enforce", "block"]
    : profile === "seam"
      ? [null, "prefer", "avoid"]
      : profile === "fuzzySkin"
        ? [null, true]
        : profile === "color"
          ? table.slice(0, 65)
          : table;
const errorCode = (e) => {
  for (const [pattern, code] of [
    ["uppercase hex", "Hex"],
    ["encoded size", "EncodedSize"],
    ["node limit", "NodeLimit"],
    ["depth limit", "DepthLimit"],
    ["truncated", "Truncated"],
    ["special side", "Split"],
    ["invalid split", "Split"],
    ["state", "State"],
    ["trailing", "Trailing"],
  ])
    if (e.message.includes(pattern)) return code;
  throw e;
};
const cases = [];
function evaluate(encoded, profile, budget) {
  const visits = [],
    map = values(profile);
  let node, error;
  try {
    node = decodeBbsFacetRoot(
      encoded,
      (n) => {
        visits.push(n);
        return map[n] ?? undefined;
      },
      budget,
    );
  } catch (e) {
    error = errorCode(e);
  }
  const result = {
    remaining: budget.remainingNodes,
    visits,
    ...(error ? { error } : { nodeJson: canonicalStringify(node) }),
  };
  if (node) {
    const encodeVisits = [];
    result.encoded = encodeBbsFacetRoot(node, (v) => {
      const n = map.indexOf(v);
      encodeVisits.push(n);
      return n;
    });
    result.encodeVisits = encodeVisits;
  }
  return result;
}
function add(
  encoded,
  profile = "all",
  remaining = 1_000_000,
  name = `case-${cases.length}`,
) {
  cases.push({
    name,
    encoded,
    profile,
    initialNodes: remaining,
    ...evaluate(encoded, profile, { remainingNodes: remaining }),
  });
}
const leaf = (n) =>
  n === 0
    ? { kind: "leaf", state: { kind: "unpainted" } }
    : { kind: "leaf", state: { kind: "assigned", value: table[n] } };
const encode = (node) => encodeBbsFacetRoot(node, (v) => table.indexOf(v));
for (const profile of ["all", "color", "support", "seam", "fuzzySkin"])
  for (let n = 0; n < 256; n++)
    add(encode(leaf(n)), profile, 1_000_000, `${profile}-state-${n}`);
for (let sides = 1; sides <= 3; sides++)
  for (let special = 0; special <= (sides === 3 ? 0 : 2); special++)
    add(
      encode({
        kind: "split",
        splitSides: sides,
        specialSide: special,
        children: Array.from({ length: sides + 1 }, (_, i) =>
          leaf([255, 18, 1, 0][i]),
        ),
      }),
    );
let seed = 0x6b627366;
function random(n) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % n;
}
function tree(depth) {
  if (depth === 0 || random(5) < 3) return leaf(random(256));
  const sides = 1 + random(3);
  return {
    kind: "split",
    splitSides: sides,
    specialSide: sides === 3 ? 0 : random(3),
    children: Array.from({ length: sides + 1 }, () => tree(depth - 1)),
  };
}
for (let i = 0; i < 256; i++) add(encode(tree(7)), "all");
for (const text of [
  "",
  "a",
  "G",
  " 4",
  "4\n",
  "💫",
  "C",
  "FC",
  "F".repeat(18) + "C",
  "DFFFFFFFFFFFFFFFFC",
  "44",
  "3",
  "44D",
  "44447",
  "000B",
  "000F",
  "4C",
])
  add(text);
for (const depth of [63, 64, 65, 66])
  add("0".repeat(depth + 1) + "1".repeat(depth));
for (const nodes of [0, 1, 2, 3, 4, 10])
  for (const text of ["0", "4", "841", "0480C3", "F".repeat(18) + "C"])
    add(text, "all", nodes);
const sequences = [];
for (const initialNodes of [0, 1, 2, 3, 10]) {
  const budget = { remainingNodes: initialNodes };
  const steps = [];
  for (const encoded of [
    "0",
    "841",
    "4",
    "0FC",
    "44",
    "C",
    "000000000000000000000000000000",
  ])
    steps.push({ encoded, ...evaluate(encoded, "all", budget) });
  sequences.push({ initialNodes, profile: "all", steps });
}
const exhaustiveHash = createHash("sha256"),
  counts = {};
let exhaustiveCases = 0;
for (let length = 1; length <= 4; length++)
  for (let n = 0; n < 16 ** length; n++) {
    const encoded = n.toString(16).toUpperCase().padStart(length, "0");
    const row = evaluate(encoded, "all", { remainingNodes: 16 });
    const outcome = row.error ?? row.nodeJson;
    exhaustiveHash.update(
      `${encoded}|${row.remaining}|${outcome}|${row.visits.join(",")}\n`,
    );
    counts[row.error ?? "accepted"] =
      (counts[row.error ?? "accepted"] ?? 0) + 1;
    exhaustiveCases++;
  }
const sparse = [];
for (const profile of ["color", "support", "seam", "fuzzySkin"])
  for (const triangleCount of [10, 2_000_000]) {
    const encoded = ["0", "441", "841", "0482"];
    if (profile === "fuzzySkin") encoded.splice(2, 2, "041", "0402");
    const indices = [0, 2, triangleCount - 2, triangleCount - 1];
    const roots = Array(triangleCount).fill(leaf(0));
    const budget = { remainingNodes: 100 };
    const entries = encoded.map((text, i) => {
      roots[indices[i]] = decodeBbsFacetRoot(
        text,
        (n) => values(profile)[n] ?? undefined,
        budget,
      );
      return { triangle: indices[i], encoded: text };
    });
    const result = collapseFacetRefinementRoots(roots);
    sparse.push({
      profile,
      triangleCount,
      entries,
      remaining: budget.remainingNodes,
      expectedJson: canonicalStringify(result),
    });
  }
const sources = [
  "tools/cross-platform/bbs-facet-vectors.mjs",
  "web/src/project/serialization/bbsFacetCodec.ts",
  "web/src/project/domain/facetRefinement.ts",
  "web/src/project/domain/model.ts",
  "web/src/project/domain/canonical.ts",
];
const data = {
  schemaVersion: 1,
  table: table.map((v) =>
    typeof v === "string"
      ? Array.from({ length: v.length }, (_, i) => v.charCodeAt(i))
      : v,
  ),
  sources: sources.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex"),
  })),
  cases,
  sequences,
  sparse,
  exhaustive: {
    cases: exhaustiveCases,
    sha256: exhaustiveHash.digest("hex"),
    counts,
  },
};
const path = new URL("testdata/cross-platform/bbs-facet-vectors.json", root),
  text = JSON.stringify(data, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(path, text);
else
  assert.equal(
    readFileSync(path, "utf8"),
    text,
    "BBS facet references drifted",
  );
console.log(
  `BBS facet references: ${cases.length} cases, ${sequences.length} budget sequences, ${sparse.length} sparse imports, ${exhaustiveCases} exhaustive streams`,
);
