// Slice sidecar references from the production browser (`SliceSidecarExchange.ts`):
// the effective profile snapshot each plate is sliced with
// (`CanonicalStateProfileResolver`, over every plate of the project model
// corpus and variants with explicit, legacy and blank profile hashes, padded
// preset IDs, process IDs of every shape and mixed filaments enabled and
// disabled), the external route's metadata (`CanonicalSlicerClientRoute`,
// over the external slicer corpus's endpoints and engines of every shape),
// and the output binding every statistics sidecar carries
// (`validateGcodeStatisticsBinding`, a valid binding and each field broken in
// turn). Replayed by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  sliceBindingExchange,
  sliceProfilesExchange,
  sliceRouteExchange,
} from "../../web/src/slicer/SliceSidecarExchange.ts";
import { validateProjectState } from "../../web/src/project/domain/validation.ts";
import { PINNED_ENGINE_PROVENANCE } from "../../web/src/slicer/pinnedEngineProvenance.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const write = process.argv.includes("--write");
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

// --- Profiles -----------------------------------------------------------------------------------
const model = JSON.parse(read("testdata/cross-platform/project-model-vectors.json"));
const states = [
  ...model.factories.map((factory) => [`factory:${factory.seed}`, JSON.parse(factory.stateJson)]),
  ...model.cases.map((each) => [`case:${each.name}`, JSON.parse(each.stateJson)]),
];
const rich = () => structuredClone(states.find(([name]) => name === "case:complete-schema-with-unknowns")[1]);
const variants = [];
{
  const explicit = rich();
  explicit.printer.profileHash = sha("printer");
  explicit.filaments.physical.forEach((f, i) => (f.presetHash = sha(`filament-${i}`)));
  variants.push(["explicit canonical hashes", explicit]);
  const legacy = rich();
  legacy.printer.profileHash = "  md5:0123abcd  ";
  legacy.filaments.physical.forEach((f) => (f.presetHash = ` ${sha("padded")} `));
  variants.push(["legacy and padded hashes", legacy]);
  const blank = rich();
  blank.printer.profileHash = "   ";
  blank.printer.profileId = "   ";
  blank.filaments.physical.forEach((f) => (f.presetId = "  "));
  variants.push(["blank profile identities", blank]);
  const padded = rich();
  padded.printer.profileId = "  Snapmaker U1 (0.4 nozzle)  ";
  padded.filaments.physical.forEach((f, i) => (f.presetId = ` Preset ${i} `));
  variants.push(["padded profile identities", padded]);
  for (const [name, value] of [
    ["process name", "0.20mm Standard @Snapmaker U1"],
    ["padded process name", "  0.12mm Fine  "],
    ["blank process name", "   "],
    ["numeric process name", 7],
    ["list process name", ["a"]],
    ["unicode process name", "Prozess é\u{10000}"],
  ]) {
    const process = rich();
    process.config.print_settings_id = value;
    variants.push([name, process]);
  }
  const mixed = rich();
  mixed.filaments.mixed.forEach((f) => (f.enabled = !f.enabled));
  variants.push(["mixed filaments toggled", mixed]);
  const noMixed = rich();
  noMixed.filaments.mixed.forEach((f) => (f.enabled = false));
  variants.push(["mixed filaments disabled", noMixed]);
}
const profiles = [];
for (const [name, state] of [...states, ...variants]) {
  if (validateProjectState(state).some((issue) => issue.severity === "error")) continue;
  const stateJson = JSON.stringify(state);
  for (const plateId of [...state.plates.map((plate) => plate.id), "import:plate:unknown"]) {
    const request = JSON.stringify({ plateId, stateJson });
    // Names spell identities as JSON does, so a lone surrogate stays readable to every replay.
    profiles.push({ name: `${name} ${JSON.stringify(plateId)}`, request, reply: await sliceProfilesExchange(request) });
  }
}
assert.ok(profiles.some((p) => p.reply.includes('"error"')));
assert.ok(profiles.some((p) => p.reply.includes('"tool":')));

// --- Routes -------------------------------------------------------------------------------------
const slicer = JSON.parse(read("testdata/cross-platform/external-slicer-vectors.json"));
const endpoints = slicer.endpoints.map((c) => {
  const endpoint = JSON.parse(c.endpointJson);
  const units = endpoint.endpoint ?? JSON.parse(c.requestJson).input;
  return String.fromCharCode(...units);
});
const pinned = PINNED_ENGINE_PROVENANCE;
const pinnedHash = `sha256:${Object.values(pinned.artifacts)[0]}`;
const engines = [
  { commit: pinned.commit, artifactHash: pinnedHash },
  { commit: "", artifactHash: pinnedHash },
  { commit: pinned.commit, artifactHash: "  " },
  { commit: ` ${pinned.commit} `, artifactHash: ` ${pinnedHash}` },
];
const routes = [];
for (const endpoint of [...new Set(endpoints)])
  for (const engine of endpoint === endpoints[3] ? engines : engines.slice(0, 1)) {
    const request = JSON.stringify({ endpoint, engine });
    routes.push({ request, reply: sliceRouteExchange(request) });
  }
