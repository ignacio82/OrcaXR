// Moonraker transport references from the production browser
// (`MoonrakerTransportExchange.ts` driving `MoonrakerTransport.ts`): every
// input a host gives the transport — create, connect, disconnect, dispose,
// credentials, the object subscription, requests, uploads, downloads,
// recovery commands, caller aborts, each request's and body's answer, socket
// events, timers — with the outputs, cleared timers, aborted requests,
// diagnostics and state after it. Scenarios cover the browser's own
// transport tests and more: handshakes refused every way, sockets that never
// open, heartbeats answered, refused and timed out, reconnect backoff to
// exhaustion, requests across a socket blink, deadlines and body deadlines,
// size bounds, refused responses, notifications of every shape, and seeded
// random interleavings. Replayed by Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MoonrakerTransportRecorder } from "../../web/src/printer/MoonrakerTransportExchange.ts";
import {
  encodeProjectMoonrakerConnectionState,
  encodeProjectMoonrakerCredentials,
  encodeProjectMoonrakerObjectSubscription,
  encodeProjectMoonrakerRecoveryRequest,
  encodeProjectMoonrakerRequest,
  encodeProjectMoonrakerTransportConfig,
  encodeProjectMoonrakerTransportFault,
  encodeProjectMoonrakerTransportOutcome,
  encodeProjectMoonrakerTransportReply,
  encodeProjectMoonrakerTransportStep,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const fromUnits = (value) => String.fromCharCode(...value);
const absent = { absent: {} };
const text = (value) =>
  value === undefined ? absent : { value: units(value) };
const number = (value) => (value === undefined ? absent : { value });
const kindOf = (value) => Object.keys(value)[0];

const SERVER_INFO = {
  api_version: [1, 0, 5],
  moonraker_version: "v0.9.3-1",
  components: [
    "authorization",
    "file_manager",
    "history",
    "job_queue",
    "klippy_apis",
    "webcam",
    "u1_ext",
  ],
  warnings: [],
};
const PRINTER_INFO = {
  state: "ready",
  hostname: "u1-workshop",
  software_version: "v0.12.0",
};

function config(overrides = {}) {
  const policy = overrides.reconnect ?? {
    initialDelayMs: 10,
    maximumDelayMs: 25,
    maximumAttempts: 3,
    jitterRatio: 0,
  };
  return {
    endpoint: units(overrides.endpoint ?? "printer.local"),
    defaultPort: number(overrides.defaultPort),
    sameOriginProxy: text(overrides.sameOriginProxy),
    pageOrigin: text(overrides.pageOrigin),
    versionPolicy: {
      minimum:
        overrides.minimum === undefined ? absent : { value: overrides.minimum },
      maximumMajor: number(overrides.maximumMajor),
    },
    clientName: text(overrides.clientName),
    clientVersion: text(overrides.clientVersion ?? "test"),
    requestTimeoutMs: number(
      "requestTimeoutMs" in overrides ? overrides.requestTimeoutMs : 1000,
    ),
    socketOpenTimeoutMs: number(
      "socketOpenTimeoutMs" in overrides ? overrides.socketOpenTimeoutMs : 500,
    ),
    heartbeatIntervalMs: number(
      "heartbeatIntervalMs" in overrides ? overrides.heartbeatIntervalMs : 100,
    ),
    heartbeatTimeoutMs: number(
      "heartbeatTimeoutMs" in overrides ? overrides.heartbeatTimeoutMs : 20,
    ),
    reconnect: {
      initialDelayMs: number(policy.initialDelayMs),
      maximumDelayMs: number(policy.maximumDelayMs),
      maximumAttempts: number(policy.maximumAttempts),
      jitterRatio: number(policy.jitterRatio),
    },
  };
}
const options = (overrides = {}) => ({
  method: text(overrides.method),
  operation: text(overrides.operation),
  timeoutMs:
    overrides.timeoutMs === undefined
      ? { default: {} }
      : overrides.timeoutMs === null
        ? { unbounded: {} }
        : { ms: overrides.timeoutMs },
  headers: Object.entries(overrides.headers ?? {}).map(([name, value]) => ({
    name: units(name),
    value: units(value),
  })),
  acceptBareEnvelope: overrides.acceptBareEnvelope ?? false,
  signal: overrides.signal ?? "none",
});
const req = (path, overrides) => ({
  path: units(path),
  options: options(overrides),
});
const envelope = (result) => JSON.stringify({ result });

// --- A scripted Moonraker -----------------------------------------------------------------
function moonraker(overrides = {}) {
  return {
    server: SERVER_INFO,
    printer: PRINTER_INFO,
    socket: "created",
    random: 0.5,
    // (path, method, model) => { status, body, contentLength } | "fail" | "hold" | undefined
    route: () => undefined,
    // When a body read is answered: "fail" or a length for bytes.
    bodyFail: () => false,
    ...overrides,
  };
}
function reply(model, fetch) {
  const url = new URL(fromUnits(fetch.url));
  const method = fromUnits(fetch.method);
  const custom = model.route(url.pathname + url.search, method, model, fetch);
  if (custom !== undefined) return custom;
  if (url.pathname.endsWith("/server/info"))
    return { status: 200, body: envelope(model.server) };
  if (url.pathname.endsWith("/printer/info"))
    return { status: 200, body: envelope(model.printer) };
  if (url.pathname.endsWith("/server/files/upload"))
    return {
      status: 201,
      body: JSON.stringify({
        item: { path: "a.gcode" },
        action: "create_file",
      }),
    };
  if (url.pathname.includes("/server/files/gcodes/"))
    return { status: 200, bytes: 4096, contentLength: "4096" };
  return { status: 200, body: envelope({ ok: true }) };
}

function harness(model, configOverrides) {
  const recorder = new MoonrakerTransportRecorder({
    socket: () => model.socket,
    random: () => model.random,
  });
  let clock = 1_000;
  const bodies = new Map();
  const h = {
    recorder,
    model,
    get now() {
      return clock;
    },
    tick(ms = 1) {
      clock += ms;
      return clock;
    },
    create() {
      recorder.create(config(configOverrides), h.tick());
    },
    /** Answer effect `id` the way the model says, holding it if asked to. */
    async answer(id) {
      const effect = recorder.effect(id);
      if (!effect) throw new Error(`no effect ${id}`);
      if ("fetch" in effect) {
        const r = reply(model, effect.fetch);
        if (r === "hold") return false;
        if (r === "fail") {
          await recorder.resolve(id, { failed: {} }, h.tick());
          return true;
        }
        bodies.set(id, r);
        await recorder.resolve(
          id,
          {
            headers: { status: r.status, contentLength: text(r.contentLength) },
          },
          h.tick(),
        );
        return true;
      }
      const r = bodies.get(effect.readBody.fetch);
      if (r === undefined || model.bodyFail(effect.readBody, model)) {
        await recorder.resolve(id, { failed: {} }, h.tick());
      } else if (effect.readBody.kind === "bytes") {
        await recorder.resolve(
          id,
          { bytes: r.bytes ?? (r.body ?? "").length },
          h.tick(),
        );
      } else {
        await recorder.text(id, r.body ?? "", h.tick());
      }
      return true;
    },
    /** Answer everything pending, oldest first, until nothing is or only held effects remain. */
    async serve(stop = () => false) {
      for (let guard = 0; guard < 400; guard++) {
        const pending = recorder.pending();
        let progressed = false;
        for (const { id } of pending) {
          if (stop(recorder.effect(id))) continue;
          if (await h.answer(id)) {
            progressed = true;
            break;
          }
        }
        if (!progressed) return;
      }
      throw new Error("the transport never settles");
    },
    lastSocket() {
      return recorder.socketIds().at(-1);
    },
    /** Connect, open the socket, and settle: a live transport. */
    async ready(signal = "none") {
      await recorder.connect(signal, h.tick());
      await h.serve();
      await recorder.socketEvent("socketOpen", h.lastSocket(), h.tick());
      await h.serve();
    },
    /** Fire the live timer armed with `delayMs` (the newest such). */
    async fire(delayMs) {
      const timers = recorder.liveTimers();
      const armed = [];
      for (const record of recorder.records)
        for (const output of record.step?.outputs ?? [])
          if ("setTimer" in output) armed.push(output.setTimer);
      const timer = armed
        .filter((t) => t.delayMs === delayMs && timers.includes(t.timer))
        .at(-1);
      assert.ok(timer, `a live ${delayMs} ms timer`);
      clock += delayMs;
      await recorder.timer(timer.timer, clock);
    },
    sentHeartbeat() {
      for (let i = recorder.records.length - 1; i >= 0; i--)
        for (const output of [
          ...(recorder.records[i].step?.outputs ?? []),
        ].reverse())
          if ("socketSend" in output) {
            const message = JSON.parse(fromUnits(output.socketSend.text));
            if (message.method === "server.info") return message.id;
          }
      return undefined;
    },
  };
  return h;
}

function encodeInput(input) {
  const [kind, value] = Object.entries(input)[0];
  switch (kind) {
    case "create":
      return { create: encodeProjectMoonrakerTransportConfig(value) };
    case "credentials":
      return { credentials: encodeProjectMoonrakerCredentials(value) };
    case "subscription":
      return {
        subscription:
          value === null
            ? null
            : encodeProjectMoonrakerObjectSubscription(value),
      };
    case "request":
    case "upload":
    case "download":
      return { [kind]: encodeProjectMoonrakerRequest(value) };
    case "recovery":
      return { recovery: encodeProjectMoonrakerRecoveryRequest(value) };
    case "resolve":
      return {
        resolve: {
          id: value.id,
          outcome: encodeProjectMoonrakerTransportOutcome(value.outcome),
        },
      };
    default:
      return { [kind]: value };
  }
}
function encodeRecord(record) {
  const out = { now: record.now, input: encodeInput(record.input) };
  if (record.step) out.step = encodeProjectMoonrakerTransportStep(record.step);
  if (record.state)
    out.state = encodeProjectMoonrakerConnectionState(record.state);
  if (record.reply)
    out.reply = encodeProjectMoonrakerTransportReply(record.reply);
  if (record.refused !== undefined)
    out.refused =
      typeof record.refused === "string"
        ? record.refused
        : encodeProjectMoonrakerTransportFault(record.refused);
  if (record.hasApiKey !== undefined) {
    out.hasApiKey = record.hasApiKey;
    out.hasBearerToken = record.hasBearerToken;
  }
  if (record.results) out.results = record.results;
  if (record.params) out.params = record.params;
  return out;
}

const scenarios = [];
async function scenario(name, run, model = moonraker(), configOverrides = {}) {
  const h = harness(model, configOverrides);
  h.create();
  if (h.recorder.transport) await run(h);
  scenarios.push({ name, records: h.recorder.records.map(encodeRecord) });
  return h;
}
const subscription = (object) =>
  Object.entries(object).map(([name, fields]) => ({
    name: units(name),
    fields: fields === null ? absent : { value: fields.map(units) },
  }));

// --- The browser's own transport tests ----------------------------------------------------------
await scenario(
  "connects with credentials and a subscription, answers a heartbeat, and disposes",
  async (h) => {
    const r = h.recorder;
    r.credentials(
      { apiKey: text("session-only-super-secret"), bearerToken: absent },
      h.tick(),
    );
    await r.subscription(
      subscription({ print_stats: ["filename", "state"], toolhead: null }),
      h.tick(),
    );
    await h.ready();
    await r.request(
      req("/server/info?opaque=session-only-super-secret"),
      h.tick(),
    );
    await r.request(req("/server/info", { signal: "aborted" }), h.tick());
    await h.fire(100);
    await r.socketMessage(
      h.lastSocket(),
      JSON.stringify({
        jsonrpc: "2.0",
        id: h.sentHeartbeat(),
        result: SERVER_INFO,
      }),
      h.tick(),
    );
    await r.dispose(h.tick());
    r.clearCredentials(h.tick());
  },
);

await scenario("a heartbeat that times out reconnects", async (h) => {
  await h.ready();
  await h.fire(100);
  await h.fire(20);
  await h.fire(10);
  await h.serve();
  await h.recorder.socketEvent("socketOpen", h.lastSocket(), h.tick());
  await h.serve();
  await h.recorder.dispose(h.tick());
});

await scenario(
  "reconnects back off to exhaustion and ignore the retired socket",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    const first = h.lastSocket();
    await r.socketEvent("socketClose", first, h.tick());
    await r.socketMessage(
      first,
      JSON.stringify({ method: "notify_stale", params: [] }),
      h.tick(),
    );
    for (const delay of [10, 20, 25]) {
      await h.fire(delay);
      await h.serve();
      await r.socketEvent("socketError", h.lastSocket(), h.tick());
      await h.serve();
    }
    await r.dispose(h.tick());
  },
);

