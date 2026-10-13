// File → Export Diagnostics… references from the production browser
// (`DiagnosticsBundle.ts` through `diagnosticsExchange.ts`): bundles built
// from facts as the browser shell gathers them and from adversarial ones —
// every optional section present and absent, URLs, credential assignments,
// controls and surrogates in every string, more than 200 log entries, more
// than 32 printer capabilities and 64 object names, names past 120 units,
// numbers in exponent form — each request's file, privacy preview and kept
// entries; malformed requests; recorded events with and without secrets
// (short ones ignored), scopes past 64 units and messages past 512; and the
// catalogue's counts and the pinned engine build a bundle states. The shared
// core answers the same (Rust, WASM in Node and Chrome, and JNI).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildRegistry } from "../../web/src/actions/catalog.ts";
import {
  diagnosticEntryExchange,
  diagnosticsBundleExchange,
  diagnosticsFactsExchange,
} from "../../web/src/diagnostics/diagnosticsExchange.ts";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { PINNED_ENGINE_PROVENANCE } from "../../web/src/slicer/pinnedEngineProvenance.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const json = canonicalStringify;

const facts = diagnosticsFactsExchange(buildRegistry().all(), PINNED_ENGINE_PROVENANCE.commit);
const catalogue = JSON.parse(facts);

// --- Recorded events ------------------------------------------------------------------------

const long = (n, unit = "x") => unit.repeat(n);
const entryCases = [
  { atMs: 0, level: "info", scope: "window", message: "Ready.", secrets: [] },
  { atMs: 12, level: "error", scope: "promise", message: "TypeError: x is undefined", secrets: [] },
  { atMs: 1.5, level: "warning", scope: "slicer", message: "GET https://slicer.local:8080/api?token=abc failed", secrets: [] },
  { atMs: 99, level: "error", scope: "printer", message: "Authorization: Bearer abcdefgh12345 refused; api_key=SECRET1234", secrets: [] },
  { atMs: 7, level: "error", scope: "printer", message: "key SECRETKEY99 and short abc and SECRETKEY99 again", secrets: ["SECRETKEY99", "abc", ""] },
  { atMs: 7, level: "error", scope: "printer", message: "tokens T0KEN-1234 then T0KEN-12345", secrets: ["T0KEN-12345", "T0KEN-1234"] },
  { atMs: 3, level: "info", scope: long(80, "s"), message: long(600), secrets: [] },
  { atMs: 3, level: "info", scope: "edge", message: long(505) + "SECRETXYZ", secrets: ["SECRETXYZ"] },
  { atMs: 4, level: "error", scope: "controls", message: "a\u0000\u0001b\nc\r\n\td\u007fe", secrets: [] },
  { atMs: 5, level: "info", scope: "🐳 漢字 \ud800", message: "emoji 🐳 lone \udfff ws://h/p wss://h", secrets: [] },
  { atMs: 1e21, level: "info", scope: "time", message: "x-api-key: zz access_token = qq", secrets: [] },
];
const entries = entryCases.map((c) => {
  const requestJson = json(c);
  const replyJson = diagnosticEntryExchange(requestJson);
  assert.ok(replyJson, requestJson);
  return { requestJson, replyJson };
});
const entryRefusals = [
  json({ atMs: 0, level: "debug", scope: "s", message: "m", secrets: [] }),
  json({ atMs: 0, level: "info", scope: "s", message: "m" }),
  json({ atMs: "0", level: "info", scope: "s", message: "m", secrets: [] }),
  json({ atMs: 0, level: "info", scope: "s", message: "m", secrets: [1] }),
  json({ atMs: 0, level: "info", scope: "s", message: "m", secrets: [], data: 1 }),
  "[]",
  "{",
];
for (const r of entryRefusals) assert.equal(diagnosticEntryExchange(r), null, r);

// --- Bundles --------------------------------------------------------------------------------