assert.ok(routes.some((r) => r.reply.includes('"error"')) && routes.some((r) => r.reply.includes('"id"')));

// --- Bindings -----------------------------------------------------------------------------------
const valid = {
  jobId: "slice-0123456789abcdef",
  plateId: "1f976fee-ce53-4e66-8977-60c9c343c4a3",
  sourceRevision: 7,
  sourceHash: "fnv1a64:0123456789abcdef",
  sourceAssetHash: "fnv1a64:fedcba9876543210",
  projectInputHash: sha("archive"),
  gcodeOutputHash: sha("gcode"),
  effectiveConfigHash: sha("config"),
  engineCommit: pinned.commit,
  engineArtifactHash: pinnedHash,
};
const broken = [["valid", valid]];
const field = (name, value) => broken.push([`${name} ${JSON.stringify(value)?.slice(0, 40)}`, { ...valid, [name]: value }]);
for (const name of ["jobId", "plateId", "engineCommit"])
  for (const value of ["", " x", "x ", "x".repeat(512), "x".repeat(513), 7, null, " x"]) field(name, value);
field("plateId", "import:unicode:\ud800\u0000");
for (const value of [0, -1, 1.5, 2 ** 53, 2 ** 53 - 1, "7", null, -0]) field("sourceRevision", value);
for (const name of ["sourceHash", "sourceAssetHash"])
  for (const value of ["fnv1a64:0123456789ABCDEF", "fnv1a64:0123456789abcde", "sha256:0123456789abcdef", 5]) field(name, value);
for (const name of ["projectInputHash", "gcodeOutputHash", "effectiveConfigHash", "engineArtifactHash"])
  for (const value of [sha("x").toUpperCase(), sha("x").slice(0, -1), sha("x").slice(7), `sha512:${"0".repeat(64)}`, null]) field(name, value);
for (const value of [pinned.commit.slice(1), pinned.commit.toUpperCase(), `${pinned.commit}0`, "g".repeat(40)]) field("engineCommit", value);
const { jobId: _jobId, ...missing } = valid;
broken.push(["missing jobId", missing]);
broken.push(["extra field", { ...valid, extra: 1 }]);
broken.push(["prototype key", JSON.parse(JSON.stringify(valid).replace("{", '{"__proto__":1,'))]);
for (const value of [null, [], 5, "binding"]) broken.push([`binding ${JSON.stringify(value)}`, value]);
const bindings = broken.map(([name, binding]) => {
  const request = `{"binding":${JSON.stringify(binding)}}`;
  return { name, request, reply: sliceBindingExchange(request) };
});
assert.equal(bindings[0].reply, '{"valid":true}');

// --- Malformed requests -------------------------------------------------------------------------
const refused = (exchange, requests) =>
  Promise.all(
    requests.map(async (request) => {
      await assert.rejects(async () => exchange(request), /^Error: invalid_request$/);
      return { request };
    }),
  );
const stateJson = JSON.stringify(rich());
const engine = { commit: pinned.commit, artifactHash: pinnedHash };
const profileRefusals = await refused(sliceProfilesExchange, [
  "",
  "[]",
  "{}",
  JSON.stringify({ plateId: "p" }),
  JSON.stringify({ plateId: 7, stateJson }),
  JSON.stringify({ plateId: "p", stateJson: 7 }),
  JSON.stringify({ plateId: "p", stateJson: "{" }),
  JSON.stringify({ plateId: "p", stateJson, extra: 1 }),
]);
const routeRefusals = await refused(sliceRouteExchange, [
  "",
  "{}",
  JSON.stringify({ endpoint: "http://h" }),
  JSON.stringify({ endpoint: 7, engine }),
  JSON.stringify({ endpoint: "http://h", engine: { commit: pinned.commit } }),
  JSON.stringify({ endpoint: "http://h", engine: { ...engine, commit: 7 } }),
  JSON.stringify({ endpoint: "http://h", engine: [] }),
  JSON.stringify({ endpoint: "http://h", engine, extra: 1 }),
]);
const bindingRefusals = await refused(sliceBindingExchange, ["", "[]", "{}", '{"binding":1,"extra":1}', "nul"]);

const sources = [
  "tools/cross-platform/slice-sidecar-vectors.mjs",
  "web/src/slicer/SliceSidecarExchange.ts",
  "web/src/project/slicing/profileResolver.ts",
  "web/src/slicer/CanonicalSlicerClientRoute.ts",
  "web/src/slicer/GcodeStatisticsModel.ts",
];
const corpus = { profiles, routes, bindings, profileRefusals, routeRefusals, bindingRefusals };
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    ...corpus,
  }) + "\n";
const target = new URL("testdata/cross-platform/slice-sidecar-vectors.json", root);
if (write) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "Slice sidecar reference drift");
console.log(
  `Slice sidecar references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