await scenario(
  "a refused handshake keeps secrets and addresses out of state and diagnostics",
  async (h) => {
    h.recorder.credentials(
      { apiKey: text("session-only-secret"), bearerToken: absent },
      h.tick(),
    );
    await h.recorder.connect("none", h.tick());
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.endsWith("/server/info")
        ? {
            status: 403,
            body: "api key=session-only-secret at http://10.0.0.5/private",
          }
        : undefined,
  }),
);

await scenario(
  "an unsupported API version fails before any socket",
  async (h) => {
    await h.recorder.connect("none", h.tick());
    await h.serve();
  },
  moonraker({ server: { ...SERVER_INFO, api_version: [2, 0, 0] } }),
);

await scenario(
  "a caller abort cancels a connect in flight",
  async (h) => {
    await h.recorder.connect("live", h.tick());
    await h.recorder.abort(1, h.tick());
    await h.serve();
  },
  moonraker({ route: () => "hold" }),
);

await scenario(
  "a mutation in flight when the socket drops is the printer's to answer",
  async (h) => {
    await h.ready();
    await h.recorder.request(
      req("/printer/print/start", { method: "POST", operation: "start_print" }),
      h.tick(),
    );
    await h.recorder.socketEvent("socketClose", h.lastSocket(), h.tick());
    h.model.route = () => undefined;
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.startsWith("/printer/print/start") ? "hold" : undefined,
  }),
);