const browserFacts = (overrides = {}) => ({
  appVersion: "0.9.4",
  engine: { commit: PINNED_ENGINE_PROVENANCE.commit, route: "browser-wasm" },
  browser: {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    language: "en-US",
    hardwareConcurrency: 8,
    crossOriginIsolated: true,
  },
  printer: { configured: true, connected: false },
  capabilities: { actionCount: catalogue.actionCount, unavailableCount: catalogue.unavailableCount },
  project: {
    plateCount: 2,
    objectCount: 3,
    volumeCount: 4,
    triangleCount: 1268,
    physicalFilamentCount: 4,
    mixedFilamentCount: 1,
    paintedVolumeCount: 1,
    objectNames: ["cube.stl", "Benchy https://example.com/model", "cylinder"],
  },
  log: [
    JSON.parse(entries[1].replyJson),
    JSON.parse(entries[3].replyJson),
  ],
  ...overrides,
});
const manyEntries = Array.from({ length: 250 }, (_, i) => ({
  atMs: i * 17,
  level: ["info", "warning", "error"][i % 3],
  scope: `scope-${i}`,
  message: i % 5 === 0 ? `fetch https://host-${i}.lan/x failed` : `event ${i} \u0007 bell`,
}));
const names = Array.from({ length: 70 }, (_, i) =>
  i === 0 ? long(119) + "🐳" : i === 1 ? long(130, "n") : i === 2 ? "a\nb http://x" : i === 3 ? "lone \ud800 name" : `Part ${i}`,
);
const bundleCases = [
  ["browser shell", browserFacts(), false],
  ["browser shell with names", browserFacts(), true],
  [
    "minimal",
    {
      appVersion: "unknown",
      engine: { commit: "abc", route: "external-server" },
      browser: { userAgent: "", language: "" },
      capabilities: { actionCount: 0, unavailableCount: 0 },
      log: [],
    },
    false,
  ],
  [
    "every section",
    browserFacts({
      engine: { commit: "https://evil.example/commit", route: "external-server", externalAttested: true },
      browser: {
        userAgent: "UA bearer: abcdef access_token=zzz \u0000\u001f end",
        language: "pt-BR",
        hardwareConcurrency: 16,
        deviceMemoryGb: 0.5,
        crossOriginIsolated: false,
      },
      xr: { supported: true, sessionActive: false },
      printer: {
        configured: true,
        connected: true,
        capabilities: Array.from({ length: 40 }, (_, i) => (i === 3 ? "webcam http://10.0.0.5/stream" : `cap-${i}`)),
        jobState: "printing",
      },
      capabilities: { actionCount: 312, unavailableCount: 17 },
      performance: { usedHeapMb: 0.1 + 0.2, totalHeapMb: 1e21, uptimeSeconds: 5e-7 },
    }),
    false,
  ],
  ["many entries, names", browserFacts({ log: manyEntries, project: { ...browserFacts().project, objectNames: names } }), true],
  ["many entries, no names", browserFacts({ log: manyEntries, project: { ...browserFacts().project, objectNames: names } }), false],
  ["offline printer, no project", browserFacts({ project: undefined, printer: { configured: false, connected: false } }), false],
  [
    "numbers",
    browserFacts({
      capabilities: { actionCount: 1.5, unavailableCount: -3 },
      project: {
        plateCount: 0,
        objectCount: 0,
        volumeCount: 0,
        triangleCount: 123456789012,
        physicalFilamentCount: 0,
        mixedFilamentCount: 0,
        paintedVolumeCount: 0,
        objectNames: [],
      },
    }),
    true,
  ],
  ["unicode", browserFacts({ appVersion: "1.0 🐳 \udc00", log: [JSON.parse(entries[9].replyJson)] }), true],
  // The facts an Android host gathers (`Diagnostics.Input`): no browser-only ones.
  ...[true, false].map((names) => [
    `android host${names ? ", names" : ""}`,
    {
      appVersion: "0.1.0-dev",
      engine: { commit: PINNED_ENGINE_PROVENANCE.commit, route: "android-native", externalAttested: true },
      browser: { userAgent: "OrcaXR Android 0.1.0-dev (Android 14; API 34)", language: "en-US", hardwareConcurrency: 8 },
      printer: { configured: true, connected: true, jobState: "printing" },
      capabilities: { actionCount: catalogue.actionCount, unavailableCount: catalogue.unavailableCount },
      project: { ...browserFacts().project, objectNames: ["cube.stl", "Part https://x.y/z", "naïve 🐳"] },
      log: entries.slice(0, 6).map((e) => JSON.parse(e.replyJson)).filter((e) => Number.isInteger(e.atMs)),
    },
    names,
  ]),
  [
    "android host, bare",
    {
      appVersion: "0.1.0-dev",
      engine: { commit: PINNED_ENGINE_PROVENANCE.commit, route: "external-server" },
      browser: { userAgent: "OrcaXR Android", language: "fr-FR" },
      capabilities: { actionCount: catalogue.actionCount, unavailableCount: catalogue.unavailableCount },
      log: [],
    },
    false,
  ],
];
const bundles = bundleCases.map(([name, input, includeModelNames]) => {
  const clean = JSON.parse(JSON.stringify(input));
  const requestJson = json({ includeModelNames, input: clean });
  const replyJson = diagnosticsBundleExchange(requestJson);
  assert.ok(replyJson, name);
  const reply = JSON.parse(replyJson);
  return reply.file.length <= 16384
    ? { name, requestJson, replyJson }
    : { name, requestJson, description: reply.description, logEntries: reply.logEntries, sha256: digest(reply.file), bytes: Buffer.byteLength(reply.file) };
});
const base = JSON.parse(JSON.stringify(browserFacts()));
const without = (key) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
const bundleRefusals = [
  json({ includeModelNames: false, input: { ...base, extra: 1 } }),
  json({ includeModelNames: false, input: without("engine") }),
  json({ includeModelNames: false, input: without("log") }),
  json({ includeModelNames: false, input: { ...base, engine: { commit: "x" } } }),
  json({ includeModelNames: false, input: { ...base, engine: { commit: "x", route: "r", extra: true } } }),
  json({ includeModelNames: false, input: { ...base, capabilities: { actionCount: "1", unavailableCount: 0 } } }),
  json({ includeModelNames: false, input: { ...base, xr: { supported: true } } }),
  json({ includeModelNames: false, input: { ...base, printer: { configured: true, connected: true, capabilities: [1] } } }),
  json({ includeModelNames: false, input: { ...base, project: Object.fromEntries(Object.entries(base.project).filter(([k]) => k !== "objectNames")) } }),
  json({ includeModelNames: false, input: { ...base, log: [{ atMs: 0, level: "fatal", scope: "s", message: "m" }] } }),
  json({ includeModelNames: false, input: { ...base, log: [{ atMs: 0, level: "info", scope: "s", message: "m", data: {} }] } }),
  json({ includeModelNames: "yes", input: base }),
  json({ includeModelNames: false, input: base, extra: 1 }),
  json({ input: base }),
  "not json",
];
for (const r of bundleRefusals) assert.equal(diagnosticsBundleExchange(r), null, r);

const sources = [
  "tools/cross-platform/diagnostics-vectors.mjs",
  "web/src/diagnostics/DiagnosticsBundle.ts",
  "web/src/diagnostics/diagnosticsExchange.ts",
  "web/src/printer/SessionCredentials.ts",
  "web/src/actions/catalog.ts",
  "web/src/slicer/pinnedEngineProvenance.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({ path, sha256: digest(read(path)) })),
      factsJson: facts,
      entries,
      entryRefusals,
      bundles,
      bundleRefusals,
    },
    null,
    2,
  ) + "\n";
const target = new URL("testdata/cross-platform/diagnostics-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "Diagnostics reference drift");
console.log(
  `diagnostics: ${bundles.length} bundles, ${bundleRefusals.length} refused; ` +
    `${entries.length} entries, ${entryRefusals.length} refused; facts ${facts}`,
);
