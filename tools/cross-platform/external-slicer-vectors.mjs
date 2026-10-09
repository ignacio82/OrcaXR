// External slicer references from the production browser
// (`ExternalSlicerExchange.ts` over `ExternalEngineAttestation.ts` and
// `ExternalSlicerJobs.ts`): how captured endpoints of every shape become
// canonical (or are refused) and what an attestation and a submission then
// send; how engine attestations read against the pinned build (each check in
// turn, malformed and hostile payloads, prototype names, duplicate keys);
// what each job step sends for job IDs of every shape; and how submission,
// status, cancellation and artifact replies read, including the facts a host
// computes of a downloaded artifact. Also writes the pinned engine provenance
// every host checks attestations against (`contracts/pinned-engine-provenance.json`,
// from `pinnedEngineProvenance.ts`). Replayed by Rust.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerArtifact,
  answerAttestation,
  answerAttestationPlan,
  answerCancel,
  answerEndpoint,
  answerJobPlan,
  answerPoll,
  answerSubmission,
  answerSubmitPlan,
  artifactFacts,
} from "../../web/src/slicer/ExternalSlicerExchange.ts";
import { PINNED_ENGINE_PROVENANCE } from "../../web/src/slicer/pinnedEngineProvenance.ts";
import { sha256Bytes } from "../../web/src/slicer/Utf8Sha256.ts";
import {
  encodeProjectExternalSlicerArtifact,
  encodeProjectExternalSlicerArtifactRead,
  encodeProjectExternalSlicerAttestation,
  encodeProjectExternalSlicerAttestationPlan,
  encodeProjectExternalSlicerCancelRead,
  encodeProjectExternalSlicerCancelStep,
  encodeProjectExternalSlicerEndpoint,
  encodeProjectExternalSlicerEndpointRequest,
  encodeProjectExternalSlicerJobRequest,
  encodeProjectExternalSlicerPlan,
  encodeProjectExternalSlicerPollRead,
  encodeProjectExternalSlicerPollStep,
  encodeProjectExternalSlicerReply,
  encodeProjectExternalSlicerSubmission,
  encodeProjectExternalSlicerSubmitRead,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const write = process.argv.includes("--write");
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const optional = (value) =>
  value === undefined ? absent : { value: units(value) };

// Seeded, so the corpus is the same every run.
let seed = 0x51ce;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

// --- The pinned build, as every host reads it -------------------------------------------------
const pinned = PINNED_ENGINE_PROVENANCE;
const provenance =
  JSON.stringify(
    {
      schemaVersion: 1,
      source: "web/src/slicer/pinnedEngineProvenance.ts",
      commit: pinned.commit,
      cliVersion: pinned.cliVersion,
      artifacts: Object.entries(pinned.artifacts).map(([name, sha256]) => ({
        name,
        sha256,
      })),
      cliPatches: Object.entries(pinned.cliPatches).map(([name, sha256]) => ({
        name,
        sha256,
      })),
      features: {
        wasm: [...pinned.features.wasm],
        cli: [...pinned.features.cli],
      },
    },
    null,
    2,
  ) + "\n";

// --- Endpoints --------------------------------------------------------------------------------
const endpointInputs = [
  "",
  "   ",
  "127.0.0.1:3000",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3000/",
  "http://127.0.0.1:3000///",
  "  http://192.168.1.20:3000  ",
  "https://slicer.local",
  "HTTP://Slicer.Local:3000/",
  "HtTpS://slicer.local/base/path/",
  "slicer.local",
  "slicer.local:3000",
  "localhost",
  "\u00a0slicer.local\u2028",
  "\ufeffslicer.local\u3000",
  "::1",
  "fe80::1",
  "fe80::1%eth0",
  "[::1]:3000",
  "http://[::1]:3000/",
  "http://[fe80::1]",
  "ftp://slicer.local",
  "file:///etc/passwd",
  "ws://slicer.local",
  "javascript:alert(1)",
  "mailto:a@b",
  "a://b",
  "http://user:pw@slicer.local",
  "http://user@slicer.local",
  "http://:pw@slicer.local",
  "user@slicer.local",
  "http://slicer.local/?token=1",
  "http://slicer.local?",
  "http://slicer.local#",
  "http://slicer.local/#frag",
  "slicer.local/?x",
  "http://slicer.local/a?b/",
  "http://slicer.local/base",
  "http://slicer.local/base//",
  "http://slicer.local:80",
  "https://slicer.local:443/",
  "slicer.local:99999",
  "slicer.local:abc",
  "http://slicer.local:",
  "http://",
  "http:///x/",
  "http:////slicer.local",
  "http:/slicer.local",
  "http:slicer.local",
  "http:\\\\slicer.local\\path",
  "\\\\slicer.local",
  "http://slicer.local\\base\\",
  "http://exa mple",
  "http://ex\tample/",
  "http://ex\nample",
  "slicer.local\u0001",
  "http://例え.テスト/",
  "http://xn--r8jz45g.xn--zckzah",
  "http://1.2.3",
  "http://0x7f.1:3000",
  "http://256.256.256.256",
  "http://slicer.local/\ud800",
  "http://slicer.local/ü/😀/",
  "http://%73licer.local",
  "http://slicer.local/%2F/",
  `http://${"a".repeat(63)}.local/${"p".repeat(2000)}`,
  "http://slicer..local",
  "http://-slicer.local",
  "http://slicer.local.",
  "123",
  "http://[::1",
  "[::1]",
];
const endpoints = [];
for (const input of endpointInputs) {
  const request = { input: units(input) };
  endpoints.push({
    requestJson: encodeProjectExternalSlicerEndpointRequest(request),
    endpointJson: encodeProjectExternalSlicerEndpoint(answerEndpoint(request)),
    attestationPlanJson: encodeProjectExternalSlicerAttestationPlan(
      await answerAttestationPlan(request),
    ),
    submitPlanJson: encodeProjectExternalSlicerPlan(answerSubmitPlan(request)),
  });
}

// --- Attestations -----------------------------------------------------------------------------
const hex = (fill) => fill.repeat(64);
const cliDigest = hex("c");
const wasm = () => ({
  schemaVersion: 1,
  engine: "wasm",
  attested: true,
  upstream: { commit: pinned.commit },
  artifacts: { ...pinned.artifacts },
  patches: [],
  reason: null,
});
const patches = () =>
  Object.entries(pinned.cliPatches).map(([name, sha256]) => ({ name, sha256 }));
const cli = () => ({
  schemaVersion: 1,
  engine: "cli",
  attested: true,
  upstream: { commit: pinned.commit, version: pinned.cliVersion },
  artifacts: { "snapmaker-orca": cliDigest },
  patches: patches(),
  reason: null,
});
const edit = (base, change) => {
  const value = base();
  change(value);
  return JSON.stringify(value);
};
const [firstPatch, ...restPatches] = Object.keys(pinned.cliPatches);
const attestationBodies = [
  JSON.stringify(wasm()),
  JSON.stringify(cli()),
  ` \n\t${JSON.stringify(wasm())}\r\n `,
  "",
  "not json",
  "\ufeff{}",
  "null",
  "[]",
  "[1,2]",
  "42",
  '"attested"',
  "true",
  "{}",
  '{"attested":false}',
  '{"attested":false,"reason":"This server was built without engine provenance."}',
  '{"attested":false,"reason":""}',
  '{"attested":false,"reason":" \\n\\u00a0"}',
  '{"attested":false,"reason":"  padded reason  "}',
  '{"attested":false,"reason":42}',
  '{"attested":false,"reason":"\\ud800 lone"}',
  `{"attested":false,"reason":"${"r".repeat(150000)}"}`,
  '{"attested":"true"}',
  '{"attested":1}',
  '{"__proto__":{"attested":true}}',
  '{"attested":true,"attested":false,"reason":"last wins"}',
  JSON.stringify(wasm()).replace(
    '"attested":true',
    '"attested":false,"attested":true',
  ),
  edit(wasm, (v) => (v.schemaVersion = 2)),
  edit(wasm, (v) => (v.schemaVersion = "1")),
  edit(wasm, (v) => delete v.schemaVersion),
  JSON.stringify(wasm()).replace('"schemaVersion":1', '"schemaVersion":1.0'),
  JSON.stringify(wasm()).replace('"schemaVersion":1', '"schemaVersion":10e-1'),
  JSON.stringify(wasm()).replace(
    '"schemaVersion":1',
    '"schemaVersion":1.0000000000000001',
  ),
  edit(wasm, (v) => (v.engine = "WASM")),
  edit(wasm, (v) => (v.engine = "cli ")),
  edit(wasm, (v) => delete v.engine),
  edit(wasm, (v) => (v.engine = ["wasm"])),
  edit(wasm, (v) => delete v.artifacts),
  edit(wasm, (v) => (v.artifacts = null)),
  edit(wasm, (v) => (v.artifacts = "x")),
  edit(wasm, (v) => (v.artifacts = [])),
  edit(cli, (v) => (v.artifacts = [])),
  edit(wasm, (v) => (v.artifacts = {})),
  edit(wasm, (v) => delete v.upstream),
  edit(wasm, (v) => (v.upstream = null)),
  edit(wasm, (v) => (v.upstream = pinned.commit)),
  edit(wasm, (v) => (v.upstream = [pinned.commit])),
  edit(wasm, (v) => (v.upstream = { commit: pinned.commit.toUpperCase() })),
  edit(wasm, (v) => (v.upstream = { commit: hex("0").slice(0, 40) })),
  edit(wasm, (v) => (v.upstream = { commit: ` ${pinned.commit}` })),
  edit(wasm, (v) => (v.artifacts["slic3r.mjs"] = hex("0"))),
  edit(wasm, (v) => (v.artifacts["slic3r.wasm"] = hex("0"))),
  edit(wasm, (v) => delete v.artifacts["slic3r.mjs"]),
  edit(
    wasm,
    (v) =>
      (v.artifacts["slic3r.wasm"] = v.artifacts["slic3r.wasm"].toUpperCase()),
  ),
  edit(wasm, (v) => (v.artifacts.extra = "anything")),
  edit(
    wasm,
    (v) =>
      (v.artifacts = {
        "slic3r.wasm": v.artifacts["slic3r.wasm"],
        "slic3r.mjs": v.artifacts["slic3r.mjs"],
      }),
  ),
  edit(wasm, (v) => (v.patches = "not checked for wasm")),
  edit(cli, (v) => delete v.patches),
  edit(cli, (v) => (v.patches = {})),
  edit(cli, (v) => (v.patches = "0001")),
  edit(cli, (v) => (v.patches = [])),
  edit(cli, (v) => v.patches.unshift(null)),
  edit(cli, (v) => v.patches.push(42)),
  edit(cli, (v) => v.patches.push("0005-extra.patch")),
  edit(cli, (v) => v.patches.splice(1, 0, [])),
  edit(cli, (v) => v.patches.push({ sha256: hex("1") })),
  edit(cli, (v) => v.patches.push({ name: 5, sha256: hex("1") })),
  edit(cli, (v) => v.patches.push({ ...v.patches[0] })),
  edit(cli, (v) => v.patches.push({ name: firstPatch, sha256: hex("1") })),
  edit(cli, (v) => v.patches.shift()),
  edit(cli, (v) => v.patches.pop()),
  edit(cli, (v) => v.patches.reverse()),
  edit(cli, (v) => (v.patches[1].sha256 = hex("1"))),
  edit(cli, (v) => (v.patches[0].sha256 = v.patches[0].sha256.toUpperCase())),
  edit(cli, (v) => delete v.patches[2].sha256),
  edit(cli, (v) => (v.patches[3].sha256 = null)),
  edit(cli, (v) => (v.patches[0].name = ` ${firstPatch}`)),
  edit(cli, (v) =>
    v.patches.push({ name: "0005-unknown-feature.patch", sha256: hex("5") }),
  ),
  edit(cli, (v) => v.patches.push({ name: "toString", sha256: hex("5") })),
  edit(cli, (v) => v.patches.push({ name: "constructor" })),
  edit(cli, (v) => v.patches.push({ name: "hasOwnProperty", sha256: null })),
  edit(cli, (v) => v.patches.push({ name: "", sha256: "" })),
  edit(cli, (v) => v.patches.push({ name: "😀\u2028\\ü", sha256: hex("5") })),
  JSON.stringify(cli()).replace("]", ',{"name":"__proto__","sha256":"x"}]'),
  JSON.stringify(cli()).replace(
    `"name":"${firstPatch}"`,
    `"name":"ignored","name":"${firstPatch}"`,
  ),
  edit(cli, (v) => v.patches.push({ name: "\ud800", sha256: hex("5") })),
  edit(cli, (v) => delete v.artifacts["snapmaker-orca"]),
  edit(cli, (v) => (v.artifacts["snapmaker-orca"] = cliDigest.toUpperCase())),
  edit(cli, (v) => (v.artifacts["snapmaker-orca"] = cliDigest.slice(1))),
  edit(cli, (v) => (v.artifacts["snapmaker-orca"] = `${cliDigest}\n`)),
  edit(cli, (v) => (v.artifacts["snapmaker-orca"] = `sha256:${cliDigest}`)),
  edit(cli, (v) => (v.artifacts["snapmaker-orca"] = 42)),
  edit(
    cli,
    (v) => (v.artifacts["slic3r.wasm"] = pinned.artifacts["slic3r.wasm"]),
  ),
  edit(wasm, (v) => (v.artifacts["snapmaker-orca"] = cliDigest)),
  edit(
    cli,
    (v) => (v.deep = JSON.parse(`${"[".repeat(100)}${"]".repeat(100)}`)),
  ),
  edit(cli, (v) => (v.upstream.commit = pinned.commit)),
  edit(wasm, (v) => (v.reason = "attested anyway")),
];
// Seeded mixes of every field's variants.
const variants = {
  schemaVersion: [1, 1, 1, 2, "1", undefined],
  engine: ["wasm", "cli", "cli", "WASM", undefined],
  attested: [true, true, true, false, "true", undefined],
  upstream: [
    { commit: pinned.commit },
    { commit: pinned.commit },
    { commit: "x" },
    null,
    undefined,
  ],
  artifacts: [
    { ...pinned.artifacts },
    { "snapmaker-orca": cliDigest },
    { ...pinned.artifacts, "snapmaker-orca": cliDigest },
    { "slic3r.mjs": pinned.artifacts["slic3r.mjs"] },
    [],
    null,
    undefined,
  ],
  patches: [
    patches(),
    patches(),
    patches().slice(1),
    [...patches(), { name: "0009-x.patch", sha256: hex("9") }],
    [],
    undefined,
  ],
  reason: ["Server says no.", null, 7, undefined],
};
for (let i = 0; i < 120; i++) {
  const value = {};
  for (const [key, options] of Object.entries(variants)) {
    const chosen = pick(options);
    if (chosen !== undefined) value[key] = chosen;
  }
  attestationBodies.push(JSON.stringify(value));
}
const attestationReplies = [
  { failed: units("Failed to fetch") },
  { failed: [] },
  ...[401, 403, 404, 500, 199, 300, 0, 418].map((status) => ({
    response: { status, body: units(JSON.stringify(wasm())) },
  })),
  ...[200, 201, 204, 299].map((status) => ({
    response: { status, body: units(JSON.stringify(cli())) },
  })),
  ...attestationBodies.map((body) => ({
    response: { status: 200, body: units(body) },
  })),
];
const attestations = [];
for (const reply of attestationReplies)
  attestations.push({
    requestJson: encodeProjectExternalSlicerReply(reply),
    replyJson: encodeProjectExternalSlicerAttestation(
      await answerAttestation(reply),
    ),
  });

// --- Job steps --------------------------------------------------------------------------------
const jobEndpoints = [
  "http://127.0.0.1:3000",
  "https://Slicer.Local/base",
  "http://[::1]:3000",
];
const jobIds = [
  "job-1",
  "0c5a1f0e-2b6d-4c55-9d1e-3f2a1b0c9d8e",
  "A_b-9",
  "a".repeat(128),
  "a".repeat(129),
  "",
  "a/b",
  "..",
  "%41",
  "x y",
  "ü",
  "job-1\n",
  "\ud800",
];
const jobPlans = [];
for (const endpoint of jobEndpoints)
  for (const jobId of jobIds)
    for (const step of ["status", "artifact", "cancel", "release"]) {
      const request = { endpoint: units(endpoint), jobId: units(jobId), step };
      jobPlans.push({
        requestJson: encodeProjectExternalSlicerJobRequest(request),
        replyJson: encodeProjectExternalSlicerPlan(
          await answerJobPlan(request),
        ),
      });
    }

// --- Submissions ------------------------------------------------------------------------------
const gcode = "; generated by OrcaSlicer\nG28\nG1 X10 Y10 F3000\n";
const submitReplies = [
  { failed: units("Failed to fetch") },
  { failed: units("NetworkError when attempting to fetch resource.") },
  { failed: [] },
  ...[
    [202, '{"job":"job-1"}'],
    [202, '{"job":"0c5a1f0e-2b6d-4c55-9d1e-3f2a1b0c9d8e","status":"queued"}'],
    [202, '{"job":""}'],
    [202, '{"job":42}'],
    [202, '{"job":null}'],
    [202, '{"job":"a/b"}'],
    [202, '{"job":" padded "}'],
    [202, '{"job":"first","job":"last"}'],
    [202, "{}"],
    [202, "[]"],
    [202, '["job-1"]'],
    [202, "null"],
    [202, '"job-1"'],
    [202, ""],
    [202, "not json"],
    [202, `{"job":"${"j".repeat(5000)}"}`],
    [200, gcode],
    [200, ""],
    [201, gcode],
    [299, gcode],
    [204, ""],
    [400, "Missing project file."],
    [401, '{"error":"unauthorized"}'],
    [413, ""],
    [413, " \n"],
    [500, "Slicer crashed: segmentation fault"],
    [503, "x".repeat(3000)],
    [302, ""],
    [199, "early"],
    [0, ""],
  ].map(([status, body]) => ({ status, body })),
];
const headerIds = [undefined, "", "job-1", "a/b"];
const submissions = [];
for (const reply of submitReplies)
  for (const aborted of [false, true])
    for (const header of "failed" in reply ? [undefined] : headerIds) {
      const request = {
        reply:
          "failed" in reply
            ? reply
            : {
                response: {
                  status: reply.status,
                  body: units(reply.body),
                  jobIdHeader: optional(header),
                },
              },
        aborted,
      };
      submissions.push({
        requestJson: encodeProjectExternalSlicerSubmitRead(request),
        replyJson: encodeProjectExternalSlicerSubmission(
          answerSubmission(request),
        ),
      });
    }
// One refusal as long as a reply runs, once.
{
  const request = {
    reply: {
      response: {
        status: 500,
        body: units("x".repeat(150000)),
        jobIdHeader: absent,
      },
    },
    aborted: false,
  };
  submissions.push({
    requestJson: encodeProjectExternalSlicerSubmitRead(request),
    replyJson: encodeProjectExternalSlicerSubmission(answerSubmission(request)),
  });
}

// --- Status polls and cancellation replies ---------------------------------------------------
const statusReplies = [
  { failed: units("Failed to fetch") },
  { failed: [] },
  ...[
    [500, ""],
    [404, '{"status":"done"}'],
    [304, ""],
    [200, ""],
    [200, "garbage"],
    [200, "null"],
    [200, "[]"],
    [200, '["done"]'],
    [200, "{}"],
    [200, '{"status":"weird"}'],
    [200, '{"status":"Done"}'],
    [200, '{"status":"released"}'],
    [200, '{"status":["done"]}'],
    [200, '{"status":"queued"}'],
    [200, '{"status":"queued","percent":0,"message":"Queued"}'],
    [200, '{"status":"running","percent":12.5,"message":"Generating G-code"}'],
    [200, '{"status":"running","percent":"50","message":42}'],
    [200, '{"status":"running","percent":null,"message":""}'],
    [200, '{"status":"running","percent":1e400,"message":" "}'],
    [200, '{"status":"running","percent":-1e400}'],
    [200, '{"status":"running","percent":-0}'],
    [200, '{"status":"running","percent":-3.25,"message":"\\ud800"}'],
    [200, '{"status":"running","percent":1.7976931348623157e308}'],
    [
      200,
      `{"status":"running","percent":99.99,"message":"${"m".repeat(3000)}"}`,
    ],
    [200, '{"status":"cancelling","percent":40}'],
    [200, '{"status":"done","percent":100}'],
    [201, '{"status":"done"}'],
    [200, '{"status":"error","error":"Slicing failed: no objects on plate"}'],
    [200, '{"status":"error"}'],
    [200, '{"status":"error","error":42}'],
    [200, '{"status":"error","error":""}'],
    [200, '{"status":"error","error":" \\t"}'],
    [200, '{"status":"error","errorCode":"timeout","error":null}'],
    [200, '{"status":"cancelled"}'],
    [200, '{"status":"running","status":"done"}'],
    [200, '{"__proto__":{"status":"done"}}'],
    [
      200,
      '{"status":"running","completedAt":1,"expiresAt":2,"extra":{"deep":[1,2,3]}}',
    ],
  ].map(([status, body]) => ({ response: { status, body: units(body) } })),
];
const polls = [];
for (const reply of statusReplies)
  for (const failures of [0, 3, 4, 5, 9007199254740991]) {
    const request = { failures, reply };
    polls.push({
      requestJson: encodeProjectExternalSlicerPollRead(request),
      replyJson: encodeProjectExternalSlicerPollStep(answerPoll(request)),
    });
  }
{
  const body = `{"status":"running","percent":50,"message":"${"m".repeat(150000)}"}`;
  const request = {
    failures: 2,
    reply: { response: { status: 200, body: units(body) } },
  };
  polls.push({
    requestJson: encodeProjectExternalSlicerPollRead(request),
    replyJson: encodeProjectExternalSlicerPollStep(answerPoll(request)),
  });
}
const cancelReads = [
  { timedOut: {} },
  ...statusReplies.map((reply) => ({ reply })),
  ...[
    '{"status":"cancelled","released":true}',
    '{"status":"released","released":true}',
    '{"status":"error","error":"x"}',
  ].map((body) => ({
    reply: { response: { status: 200, body: units(body) } },
  })),
  {
    reply: {
      response: { status: 202, body: units('{"status":"cancelling"}') },
    },
  },
];
const cancels = cancelReads.map((request) => ({
  requestJson: encodeProjectExternalSlicerCancelRead(request),
  replyJson: encodeProjectExternalSlicerCancelStep(answerCancel(request)),
}));

// --- Artifacts --------------------------------------------------------------------------------
const encoder = new TextEncoder();
const digest = (bytes) => sha256Bytes(bytes).slice(7);
const identified = (bytes, jobId) => ({
  "x-orcaxr-job-id": jobId,
  "x-orcaxr-gcode-sha256": digest(bytes),
  "x-orcaxr-gcode-bytes": String(bytes.length),
});
const good = encoder.encode(gcode);
const big = encoder.encode(`${"G1 X1 Y1 E0.1\n".repeat(20000)}; ü 😀\n`);
const artifactCases = [
  // A job's artifact, with every header the server sends.
  { expected: "job-1", bytes: good, headers: identified(good, "job-1") },
  { expected: "job-1", bytes: big, headers: identified(big, "job-1") },
  { expected: "job-1", bytes: good, headers: {} },
  {
    expected: "job-1",
    bytes: good,
    headers: { "x-orcaxr-gcode-sha256": digest(good) },
  },
  {
    expected: "job-1",
    bytes: good,
    headers: { "X-OrcaXR-Gcode-SHA256": ` ${digest(good)}\t` },
  },
  { expected: "job-1", bytes: good, headers: identified(good, "job-2") },
  { expected: "job-1", bytes: good, headers: identified(good, "") },
  { expected: "", bytes: good, headers: identified(good, "job-2") },
  { expected: "a/b", bytes: good, headers: identified(good, "a/b") },
  {
    expected: "a/b",
    bytes: good,
    headers: { "x-orcaxr-gcode-sha256": digest(good) },
  },
  // A synchronous reply: the job, if any, is the header's.
  { bytes: good, headers: identified(good, "job-3") },
  { bytes: good, headers: { "x-orcaxr-job-id": "job-3" } },
  { bytes: good, headers: { "x-orcaxr-gcode-sha256": digest(good) } },
  { bytes: good, headers: identified(good, "a/b") },
  { bytes: good, headers: identified(good, "a".repeat(129)) },
  { bytes: good, headers: {} },
  // Refusals.
  { status: 500, errorBody: "Slicer crashed", headers: {} },
  { status: 404, errorBody: "", headers: {} },
  { status: 404, errorBody: "\r\n", headers: {} },
  {
    status: 410,
    errorBody: '{"error":"expired"}',
    headers: identified(good, "job-1"),
  },
  { status: 503, errorBody: "e".repeat(150000), headers: {} },
  // Incomplete transfers.
  { expected: "job-1", bytes: new Uint8Array(0), headers: {} },
  {
    expected: "job-1",
    bytes: new Uint8Array(0),
    headers: identified(new Uint8Array(0), "job-1"),
  },
  ...[
    "5",
    "abc",
    "",
    "10.0",
    "-1",
    "1e1",
    "99999999999999999999999",
    `0000${good.length}`,
    `+${good.length}`,
  ].map((bytesHeader) => ({
    expected: "job-1",
    bytes: good,
    headers: {
      ...identified(good, "job-1"),
      "x-orcaxr-gcode-bytes": bytesHeader,
    },
  })),
  // Digests.
  ...[
    digest(good).toUpperCase(),
    digest(good).slice(1),
    "",
    `sha256:${digest(good)}`,
    "g".repeat(64),
  ].map((sha) => ({
    expected: "job-1",
    bytes: good,
    headers: { ...identified(good, "job-1"), "x-orcaxr-gcode-sha256": sha },
  })),
  {
    expected: "job-1",
    bytes: good,
    headers: {
      ...identified(good, "job-1"),
      "x-orcaxr-gcode-sha256": digest(big),
    },
  },
  // Text.
  ...[
    new Uint8Array([0xff, 0xfe, 0x47]),
    new Uint8Array([0x47, 0x31, 0xc3]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    encoder.encode("   \n\t\r\n"),
    encoder.encode("\ufeff"),
    encoder.encode("\ufeff\ufeff"),
    encoder.encode("\ufeff \u00a0\u2028\u3000"),
    encoder.encode("\u200b"),
    encoder.encode("\u0085"),
    encoder.encode("\0"),
    encoder.encode("\ufeffG28\n"),
  ].map((bytes) => ({
    expected: "job-1",
    bytes,
    headers: identified(bytes, "job-1"),
  })),
];
const artifacts = [];
for (const {
  expected,
  bytes = new Uint8Array(0),
  status = 200,
  errorBody,
  headers,
} of artifactCases) {
  const request = {
    expectedJobId: optional(expected),
    response: artifactFacts(bytes, { status, errorBody, headers }),
  };
  artifacts.push({
    requestJson: encodeProjectExternalSlicerArtifactRead(request),
    replyJson: encodeProjectExternalSlicerArtifact(
      await answerArtifact(request, bytes, headers, errorBody),
    ),
  });
}

const sources = [
  "tools/cross-platform/external-slicer-vectors.mjs",
  "web/src/slicer/ExternalSlicerExchange.ts",
  "web/src/slicer/ExternalEngineAttestation.ts",
  "web/src/slicer/ExternalSlicerJobs.ts",
  "web/src/slicer/pinnedEngineProvenance.ts",
  "web/src/net/LocalNetworkAccess.ts",
  "web/src/printer/PrinterWire.ts",
];
const corpus = {
  endpoints,
  attestations,
  jobPlans,
  submissions,
  polls,
  cancels,
  artifacts,
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
const files = [
  [
    "contracts/pinned-engine-provenance.json",
    provenance,
    "Pinned engine provenance drift",
  ],
  [
    "testdata/cross-platform/external-slicer-vectors.json",
    output,
    "External slicer reference drift",
  ],
];
for (const [path, text, drift] of files) {
  const url = new URL(path, root);
  if (write) writeFileSync(url, text);
  else assert.equal(readFileSync(url, "utf8"), text, drift);
}
console.log(
  `External slicer references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