await scenario(
  "answers nothing awaits, or of another kind, are refused",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    const socket = r.socketIds().at(-1);
    await r.request(
      req("/printer/objects/query", { operation: "print_readiness" }),
      h.tick(),
    );
    const [{ id: fetch }] = r.pending();
    await r.resolve(1_000_000, { failed: {} }, h.tick());
    for (const outcome of [
      { bytes: 3 },
      { random: 0.5 },
      { created: {} },
      { unavailable: {} },
      { broken: {} },
    ])
      await r.resolve(fetch, outcome, h.tick());
    await r.text(fetch, envelope({ ok: true }), h.tick());
    await r.resolve(socket, { created: {} }, h.tick());
    await r.resolve(
      fetch,
      { headers: { status: 200, contentLength: absent } },
      h.tick(),
    );
    const [{ id: body }] = r.pending();
    await r.resolve(
      body,
      { headers: { status: 200, contentLength: absent } },
      h.tick(),
    );
    await r.resolve(body, { random: 0.25 }, h.tick());
    await r.resolve(body, { bytes: 11 }, h.tick());
    await r.text(body, envelope({ ok: true }), h.tick());
    await r.text(body, envelope({ ok: true }), h.tick());
    await r.resolve(fetch, { failed: {} }, h.tick());
    // A body read as bytes is answered by its length, never by text.
    await r.download(
      req("/server/files/gcodes/a.gcode", { operation: "download" }),
      h.tick(),
    );
    const [{ id: download }] = r.pending();
    await r.resolve(
      download,
      { headers: { status: 200, contentLength: text("4") } },
      h.tick(),
    );
    const [{ id: bytes }] = r.pending();
    await r.text(bytes, "abcd", h.tick());
    await r.resolve(
      bytes,
      { headers: { status: 200, contentLength: absent } },
      h.tick(),
    );
    await r.resolve(bytes, { bytes: 4 }, h.tick());
    await r.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.startsWith("/printer/objects/query") || path.includes("/gcodes/")
        ? "hold"
        : undefined,
  }),
);

