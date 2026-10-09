// Moonraker transport policy references from the production browser
// (`MoonrakerPolicyExchange.ts` over `MoonrakerEndpoint.ts`,
// `SessionCredentials.ts` and `MoonrakerTransport.ts`): endpoints entered
// every way an operator might (hosts, IPs, IPv6, schemes, ports, paths,
// proxies, hostile spellings), request paths with traversal and credential
// probes, credentials and what they match, refused responses and how their
// text is redacted, handshakes across versions and malformed replies,
// reconnect policies and their backoff, object subscriptions, and
// single-method endpoints. Replayed by Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  answerCredentials,
  answerEndpoint,
  answerErrorResponse,
  answerHandshake,
  answerMethodCheck,
  answerPath,
  answerReconnectDelay,
  answerReconnectPolicy,
  answerSubscription,
} from "../../web/src/printer/MoonrakerPolicyExchange.ts";
import {
  encodeProjectMoonrakerCheckReply,
  encodeProjectMoonrakerCredentialCheck,
  encodeProjectMoonrakerCredentialReply,
  encodeProjectMoonrakerEndpointReply,
  encodeProjectMoonrakerEndpointRequest,
  encodeProjectMoonrakerErrorResponse,
  encodeProjectMoonrakerHandshakeReply,
  encodeProjectMoonrakerHandshakeRequest,
  encodeProjectMoonrakerMethodCheck,
  encodeProjectMoonrakerObjectSubscription,
  encodeProjectMoonrakerPathReply,
  encodeProjectMoonrakerPathRequest,
  encodeProjectMoonrakerReconnectDelayRequest,
  encodeProjectMoonrakerReconnectPolicyInput,
  encodeProjectMoonrakerReconnectPolicyReply,
  encodeProjectMoonrakerSubscriptionReply,
  encodeProjectMoonrakerTransportFault,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const absent = { absent: {} };
const text = (value) =>
  value === undefined ? absent : { value: units(value) };
const number = (value) => (value === undefined ? absent : { value });

// --- Endpoints ------------------------------------------------------------------------
const endpoints = [];
const endpointInputs = [
  "printer.local",
  "printer.local:7125",
  "192.168.1.20",
  "192.168.1.20:80",
  "192.168.1.20:443",
  "http://printer.local",
  "https://printer.example/moonraker/",
  "http://printer.local//a//b//",
  "  printer.local  ",
  "",
  " ",
  "printer local",
  "ftp://printer.local",
  "http://user:pw@printer.local",
  "http://user@printer.local",
  "http://printer.local/?q",
  "http://printer.local/#h",
  "http://printer.local/?",
  "http://printer.local/#",
  "::1",
  "fe80::1",
  "[::1]:7125",
  "http://[::1]",
  "http://[::1]:7125/m/",
  "http://0x7f.1",
  "http://127.1",
  "127.0.0.1",
  "BÜCHER.example",
  "xn--bcher-kva.example",
  "http://ex%41mple.com",
  "printer.local/a/../b",
  "printer.local/%2e%2e/x",
  "http://printer.local:0",
  "http://printer.local:65536",
  "printer.local:99999",
  "HTTP://PRINTER.LOCAL",
  "http://printer.local./",
  "x".repeat(2049),
  "printer\u0001.local",
  "printer.local/\ud800",
  "mailto:someone@example.com",
  "http:printer.local",
  "printer.local\\path",
  "https://printer.example:443/",
  "http://printer.local:80/",
  "printer.local/moonraker",
  "printer.local/ä b",
  "PrInTeR.LoCaL:8080/Path/",
  "http://[fe80::1%25eth0]",
  "1.2.3.4.5",
  "http://999.1.1.1",
  "ws://printer.local",
  "printer.local:",
  "http://-bad-.local",
  "http://a..b",
  "http://%zz.local",
  "http://printer.local:7125/a?b",
  "https://printer.example/a%2Fb/",
  "　printer.local",
  "printer.local ",
];
for (const input of endpointInputs)
  endpoints.push({
    input: units(input),
    defaultPort: absent,
    sameOriginProxy: absent,
    pageOrigin: absent,
  });
for (const port of [80, 443, 1, 65535, 0, 70000, 7125.5, -1])
  endpoints.push({
    input: units("printer.local"),
    defaultPort: { value: port },
    sameOriginProxy: absent,
    pageOrigin: absent,
  });
for (const [proxy, origin] of [
  ["/moonraker", "https://app.example"],
  ["moonraker/", "https://app.example/ui/"],
  ["/a//b/", "http://localhost:5173"],
  ["https://other.example/x", "https://app.example"],
  ["https://app.example/x/", "https://app.example"],
  ["/x?q", "https://app.example"],
  ["/x#h", "https://app.example"],
  ["//evil.example/x", "https://app.example"],
  ["/moonraker", "file:///x"],
  ["/moonraker", undefined],
  ["/moonraker", "not a url"],
  [" ", "https://app.example"],
  ["/m oon", "https://app.example"],
  ["https://user@app.example/x", "https://app.example"],
  ["/moonraker", "https://app.example:8443"],
  ["", "https://app.example"],
])
  endpoints.push({
    input: units("printer.local"),
    defaultPort: absent,
    sameOriginProxy: text(proxy),
    pageOrigin: text(origin),
  });
endpoints.push({
  input: units("bad host"),
  defaultPort: absent,
  sameOriginProxy: text("/m"),
  pageOrigin: text("https://app.example"),
});
const endpointCases = endpoints.map((request) => ({
  requestJson: encodeProjectMoonrakerEndpointRequest(request),
  replyJson: encodeProjectMoonrakerEndpointReply(answerEndpoint(request)),
}));

// --- Paths ----------------------------------------------------------------------------
const bases = [
  "http://printer.local:7125",
  "https://printer.example/moonraker",
  "http://[::1]:7125",
  "http://printer.local:7125/",
];
const pathInputs = [
  "/server/info",
  "/printer/objects/query?webhooks&print_stats",
  "/server/files/metadata?filename=a%20b.gcode",
  "server/info",
  "//x",
  "/a\\b",
  "/a b",
  "/a/./b",
  "/a/%2e%2E/b",
  "/a/%2e/b",
  "/%E0%A4%A",
  "/%ZZ",
  "/x?api_key=1",
  "/x?token=1",
  "/x?ACCESS-TOKEN=1",
  "/x?a=1&Authorization=2",
  "/x?pass+word=1",
  "/x?pass%77ord=1",
  "/x??y=1",
  "/x?",
  "/x?#",
  "/é",
  "/x?q=é",
  "/x/",
  "/",
  "/x?%73ecret=1",
  "/a/%2F/b",
  "/x?y=%E2%82",
  "/x?apikey",
  "/x?q=api_key",
  "/x?my_secret_thing=1",
  "/a/%C0%AE%C0%AE/b",
  "/a/%2e%2e%2f/b",
  "/x\u0000",
  "/x?\t",
  "/files/a#b",
  "/x?y=1;z=2",
  "/%F0%9F%98%80",
  "/\ud800",
  "/x?\ud800=1",
  "/x?a=%",
  "/x/..",
  "/x/.",
  "/.",
  "/..",
];
const paths = [];
for (const base of bases)
  for (const path of pathInputs)
    paths.push({ base: units(base), path: units(path) });
const pathCases = paths.map((request) => ({
  requestJson: encodeProjectMoonrakerPathRequest(request),
  replyJson: encodeProjectMoonrakerPathReply(answerPath(request)),
}));

// --- Credentials ----------------------------------------------------------------------
const probes = [
  "",
  "abc123",
  "Bearer tok",
  "tok",
  "bearer tok",
  "x",
  "Bearer abc123",
].map(units);
const credentialCases = [
  {},
  { apiKey: "abc123" },
  { bearerToken: "tok" },
  { apiKey: "abc123", bearerToken: "tok" },
  { apiKey: "" },
  { apiKey: " abc" },
  { apiKey: "abc " },
  { apiKey: "a\u0001b" },
  { apiKey: "a".repeat(4097) },
  { apiKey: "a".repeat(4096) },
  { bearerToken: "t\u007fk" },
  { bearerToken: "", apiKey: "abc123" },
  { apiKey: " abc" },
  { apiKey: "clé" },
].map((c) => {
  const check = {
    credentials: { apiKey: text(c.apiKey), bearerToken: text(c.bearerToken) },
    probes,
  };
  return {
    requestJson: encodeProjectMoonrakerCredentialCheck(check),
    replyJson: encodeProjectMoonrakerCredentialReply(answerCredentials(check)),
  };
});

// --- Refused responses ----------------------------------------------------------------
const bodies = [
  undefined,
  "",
  "   ",
  '{"error":"Bad thing"}',
  '{"error":{"message":"Method Not Allowed","code":405}}',
  '{"message":"m"}',
  '{"error":5}',
  '{"error":{"message":5},"message":"fallback"}',
  "plain text\twith\ncontrols",
  "x".repeat(3000),
  "see http://printer.local/x?api_key=abc for help",
  "api_key=secret123 rest",
  "Bearer: abc",
  "x-api-key = zz",
  "token secret123 echoed",
  'wss://h/x"quoted" tail',
  "<html><body>Bad Gateway</body></html>",
  '{"error":"key secret123 rejected"}',
  "ACCESS_TOKEN:abc def",
  "bearer=",
  "api_key = 　 ",
  "HTTPS://Example.COM/p?q",
  '{"error":"' + "y".repeat(2100) + '"}',
  "\u0001\u0002 lead",
  "tail \u007f",
  "é".repeat(300),
  "a b c",
  "http://",
  "x:https://y",
  "_https://y",
];
const errorCases = [];
for (const status of [
  400, 401, 403, 404, 405, 408, 425, 429, 500, 503, 599, 600, 99, 404.5,
])
  for (const body of status === 404 || status === 500
    ? bodies
    : [undefined, '{"error":"Bad thing"}'])
    for (const credentials of status === 500
      ? [{}, { apiKey: "secret123" }, { bearerToken: "secret123" }]
      : [{}]) {
      const response = {
        status,
        body: text(body),
        credentials: {
          apiKey: text(credentials.apiKey),
          bearerToken: text(credentials.bearerToken),
        },
        operation: units(
          status === 405
            ? "Print_Start"
            : status === 400
              ? "bad op!"
              : "request",
        ),
      };
      errorCases.push({
        requestJson: encodeProjectMoonrakerErrorResponse(response),
        replyJson: encodeProjectMoonrakerTransportFault(
          answerErrorResponse(response),
        ),
      });
    }

// --- Handshakes -----------------------------------------------------------------------
const SERVER = {
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
const PRINTER = {
  state: "ready",
  hostname: "u1-workshop",
  software_version: "v0.12.0",
};
const handshakes = [];
const handshake = (server, printer = PRINTER, policy = {}) =>
  handshakes.push({
    server: units(typeof server === "string" ? server : JSON.stringify(server)),
    printer: units(
      typeof printer === "string" ? printer : JSON.stringify(printer),
    ),
    policy: {
      minimum:
        policy.minimum === undefined ? absent : { value: policy.minimum },
      maximumMajor: number(policy.maximumMajor),
    },
  });
handshake(SERVER);
handshake({
  ...SERVER,
  api_version: undefined,
  api_version_string: "1.2.3-beta",
});
handshake({ ...SERVER, api_version: null, api_version_string: " 1.0.0 " });
handshake({ ...SERVER, api_version: [1, "0", "5"] });
handshake({ ...SERVER, api_version: [1, 0] });
handshake({ ...SERVER, api_version: [1, 0, 5, 9] });
handshake({ ...SERVER, api_version: [1, true, [3]] });
handshake({ ...SERVER, api_version: [1, "", null] });
handshake({ ...SERVER, api_version: [1, "0x1", "1e1"] });
handshake({ ...SERVER, api_version: [1, 0.5, 0] });
handshake({ ...SERVER, api_version: [1, 0, 1000001] });
handshake({ ...SERVER, api_version: "2.0.0" });
handshake({ ...SERVER, api_version: [0, 9, 0] });
handshake({ ...SERVER, api_version: "1.0" });
handshake({ ...SERVER, api_version: "1.0.0\nx" });
handshake({ ...SERVER, api_version: "1.0.0+build.5" });
handshake({ ...SERVER, api_version: "1.0.0-rc " });
handshake({ ...SERVER, api_version: { major: 1 } });
handshake({ ...SERVER, components: ["file_manager", 7] });
handshake({ ...SERVER, components: ["file manager"] });
handshake({ ...SERVER, components: ["x".repeat(65)] });
handshake({
  ...SERVER,
  components: ["webcam", "history", "webcam", "Zeta", "alpha"],
});
handshake({ ...SERVER, components: "file_manager" });
handshake({ ...SERVER, warnings: ["config warning"] });
handshake({ ...SERVER, warnings: "not a list" });
handshake({
  ...SERVER,
  moonraker_version: "v\u00011\u007f2" + "z".repeat(200),
});
handshake({ ...SERVER, moonraker_version: 5 });
handshake(SERVER, { ...PRINTER, state: "READY" });
handshake(SERVER, { ...PRINTER, state: "shutdown" });
handshake(SERVER, { hostname: "h".repeat(300) });
handshake(SERVER, "[]");
handshake(SERVER, "null");
handshake({ ...SERVER, components: ["file_manager"] }, PRINTER);
handshake("[]");
handshake("not json");
handshake(SERVER, PRINTER, { minimum: [1, 0, 5] });
handshake(SERVER, PRINTER, { minimum: [1, 0, 6] });
handshake({ ...SERVER, api_version: [2, 1, 0] }, PRINTER, { maximumMajor: 2 });
handshake(SERVER, PRINTER, { minimum: [1, 0] });
handshake(SERVER, PRINTER, { maximumMajor: 0 });
handshake(SERVER, PRINTER, { maximumMajor: 1.5 });
handshake(SERVER, PRINTER, { minimum: [2, 0, 0] });
const handshakeCases = handshakes.map((request) => ({
  requestJson: encodeProjectMoonrakerHandshakeRequest(request),
  replyJson: encodeProjectMoonrakerHandshakeReply(answerHandshake(request)),
}));

// --- Reconnect policies and delays ------------------------------------------------------
const policyInputs = [
  {},
  { initialDelayMs: 10 },
  { initialDelayMs: 10, maximumDelayMs: 5 },
  { maximumAttempts: 33 },
  { maximumAttempts: 1.5 },
  { jitterRatio: 1.5 },
  { jitterRatio: 0 },
  { initialDelayMs: -1 },
  { initialDelayMs: 0, maximumDelayMs: 0, maximumAttempts: 0, jitterRatio: 1 },
  { maximumAttempts: 32 },
  { maximumDelayMs: 100 },
];
const policyCases = policyInputs.map((input) => {
  const wire = {
    initialDelayMs: number(input.initialDelayMs),
    maximumDelayMs: number(input.maximumDelayMs),
    maximumAttempts: number(input.maximumAttempts),
    jitterRatio: number(input.jitterRatio),
  };
  return {
    requestJson: encodeProjectMoonrakerReconnectPolicyInput(wire),
    replyJson: encodeProjectMoonrakerReconnectPolicyReply(
      answerReconnectPolicy(wire),
    ),
  };
});
const delayCases = [];
for (const policy of [
  {
    initialDelayMs: 500,
    maximumDelayMs: 30000,
    maximumAttempts: 6,
    jitterRatio: 0.2,
  },
  {
    initialDelayMs: 10,
    maximumDelayMs: 25,
    maximumAttempts: 3,
    jitterRatio: 0,
  },
  {
    initialDelayMs: 333,
    maximumDelayMs: 1e9,
    maximumAttempts: 32,
    jitterRatio: 1,
  },
  {
    initialDelayMs: 0.7,
    maximumDelayMs: 99.9,
    maximumAttempts: 5,
    jitterRatio: 0.33,
  },
])
  for (const attempt of [1, 2, 3, 6, 10, 0, -5, 2.7, 40, 31, 32])
    for (const random of [0, 0.5, 1, -1, 2, 0.123456789]) {
      const request = { attempt, policy, random };
      delayCases.push({
        requestJson: encodeProjectMoonrakerReconnectDelayRequest(request),
        delayMs: answerReconnectDelay(request),
      });
    }

// --- Subscriptions and methods ----------------------------------------------------------
const entry = (name, fields) => ({
  name: units(name),
  fields: fields === null ? absent : { value: fields.map(units) },
});
const subscriptions = [
  [
    entry("webhooks", null),
    entry("print_stats", null),
    entry("virtual_sdcard", ["progress", "is_active", "progress"]),
  ],
  [entry("extruder", ["temperature", "target"]), entry("heater_bed", null)],
  [entry("__proto__", null)],
  [entry("constructor", null)],
  [entry("prototype", [])],
  [
    entry("b", null),
    entry("10", null),
    entry("a", null),
    entry("2", null),
    entry("01", null),
  ],
  [entry("x", ["b", "a"]), entry("x", ["c"])],
  [entry("x", ["bad field"])],
  [entry("x".repeat(129), null)],
  [entry("display status", null)],
  [],
  [entry("x", [])],
  [entry("é", null)],
  [entry("4294967295", null), entry("4294967294", null)],
];
const subscriptionCases = subscriptions.map((entries) => ({
  requestJson: encodeProjectMoonrakerObjectSubscription(entries),
  replyJson: encodeProjectMoonrakerSubscriptionReply(
    answerSubscription(entries),
  ),
}));
const methodCases = [];
for (const path of [
  "/printer/print/start",
  "/printer/print/start/",
  "/server/info",
  "/printer/gcode/script",
  "/server/files/move",
  "/printer/print/startx",
  "/printer/print/start?filename=a",
])
  for (const method of [
    undefined,
    "GET",
    "POST",
    "post",
    "poſt",
    "DELETE",
    "ﬆ",
  ]) {
    const check = {
      url: units(`http://printer.local:7125${path}`),
      method: text(method),
      operation: units("print_start"),
    };
    methodCases.push({
      requestJson: encodeProjectMoonrakerMethodCheck(check),
      replyJson: encodeProjectMoonrakerCheckReply(answerMethodCheck(check)),
    });
  }

// --- Output ---------------------------------------------------------------------------------
const sources = [
  "tools/cross-platform/moonraker-policy-vectors.mjs",
  "web/src/printer/MoonrakerPolicyExchange.ts",
  "web/src/printer/MoonrakerEndpoint.ts",
  "web/src/printer/SessionCredentials.ts",
  "web/src/printer/MoonrakerTransport.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const corpus = {
  endpoints: endpointCases,
  paths: pathCases,
  credentials: credentialCases,
  errors: errorCases,
  handshakes: handshakeCases,
  policies: policyCases,
  delays: delayCases,
  subscriptions: subscriptionCases,
  methods: methodCases,
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
const path = new URL(
  "testdata/cross-platform/moonraker-policy-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Moonraker policy reference drift",
  );
console.log(
  `Moonraker policy references: ${Object.entries(corpus)
    .map(([k, v]) => `${v.length} ${k}`)
    .join(", ")}.`,
);
