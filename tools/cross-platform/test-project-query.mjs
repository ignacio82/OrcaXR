import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROJECT_QUERY as schema,
  decodeProjectQueryMetadata as metadata,
  decodeProjectQueryPage as page,
} from "../../contracts/generated/project-query.ts";
import { startProjectJni } from "./project-jni-bridge.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../testdata/cross-platform/project-query-vectors.json",
      import.meta.url,
    ),
  ),
);
const jvm = process.argv.includes("--jni") ? startProjectJni() : undefined;
const positive = (packet, paged = false) => {
  const input = Float64Array.from(packet);
  const result = (paged ? page : metadata)(input);
  if (jvm) assert.deepEqual(jvm.call("queryCodec", input, paged), input);
  input.fill(-9);
  assert.deepEqual(
    result,
    (paged ? page : metadata)(Float64Array.from(packet)),
  );
  return result;
};
let checks = 0,
  refusals = 0;
const invalid = (packet, paged = false) => {
  const input = Float64Array.from(packet);
  assert.throws(() => (paged ? page : metadata)(input));
  if (jvm) assert.throws(() => jvm.call("queryCodec", input, paged));
  refusals++;
};
try {
  const unique = new Map();
  for (const c of fixture.cases)
    for (const node of c.nodes) {
      const decoded = positive(node.packet);
      assert.equal(decoded.kind, node.kind);
      assert.deepEqual(decoded.values, node.values);
      checks++;
      unique.set(JSON.stringify(node.packet), node.packet);
    }
  for (const packet of unique.values()) {
    invalid(packet.slice(0, -1));
    invalid([...packet, 0, 0]);
    invalid([2, ...packet.slice(1)]);
    invalid([1, 99, ...packet.slice(2)]);
    if (packet.length > 2) {
      invalid([
        ...packet.slice(0, 2),
        ...packet.slice(4),
        ...packet.slice(2, 4),
      ]);
      for (const value of [NaN, Infinity, -Infinity]) {
        const copy = packet.slice();
        copy[3] = value;
        invalid(copy);
      }
    }
    for (let i = 2; i < packet.length; i += 2) {
      const field = Object.keys(schema.numbers)[packet[i]],
        rule = schema.numbers[field];
      const invalidValues = Array.isArray(rule)
        ? [-1, 0.5, rule.length]
        : rule === "index"
          ? [-1, 0.5, schema.maxIndex + 1]
          : rule === "integer"
            ? [-1, 0.5]
            : rule === "boolean"
              ? [-1, 0.5, 2]
              : rule === "componentCount"
                ? [0, 0.5, 5]
                : [];
      for (const value of invalidValues) {
        const copy = packet.slice();
        copy[i + 1] = value;
        invalid(copy);
      }
    }
  }
  const sample = fixture.cases[0].nodes[0].packet;
  const fields = Object.keys(schema.numbers);
  const assetKind = Object.keys(schema.nodes).indexOf("asset");
  const asset = [...unique.values()].find(
    (p) =>
      p[1] === assetKind &&
      p.some(
        (n, i) => i >= 2 && i % 2 === 0 && n === fields.indexOf("indicesCount"),
      ),
  );
  assert.ok(asset);
  for (const name of [
    "triangleCount",
    "positionsOffset",
    "positionsLength",
    "positionsType",
    "positionsComponents",
    "positionsCount",
    "indicesOffset",
    "indicesLength",
    "indicesType",
    "indicesComponents",
    "indicesCount",
  ]) {
    const at = asset.findIndex(
      (v, i) => i >= 2 && i % 2 === 0 && v === fields.indexOf(name),
    );
    assert.ok(at >= 2);
    invalid([...asset.slice(0, at), ...asset.slice(at + 2)]);
  }
  const baseAsset = [
    1,
    assetKind,
    fields.indexOf("assetKind"),
    0,
    fields.indexOf("byteLength"),
    36,
  ];
  positive(baseAsset);
  for (const name of ["positionsStride", "indicesStride"])
    invalid([...baseAsset, fields.indexOf(name), 4]);
  const wrongKind = asset.slice();
  wrongKind[
    wrongKind.findIndex(
      (v, i) => i >= 2 && i % 2 === 0 && v === fields.indexOf("assetKind"),
    ) + 1
  ] = 1;
  invalid(wrongKind);
  const full = [schema.version, 70, 5, 64];
  for (let i = 0; i < 64; i++) full.push(sample.length, ...sample);
  assert.equal(positive(full, true).rows.length, 64);
  assert.equal(positive([1, 0, 0, 0], true).rows.length, 0);
  for (const p of [
    [1, 0, 1, 0],
    [1, 0, 0, 1],
    [1, 1, 0, 65],
    [1, 1, 0, 1, 999999],
    full.slice(0, -1),
    [...full, 0],
    [2, ...full.slice(1)],
  ])
    invalid(p, true);
  const mixed = [1, 2, 0, 2, sample.length, ...sample];
  const other = fixture.cases[0].nodes.find((n) => n.kind !== "project").packet;
  mixed.push(other.length, ...other);
  invalid(mixed, true);
  assert.throws(() => metadata([1, 0]));
  assert.throws(() => page([1, 0, 0, 0]));
  console.log(
    JSON.stringify({
      queryCodecChecks: checks,
      queryCodecRefusals: refusals,
      kotlin: !!jvm,
    }),
  );
} finally {
  await jvm?.close();
}