// Bindings pass at most MAX_TEXT_UNITS + 1 units of a text (replays cut these
// down): a reply and a refusal's detail must come out as the browser's.
const pastEveryBound = 2 * 1024 * 1024 + 4096;
await scenario(
  "text past every bound decides by its length alone",
  async (h) => {
    await h.ready();
    await h.recorder.request(
      req("/server/long", { operation: "long_reply" }),
      h.tick(),
    );
    await h.serve();
    await h.recorder.request(
      req("/server/refused", { operation: "refused_reply" }),
      h.tick(),
    );
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.startsWith("/server/long")
        ? { status: 200, body: envelope("x".repeat(pastEveryBound)) }
        : path.startsWith("/server/refused")
          ? {
              status: 403,
              body: `the printer refuses: ${"y".repeat(pastEveryBound)}`,
            }
          : undefined,
  }),
);

// Replies and notification params travel beside a step, so none is too large
// to cross a binding: these are past the contract's 131,072 units per text.
const macros = Object.fromEntries(
  Array.from({ length: 2000 }, (_, i) => [
    `gcode_macro m${i}`,
    { gcode: `G1 X${i}\nG1 Y${i}\n${"; ".repeat(40)}` },
  ]),
);
await scenario(
  "a large reply and a large notification travel beside the step",
  async (h) => {
    const r = h.recorder;
    await r.subscription(subscription({ configfile: null }), h.tick());
    await h.ready();
    await r.request(
      req("/printer/objects/query?configfile", { operation: "printer_macros" }),
      h.tick(),
    );
    await h.serve();
    await r.socketMessage(
      h.lastSocket(),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notify_status_update",
        params: [{ configfile: { settings: macros } }, 12.5],
      }),
      h.tick(),
    );
    await r.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.startsWith("/printer/objects/query")
        ? {
            status: 200,
            body: envelope({ status: { configfile: { settings: macros } } }),
          }
        : undefined,
  }),
);

// A server listing more components than Moonraker has is refused.
for (const count of [256, 257])
  await scenario(
    `a handshake listing ${count} components`,
    async (h) => {
      await h.recorder.connect("none", h.tick());
      await h.serve();
      const socket = h.lastSocket();
      if (socket !== undefined) {
        await h.recorder.socketEvent("socketOpen", socket, h.tick());
        await h.serve();
      }
      await h.recorder.dispose(h.tick());
    },
    moonraker({
      server: {
        ...SERVER_INFO,
        components: Array.from({ length: count }, (_, i) => `component_${i}`),
      },
    }),
  );

// Requests in flight are bounded, which bounds the step that ends them all.
await scenario(
  "requests in flight are bounded",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    for (let i = 0; i <= 512; i++)
      await r.request(
        req(`/server/held?i=${i}`, { operation: "held" }),
        h.tick(),
      );
    await r.dispose(h.tick());
  },
  moonraker({
    route: (path) => (path.startsWith("/server/held") ? "hold" : undefined),
  }),
);

const holdUpload = (path) =>
  path.endsWith("/server/files/upload") ? "hold" : undefined;

await scenario(
  "work in flight ends with a session whose reconnects are exhausted",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    await r.upload(
      req("/server/files/upload", { operation: "upload_gcode" }),
      h.tick(),
    );
    await r.socketEvent("socketClose", h.lastSocket(), h.tick());
    for (const delay of [10, 20, 25]) {
      await h.fire(delay);
      await h.serve();
      await r.socketEvent("socketError", h.lastSocket(), h.tick());
      await h.serve();
    }
    await r.dispose(h.tick());
  },
  moonraker({ route: holdUpload }),
);

await scenario(
  "work in flight ends with a session whose reconnect is refused",
  async (h) => {
    await h.ready();
    await h.recorder.upload(
      req("/server/files/upload", { operation: "upload_gcode" }),
      h.tick(),
    );
    h.model.route = (path) =>
      path.endsWith("/server/info")
        ? { status: 403, body: "" }
        : holdUpload(path);
    await h.recorder.socketEvent("socketClose", h.lastSocket(), h.tick());
    await h.fire(10);
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
  moonraker({ route: holdUpload }),
);

await scenario(
  "queries and uploads still answer while the socket reconnects",
  async (h) => {
    await h.ready();
    await h.recorder.socketEvent("socketClose", h.lastSocket(), h.tick());
    await h.recorder.request(
      req("/printer/objects/query", { operation: "print_readiness" }),
      h.tick(),
    );
    await h.serve();
    await h.recorder.upload(
      req("/server/files/upload", { operation: "upload_gcode" }),
      h.tick(),
    );
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
);

await scenario(
  "an upload that finishes across a socket blink is kept",
  async (h) => {
    await h.ready();
    await h.recorder.upload(
      req("/server/files/upload", { operation: "upload_gcode" }),
      h.tick(),
    );
    h.model.route = () => undefined;
    await h.recorder.socketEvent("socketClose", h.lastSocket(), h.tick());
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.endsWith("/server/files/upload") ? "hold" : undefined,
  }),
);

await scenario(
  "request deadlines are the payload's, and unbounded means unarmed",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    await r.upload(
      req("/server/files/upload", {
        operation: "upload_gcode",
        timeoutMs: 526_400,
      }),
      h.tick(),
    );
    await h.serve();
    await r.upload(
      req("/server/files/upload", {
        operation: "upload_gcode",
        timeoutMs: null,
      }),
      h.tick(),
    );
    await h.serve();
    await r.request(
      req("/printer/info", { operation: "probe", timeoutMs: -1 }),
      h.tick(),
    );
    await r.request(
      req("/printer/info", { operation: "probe", timeoutMs: 3_600_001 }),
      h.tick(),
    );
    await r.request(
      req("/printer/info", { operation: "probe", timeoutMs: 1.9 }),
      h.tick(),
    );
    await h.serve();
    await r.dispose(h.tick());
  },
);

