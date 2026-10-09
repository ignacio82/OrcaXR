// Printer camera references from the production browser
// (`PrinterCameraExchange.ts` over `PrinterCamera.ts`): how camera lists of
// every shape read against every kind of endpoint (relative, rooted, same
// origin, another port, another host, IPv6, unreadable URLs, every service,
// rotation and rate), how a listing's exchange finishes, which route a frame
// takes and what each failed fetch reads as, which routes are worth trying
// from which page, how the service is described, the poll interval and the
// frame URL. Replayed by Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerCameraDescribe,
  answerCameraListPlan,
  answerCameraFrameUrl,
  answerCameraListFinish,
  answerCameraListRead,
  answerCameraMechanisms,
  answerCameraPollInterval,
  answerCameraSnapshotFailure,
  answerCameraSnapshotPlan,
} from "../../web/src/printer/PrinterCameraExchange.ts";
import {
  encodeProjectCameraDescribeRequest,
  encodeProjectCameraFailure,
  encodeProjectCameraFrameRequest,
  encodeProjectCameraListFinish,
  encodeProjectCameraListRequest,
  encodeProjectCameraListResult,
  encodeProjectCameraMechanisms,
  encodeProjectCameraMechanismsRequest,
  encodeProjectCameraSnapshotFinish,
  encodeProjectCameraSnapshotPlan,
  encodeProjectCameraSnapshotRequest,
  encodeProjectOptionalPrinterReplyText,
  encodeProjectPrinterCamera,
  encodeProjectPrinterSend,
  encodeProjectPrinterText,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const optional = (value) =>
  value === undefined ? absent : { value: units(value) };

// Seeded, so the corpus is the same every run.
let seed = 0xca3;
const random = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed / 0x100000000;
};
const pick = (values) => values[Math.floor(random() * values.length)];

const endpoints = [
  undefined,
  "",
  "http://192.168.1.228:7125",
  "http://printer.local:7125",
  "http://PRINTER.local:7125/",
  "https://printer.local",
  "http://[fd00::1:5]:7125",
  "http://[FD00::1:5]:7125",
  "http://printer.local:80",
  "http://user:pw@printer.local:7125",
  "not a url",
  "mailto:someone",
];
const snapshotUrls = [
  undefined,
  "/webcam/?action=snapshot",
  "webcam/snapshot.jpg",
  "  /webcam/x  ",
  "/webcam/?action=snapshot&x=%20",
  "/",
  "/web cam",
  "/webcam/~x",
  "javascript:alert(1)",
  "http://printer.local:7125/webcam/?action=snapshot",
  "http://printer.local:7125",
  "http://printer.local:7125/?",
  "http://printer.local:7125/a?b=1#frag",
  "http://printer.local:8080/?action=snapshot",
  "HTTP://Printer.Local:8080/x",
  "https://printer.local/s",
  "http://elsewhere.local/x",
  "http://[fd00::1:5]:8080/snap",
  "http://[fd00::1:5]:7125/webcam/",
  "http://192.168.1.228/webcam/snapshot.jpg",
  "http://192.168.1.228:7125/webcam/snapshot.jpg",
  "http://exa mple/",
  "http://printer.local:7125/a b?c d",
  "x\uD800/y",
];
const services = [
  "mjpegstreamer",
  "MJPEGSTREAMER-ADAPTIVE",
  "uv4l-mjpeg",
  "hlsstream",
  "ipstream",
  "webrtc-camerastreamer",
  "webrtc-go2rtc",
  "webrtc-mediamtx",
  "webrtc",
  "",
  undefined,
  3,
];
function cameraEntry() {
  const entry = {};
  const name = pick(["Nozzle", "  Bed  ", "", "   ", undefined, 7, "Cam ü"]);
  if (name !== undefined) entry.name = name;
  const uid = pick(["cam-1", "", undefined, " u2 "]);
  if (uid !== undefined) entry.uid = uid;
  const service = pick(services);
  if (service !== undefined) entry.service = service;
  const snapshot = pick(snapshotUrls);
  if (snapshot !== undefined) entry.snapshot_url = snapshot;
  const stream = pick(snapshotUrls);
  if (stream !== undefined) entry.stream_url = stream;
  if (random() < 0.8)
    entry.target_fps = pick([0, -1, 0.1, 0.2, 1, 2.5, 15, 30, 1e300, "15"]);
  if (random() < 0.6) entry.rotation = pick([0, 90, 180, 270, 45, -90, "90"]);
  if (random() < 0.5) entry.flip_horizontal = pick([true, false, "true", 1]);
  if (random() < 0.5) entry.flip_vertical = pick([true, false, null]);
  if (random() < 0.5) entry.enabled = pick([true, false, 0, "false"]);
  return random() < 0.05 ? pick([null, "cam", []]) : entry;
}
const listReplies = [
  JSON.stringify(null),
  JSON.stringify([]),
  JSON.stringify({}),
  JSON.stringify({ webcams: "none" }),
  JSON.stringify({ webcams: [] }),
  JSON.stringify({
    webcams: snapshotUrls.map((snapshot_url, i) => ({
      name: `Camera ${i}`,
      service: services[i % 8],
      ...(snapshot_url === undefined ? {} : { snapshot_url }),
      stream_url: "/webcam/?action=stream",
      target_fps: 15,
    })),
  }),
];
for (let i = 0; i < 20; i++)
  listReplies.push(
    JSON.stringify({
      webcams: Array.from({ length: Math.floor(random() * 5) }, cameraEntry),
    }),
  );