await scenario(
  "a mutation sent as a GET is refused before it leaves",
  async (h) => {
    await h.ready();
    for (const path of [
      "/printer/print/start?filename=plate.gcode",
      "/printer/print/pause",
      "/printer/emergency_stop",
      "/printer/gcode/script?script=M117",
      "/server/files/move?source=gcodes/a&dest=gcodes/b",
    ]) {
      await h.recorder.request(req(path, { operation: "probe" }), h.tick());
      await h.recorder.request(
        req(path, { operation: "probe", method: "POST" }),
        h.tick(),
      );
      await h.serve();
    }
    await h.recorder.dispose(h.tick());
  },
);

await scenario(
  "a failure the server explained keeps its explanation",
  async (h) => {
    await h.ready();
    await h.recorder.request(
      req("/printer/print/start?filename=plate.gcode", {
        operation: "x",
        method: "POST",
      }),
      h.tick(),
    );
    await h.serve();
    await h.recorder.dispose(h.tick());
  },
  moonraker({
    route: (path) =>
      path.startsWith("/printer/print/start")
        ? {
            status: 400,
            body: JSON.stringify({
              error: { code: 400, message: "Klippy is not ready" },
            }),
          }
        : undefined,
  }),
);

await scenario(
  "recovery reaches HTTP without a handshake and keeps its guards",
  async (h) => {
    const r = h.recorder;
    r.credentials(
      { apiKey: text("synthetic-recovery-test-key"), bearerToken: absent },
      h.tick(),
    );
    for (const command of ["emergency-stop", "firmware-restart"]) {
      await r.recovery({ command: units(command), signal: "none" }, h.tick());
      await h.serve();
    }
    await r.recovery({ command: units("pause"), signal: "none" }, h.tick());
    await r.recovery(
      { command: units("emergency-stop"), signal: "aborted" },
      h.tick(),
    );
    await r.recovery(
      { command: units("emergency-stop"), signal: "live" },
      h.tick(),
    );
    await r.abort(5, h.tick());
    await r.dispose(h.tick());
    await r.recovery(
      { command: units("emergency-stop"), signal: "none" },
      h.tick(),
    );
  },
);

// --- Configurations -----------------------------------------------------------------------------
for (const [name, overrides] of [
  ["an invalid endpoint", { endpoint: "http://user:pw@printer.local" }],
  ["a zero request timeout", { requestTimeoutMs: 0 }],
  ["a request timeout past five minutes", { requestTimeoutMs: 300_001 }],
  ["a fractional heartbeat", { heartbeatIntervalMs: 99.7 }],
  ["a negative socket timeout", { socketOpenTimeoutMs: -5 }],
  [
    "an inverted reconnect policy",
    { reconnect: { initialDelayMs: 50, maximumDelayMs: 10 } },
  ],
  ["too many reconnect attempts", { reconnect: { maximumAttempts: 40 } }],
  ["an impossible version policy", { minimum: [2, 0, 0], maximumMajor: 1 }],
  ["a client name with symbols", { clientName: "OrcaXR <script>" }],
  [
    "a proxied endpoint",
    {
      sameOriginProxy: "/api/moonraker/u1",
      pageOrigin: "https://orcaxr.example/slicer/",
    },
  ],
  [
    "a defaulted configuration",
    {
      requestTimeoutMs: undefined,
      socketOpenTimeoutMs: undefined,
      heartbeatIntervalMs: undefined,
      heartbeatTimeoutMs: undefined,
      reconnect: {},
      clientVersion: "9.9.9",
    },
  ],
])
  await scenario(
    `a transport with ${name}`,
    async (h) => {
      await h.recorder.request(req("/server/info"), h.tick());
      await h.recorder.connect("none", h.tick());
      await h.serve();
      if (h.lastSocket())
        await h.recorder.socketEvent("socketOpen", h.lastSocket(), h.tick());
      await h.serve();
      await h.recorder.dispose(h.tick());
    },
    moonraker(),
    overrides,
  );

// --- Connections --------------------------------------------------------------------------------
await scenario("connect while connecting and while connected", async (h) => {
  const r = h.recorder;
  await r.connect("none", h.tick());
  await r.connect("none", h.tick());
  await h.serve();
  await r.socketEvent("socketOpen", h.lastSocket(), h.tick());
  await h.serve();
  await r.connect("none", h.tick());
  await r.disconnect("user", h.tick());
  await r.disconnect("user", h.tick());
  await r.connect("aborted", h.tick());
  await r.connect("none", h.tick());
  await h.serve();
  await r.socketEvent("socketOpen", h.lastSocket(), h.tick());
  await r.disconnect("cancelled", h.tick());
  await r.dispose(h.tick());
  await r.dispose(h.tick());
  await r.connect("none", h.tick());
  await r.request(req("/server/info"), h.tick());
});

for (const [name, model] of [
  ["a socket the platform cannot make", moonraker({ socket: "unavailable" })],
  ["a socket constructor that throws", moonraker({ socket: "broken" })],
])
  await scenario(
    name,
    async (h) => {
      await h.recorder.connect("none", h.tick());
      await h.serve();
    },
    model,
  );

await scenario("a socket that never opens times out", async (h) => {
  await h.recorder.connect("none", h.tick());
  await h.serve();
  await h.fire(500);
  await h.serve();
});

await scenario("a socket that errors, or closes, before opening", async (h) => {
  const r = h.recorder;
  await r.connect("none", h.tick());
  await h.serve();
  await r.socketEvent("socketError", h.lastSocket(), h.tick());
  await r.connect("none", h.tick());
  await h.serve();
  await r.socketEvent("socketClose", h.lastSocket(), h.tick());
  await r.connect("none", h.tick());
  await h.serve();
  await r.disconnect("user", h.tick());
  await r.socketEvent("socketOpen", h.lastSocket(), h.tick());
});

for (const [name, route] of [
  [
    "a network failure",
    (path) => (path.endsWith("/printer/info") ? "fail" : undefined),
  ],
  [
    "a reply that is not JSON",
    (path) =>
      path.endsWith("/server/info")
        ? { status: 200, body: "<html>" }
        : undefined,
  ],
  [
    "a reply that is not an envelope",
    (path) =>
      path.endsWith("/server/info") ? { status: 200, body: "[1]" } : undefined,
  ],
  [
    "an error envelope",
    (path) =>
      path.endsWith("/server/info")
        ? { status: 200, body: JSON.stringify({ error: { message: "x" } }) }
        : undefined,
  ],
  [
    "an envelope without a result",
    (path) =>
      path.endsWith("/printer/info") ? { status: 200, body: "{}" } : undefined,
  ],
  [
    "a declared body past two MiB",
    (path) =>
      path.endsWith("/server/info")
        ? { status: 200, body: envelope(SERVER_INFO), contentLength: "2097153" }
        : undefined,
  ],
  [
    "a body past two MiB",
    (path) =>
      path.endsWith("/server/info")
        ? { status: 200, body: "x".repeat(2 * 1024 * 1024 + 1) }
        : undefined,
  ],
  [
    "an authentication demand",
    (path) =>
      path.endsWith("/server/info") ? { status: 401, body: "" } : undefined,
  ],
  [
    "a server error",
    (path) =>
      path.endsWith("/server/info") ? { status: 503, body: "busy" } : undefined,
  ],
  [
    "a malformed server handshake",
    (path) =>
      path.endsWith("/server/info")
        ? { status: 200, body: envelope({ api_version: "x", components: [] }) }
        : undefined,
  ],
])
  await scenario(
    `a handshake with ${name}`,
    async (h) => {
      await h.recorder.connect("none", h.tick());
      await h.serve();
    },
    moonraker({ route }),
  );

await scenario(
  "a body read that fails",
  async (h) => {
    await h.recorder.connect("none", h.tick());
    await h.serve();
  },
  moonraker({ bodyFail: (read) => read.kind === "text" }),
);

await scenario(
  "a request timeout, and a body deadline sized by its length",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    h.model.route = (path) =>
      path.startsWith("/printer/objects") ? "hold" : undefined;
    await r.request(
      req("/printer/objects/query", { operation: "slow" }),
      h.tick(),
    );
    await h.fire(1000);
    // JSON past 2 MiB is refused outright; a download gets time to match its length.
    h.model.route = (path) =>
      path.includes("/gcodes/")
        ? { status: 200, bytes: 5242880, contentLength: "5242880" }
        : undefined;
    await r.download(req("/server/files/gcodes/big.gcode"), h.tick());
    await h.serve((effect) => "readBody" in effect);
    await h.fire(20000);
    h.model.route = (path) =>
      path.startsWith("/server/history")
        ? { status: 200, body: envelope({}), contentLength: " 12 " }
        : undefined;
    await r.request(req("/server/history/list"), h.tick());
    await h.serve();
    await r.dispose(h.tick());
  },
);

await scenario("downloads within and past their bound", async (h) => {
  const r = h.recorder;
  await h.ready();
  await r.download(req("/server/files/gcodes/a.gcode"), h.tick());
  await h.serve();
  h.model.route = (path) =>
    path.includes("/gcodes/big")
      ? { status: 200, bytes: 1, contentLength: String(256 * 1024 * 1024 + 1) }
      : undefined;
  await r.download(req("/server/files/gcodes/big.gcode"), h.tick());
  await h.serve();
  h.model.route = (path) =>
    path.includes("/gcodes/huge")
      ? { status: 200, bytes: 256 * 1024 * 1024 + 1 }
      : undefined;
  await r.download(req("/server/files/gcodes/huge.gcode"), h.tick());
  await h.serve();
  h.model.route = (path) =>
    path.includes("/gcodes/missing")
      ? { status: 404, body: '{"error":"File not found"}' }
      : undefined;
  await r.download(
    req("/server/files/gcodes/missing.gcode", { signal: "live" }),
    h.tick(),
  );
  await h.serve();
  await r.dispose(h.tick());
});