const listReads = [];
const cameras = new Map();
for (const reply of listReplies) {
  for (const endpoint of [
    ...(reply.length > 2000 ? endpoints : [pick(endpoints), pick(endpoints)]),
  ]) {
    const request = { endpoint: optional(endpoint) };
    const result = await answerCameraListRead(request, reply);
    if ("cameras" in result)
      for (const camera of result.cameras)
        cameras.set(encodeProjectPrinterCamera(camera), camera);
    listReads.push({
      requestJson: encodeProjectCameraListRequest(request),
      reply,
      replyJson: encodeProjectCameraListResult(result),
    });
  }
}

const codes = [
  "invalidEndpoint",
  "invalidState",
  "cancelled",
  "timeout",
  "network",
  "authRequired",
  "httpError",
  "invalidResponse",
  "reconnectExhausted",
];
const listFinishes = [];
for (const outcome of [
  { done: {} },
  { cancelled: {} },
  { failed: { code: absent, httpStatus: absent, detail: absent } },
  ...codes.map((code) => ({
    failed: { code: { value: code }, httpStatus: absent, detail: absent },
  })),
]) {
  const request = { request: { endpoint: optional(pick(endpoints)) }, outcome };
  listFinishes.push({
    requestJson: encodeProjectCameraListFinish(request),
    replyJson: encodeProjectCameraListResult(
      await answerCameraListFinish(request),
    ),
  });
}

// Cameras as the listings read them, and every rate and service by hand.
const base = {
  uid: units("cam"),
  name: units("Cam"),
  service: "ipstream",
  enabled: true,
  snapshotPath: absent,
  snapshotUrl: absent,
  streamPath: absent,
  targetFps: 2,
  rotationDegrees: 0,
  flipHorizontal: false,
  flipVertical: false,
  unsupportedReason: absent,
};
const synthetic = [];
for (const targetFps of [0.1, 0.2, 1 / 3, 2, 2.5, 4, 30, 1e300, 1e-300])
  synthetic.push({
    ...base,
    targetFps,
    snapshotPath: optional("/webcam/?action=snapshot"),
  });
for (const service of [
  "mjpegstreamer",
  "mjpegstreamerAdaptive",
  "uv4lMjpeg",
  "hlsstream",
  "webrtcCamerastreamer",
  "webrtcGo2rtc",
  "webrtcMediamtx",
  "unknown",
])
  synthetic.push({
    ...base,
    service,
    snapshotUrl: optional("http://printer.local:8080/?action=snapshot"),
  });