await scenario("headers a caller may and may not set", async (h) => {
  const r = h.recorder;
  await h.ready();
  await r.request(
    req("/server/info", {
      headers: { "X-Trace": "abc", accept: "text/plain" },
    }),
    h.tick(),
  );
  await h.serve();
  await r.request(
    req("/server/info", { headers: { authorization: "Bearer x" } }),
    h.tick(),
  );
  await r.request(
    req("/server/info", { headers: { "x-api-key": "k" } }),
    h.tick(),
  );
  r.credentials({ apiKey: absent, bearerToken: text("tok") }, h.tick());
  await r.request(req("/server/info?x=Bearer%20tok"), h.tick());
  await r.request(req("/server/info"), h.tick());
  await h.serve();
  r.credentials({ apiKey: text("a"), bearerToken: text("b") }, h.tick());
  await r.request(req("/server/info"), h.tick());
  await h.serve();
  await r.dispose(h.tick());
});

await scenario(
  "a caller abort during a request and during its body",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    h.model.route = () => "hold";
    await r.request(req("/printer/info", { signal: "live" }), h.tick());
    await r.abort(2, h.tick());
    h.model.route = () => undefined;
    await r.request(req("/printer/info", { signal: "live" }), h.tick());
    await h.serve((effect) => "readBody" in effect);
    await r.abort(3, h.tick());
    await h.serve();
    await r.dispose(h.tick());
  },
);

// --- The live socket --------------------------------------------------------------------------
await scenario("notifications of every shape", async (h) => {
  const r = h.recorder;
  await r.subscription(
    subscription({ webhooks: null, print_stats: ["state"] }),
    h.tick(),
  );
  await h.ready();
  const socket = h.lastSocket();
  const send = (value) =>
    r.socketMessage(
      socket,
      typeof value === "string" ? value : JSON.stringify(value),
      h.tick(),
    );
  await send({
    jsonrpc: "2.0",
    method: "notify_status_update",
    params: [{ print_stats: { state: "printing", b: 1, a: 2 } }, 12.5],
  });
  await send({
    jsonrpc: "2.0",
    method: "notify_gcode_response",
    params: ["ok"],
  });
  await send({ method: "notify history changed", params: [] });
  await send({ method: 7, params: [] });
  await send({ method: "x".repeat(129) });
  await send({ method: "notify_klippy_ready" });
  await send("not json");
  await send("[1,2]");
  await send("null");
  await send({
    method: "notify_big",
    params: Array.from({ length: 20_001 }, () => ({})),
  });
  await send({
    method: "notify_ok",
    params: Array.from({ length: 19_999 }, () => []),
  });
  await send("x".repeat(1024 * 1024 + 1));
  await send({
    method: "notify_x",
    params: { 10: 1, 2: 2, z: 3, a: [{ y: 1, x: 2 }] },
  });
  await send({
    method: "notify_numbers",
    params: [1e21, -0, 0.1, 1e-7, 2 ** 53],
  });
  await send('{"method":"notify_dup","params":{"a":1,"a":2},"id":null}');
  await send({ id: "orcaxr-heartbeat-unknown", result: {} });
  await r.subscription(null, h.tick());
  await r.subscription(
    subscription({ extruder: ["temperature", "target", "temperature"] }),
    h.tick(),
  );
  // Refused subscriptions keep the one before them, which the next socket
  // subscribes again. (`{ __proto__: null }` would be an empty literal.)
  const named = (name, fields = null) => [
    {
      name: units(name),
      fields: fields === null ? absent : { value: fields.map(units) },
    },
  ];
  for (const refused of [
    named("__proto__"),
    named("constructor"),
    named("bad name"),
    named("extruder", [""]),
    named("x".repeat(129)),
  ])
    await r.subscription(refused, h.tick());
  await r.socketEvent("socketClose", h.lastSocket(), h.tick());
  await h.fire(10);
  await h.serve();
  await r.socketEvent("socketOpen", h.lastSocket(), h.tick());
  await h.serve();
  await r.dispose(h.tick());
});

await scenario(
  "a heartbeat answered with an error is a lost socket",
  async (h) => {
    await h.ready();
    await h.fire(100);
    await h.recorder.socketMessage(
      h.lastSocket(),
      JSON.stringify({ id: h.sentHeartbeat(), error: { message: "x" } }),
      h.tick(),
    );
    await h.recorder.dispose(h.tick());
  },
);

await scenario(
  "a socket error while live, then a reconnect that the server refuses outright",
  async (h) => {
    await h.ready();
    h.model.route = (path) =>
      path.endsWith("/server/info") ? { status: 403, body: "" } : undefined;
    await h.recorder.socketEvent("socketError", h.lastSocket(), h.tick());
    await h.fire(10);
    await h.serve();
  },
);

await scenario(
  "a reconnect that loses its network recovers on the next attempt",
  async (h) => {
    await h.ready();
    h.model.route = (path) =>
      path.endsWith("/printer/info") ? "fail" : undefined;
    await h.recorder.socketEvent("socketClose", h.lastSocket(), h.tick());
    await h.fire(10);
    await h.serve();
    h.model.route = () => undefined;
    await h.fire(20);
    await h.serve();
    await h.recorder.socketEvent("socketOpen", h.lastSocket(), h.tick());
    await h.serve();
    await h.recorder.disconnect("user", h.tick());
  },
);

await scenario(
  "jittered backoff draws its randomness",
  async (h) => {
    h.model.random = 0.123;
    await h.ready();
    await h.recorder.socketEvent("socketClose", h.lastSocket(), h.tick());
    h.model.random = 0.987;
    await h.fire(h.recorder.records.at(-1).state.reconnecting.delayMs);
    await h.serve();
    await h.recorder.socketEvent("socketError", h.lastSocket(), h.tick());
    await h.recorder.dispose(h.tick());
  },
  moonraker(),
  {
    reconnect: {
      initialDelayMs: 100,
      maximumDelayMs: 5000,
      maximumAttempts: 4,
      jitterRatio: 0.4,
    },
  },
);

await scenario(
  "disconnecting during a reconnect wait and during a reconnect handshake",
  async (h) => {
    const r = h.recorder;
    await h.ready();
    await r.socketEvent("socketClose", h.lastSocket(), h.tick());
    await r.disconnect("user", h.tick());
    await h.ready();
    h.model.route = () => "hold";
    await r.socketEvent("socketClose", h.lastSocket(), h.tick());
    await h.fire(10);
    await r.disconnect("user", h.tick());
    h.model.route = () => undefined;
    await h.serve();
  },
);

// --- Seeded interleavings ---------------------------------------------------------------------
function random(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
for (let seed = 1; seed <= 30; seed++)
  await scenario(
    `seeded interleaving ${seed}`,
    async (h) => {
      const rand = random(seed * 2246822519);
      const pick = (list) => list[Math.floor(rand() * list.length)];
      const r = h.recorder;
      await h.ready();
      for (let step = 0; step < 40; step++) {
        const roll = rand();
        const pending = r.pending();
        const live = r.liveTimers();
        if (pending.length > 0 && roll < 0.35) {
          const { id } = pick(pending);
          const effect = r.effect(id);
          if (rand() < 0.15) await r.resolve(id, { failed: {} }, h.tick());
          else if ("readBody" in effect || !("fetch" in effect))
            await h.answer(id);
          else await h.answer(id);
        } else if (live.length > 0 && roll < 0.5) {
          const timer = pick(live);
          await r.timer(timer, h.tick(5));
        } else if (roll < 0.62) {
          await r.request(
            req(
              pick(["/server/info", "/printer/info", "/printer/objects/query"]),
              { signal: pick(["none", "live"]) },
            ),
            h.tick(),
          );
        } else if (roll < 0.66) {
          await r.upload(
            req("/server/files/upload", {
              timeoutMs: pick([undefined, null, 5000]),
            }),
            h.tick(),
          );
        } else if (roll < 0.72 && h.lastSocket()) {
          const socket = h.lastSocket();
          const event = pick([
            "socketOpen",
            "socketError",
            "socketClose",
            "message",
            "message",
            "heartbeat",
          ]);
          if (event === "message")
            await r.socketMessage(
              socket,
              JSON.stringify({
                method: "notify_status_update",
                params: [{ print_stats: { state: "printing" } }, step],
              }),
              h.tick(),
            );
          else if (event === "heartbeat") {
            const id = h.sentHeartbeat();
            if (id)
              await r.socketMessage(
                socket,
                JSON.stringify({ id, result: {} }),
                h.tick(),
              );
          } else await r.socketEvent(event, socket, h.tick());
        } else if (roll < 0.76) {
          const task = 1 + Math.floor(rand() * 12);
          await r.abort(task, h.tick());
        } else if (roll < 0.8) {
          await r.connect(pick(["none", "live"]), h.tick());
        } else if (roll < 0.83) {
          await r.disconnect(pick(["user", "cancelled"]), h.tick());
        } else if (roll < 0.86) {
          await r.recovery(
            {
              command: units(pick(["emergency-stop", "firmware-restart"])),
              signal: "none",
            },
            h.tick(),
          );
        } else if (roll < 0.88) {
          await r.subscription(
            subscription({ print_stats: null, extruder: ["temperature"] }),
            h.tick(),
          );
        } else {
          h.model.route = pick([
            () => undefined,
            () => undefined,
            (p) => (p.endsWith("/printer/info") ? "fail" : undefined),
            (p) =>
              p.endsWith("/server/info")
                ? { status: 500, body: "x" }
                : undefined,
          ]);
        }
      }
      h.model.route = () => undefined;
      await h.serve();
      await r.dispose(h.tick());
    },
    moonraker({ random: 0.5 }),
    {
      reconnect: {
        initialDelayMs: 10,
        maximumDelayMs: 40,
        maximumAttempts: 4,
        jitterRatio: 0.25,
      },
    },
  );

// --- Output ---------------------------------------------------------------------------------
const records = scenarios.reduce((n, s) => n + s.records.length, 0);
const sources = [
  "tools/cross-platform/moonraker-transport-vectors.mjs",
  "web/src/printer/MoonrakerTransportExchange.ts",
  "web/src/printer/MoonrakerTransport.ts",
  "web/src/printer/MoonrakerEndpoint.ts",
  "web/src/printer/SessionCredentials.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    scenarios,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/moonraker-transport-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Moonraker transport reference drift",
  );
console.log(
  `Moonraker transport references: ${scenarios.length} scenarios, ${records} records.`,
);