synthetic.push(
  { ...base, unsupportedReason: optional("Only a stream.") },
  { ...base },
  {
    ...base,
    snapshotUrl: optional(
      "https://printer.local/s?a=1&orcaxr_frame=old&b=2&orcaxr_frame=x",
    ),
    snapshotPath: optional("/s"),
  },
  {
    ...base,
    snapshotUrl: optional("http://printer.local:8080/snap?q=a+b%20c&ü=1#f"),
  },
  { ...base, snapshotUrl: optional("not a url"), snapshotPath: optional("/p") },
);
const allCameras = [...cameras.values(), ...synthetic];
const mechanismsOf = ["image", "direct", "transport"];
const snapshotPlans = [];
const snapshotFailures = [];
const mechanismCases = [];
const describeCases = [];
const pollCases = [];
const frameCases = [];
const outcomes = [
  { cancelled: {} },
  { status: 404 },
  { status: 503.5 },
  { timeout: {} },
  { unreachable: units("Failed to fetch") },
  { transport: absent },
  { transport: { value: "httpError" } },
  { transport: { value: "cancelled" } },
];
for (const camera of allCameras) {
  for (const mechanism of [undefined, pick(mechanismsOf), pick(mechanismsOf)]) {
    const request = {
      camera,
      mechanism: mechanism === undefined ? absent : { value: mechanism },
    };
    snapshotPlans.push({
      requestJson: encodeProjectCameraSnapshotRequest(request),
      replyJson: encodeProjectCameraSnapshotPlan(
        answerCameraSnapshotPlan(request),
      ),
    });
    const finish = { request, outcome: pick(outcomes) };
    snapshotFailures.push({
      requestJson: encodeProjectCameraSnapshotFinish(finish),
      replyJson: encodeProjectCameraFailure(
        answerCameraSnapshotFailure(finish),
      ),
    });
  }
  for (const pageProtocol of [undefined, "https:", "http:", "file:"]) {
    const request = { camera, pageProtocol: optional(pageProtocol) };
    mechanismCases.push({
      requestJson: encodeProjectCameraMechanismsRequest(request),
      replyJson: encodeProjectCameraMechanisms(answerCameraMechanisms(request)),
    });
  }
  for (const route of [undefined, pick(mechanismsOf)]) {
    const request = {
      camera,
      route: route === undefined ? absent : { value: route },
      pageProtocol: optional(pick([undefined, "https:", "http:"])),
    };
    describeCases.push({
      requestJson: encodeProjectCameraDescribeRequest(request),
      replyJson: encodeProjectPrinterText(answerCameraDescribe(request)),
    });
  }
  pollCases.push({
    requestJson: encodeProjectPrinterCamera(camera),
    intervalMs: answerCameraPollInterval(camera),
  });
  const request = {
    camera,
    nonce: units(pick(["1700000000000", "a b", "ü&=", "", "x\uD800"])),
  };
  frameCases.push({
    requestJson: encodeProjectCameraFrameRequest(request),
    replyJson: encodeProjectOptionalPrinterReplyText(
      answerCameraFrameUrl(request),
    ),
  });
}

const sources = [
  "tools/cross-platform/printer-camera-vectors.mjs",
  "web/src/printer/PrinterCameraExchange.ts",
  "web/src/printer/PrinterCamera.ts",
  "web/src/printer/PrinterWire.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const corpus = {
  listReads,
  listFinishes,
  snapshotPlans,
  snapshotFailures,
  mechanisms: mechanismCases,
  describes: describeCases,
  pollIntervals: pollCases,
  frameUrls: frameCases,
};
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    listPlan: { replyJson: encodeProjectPrinterSend(answerCameraListPlan()) },
    ...corpus,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-camera-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer camera reference drift",
  );
console.log(
  `Printer camera references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
