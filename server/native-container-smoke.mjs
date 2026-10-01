import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ProfileCatalog } from "../web/src/slicer/ProfileLoader.ts";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const catalog = ProfileCatalog.fromRaw(
  JSON.parse(
    await readFile(root + "/web/public/profiles/catalog.json", "utf8"),
  ),
);
const profile = catalog.profiles.find(
  (p) =>
    /Centauri Carbon.*0\.4/.test(p.machineName) &&
    /0\.20|0\.2 Standard/.test(p.processName) &&
    /PLA/.test(p.filamentName),
);
assert.ok(profile, "Missing native qualification profile");
const container = docker(
  "run",
  "--rm",
  "-d",
  "--init",
  "--user",
  "10001:10001",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=256m",
  "--tmpfs",
  "/home/orcaxr:rw,uid=10001,gid=10001,size=64m",
  "-p",
  "127.0.0.1::3000",
  "-e",
  "TS_AUTHKEY=",
  "-e",
  "HOST=0.0.0.0",
  "-e",
  "ORCAXR_TRUST=same-origin",
  "-e",
  "ORCAXR_ACCEPT_LAN_EXPOSURE=yes-i-understand",
  "-e",
  "SLICER_ENGINE=cli",
  "--entrypoint",
  "node",
  process.env.ORCAXR_TEST_IMAGE || "server-orcaxr",
  "/app/server.js",
);
try {
  const port = JSON.parse(
    docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", container),
  )["3000/tcp"][0].HostPort;
  const base = `http://127.0.0.1:${port}`;
  const headers = { Origin: base };
  const startup = Date.now() + 30_000;
  while (true) {
    try {
      if (
        (await fetch(base + "/ping", { signal: AbortSignal.timeout(1000) })).ok
      )
        break;
    } catch {}
    assert.ok(Date.now() < startup, "Native service startup deadline");
    await new Promise((done) => setTimeout(done, 150));
  }
  const attestation = await (
    await fetch(base + "/engine", {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
  ).json();
  assert.equal(attestation.attested, true);
  assert.equal(attestation.engine, "cli");
  assert.equal(
    attestation.upstream.commit,
    "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626",
  );
  const form = new FormData();
  form.append(
    "file",
    new Blob([await readFile(root + "/web/public/models/cube_20mm.stl")]),
    "cube_20mm.stl",
  );
  form.append("overrides", JSON.stringify(profile.config));
  const submitted = await fetch(base + "/slice?async=1", {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(submitted.status, 202);
  const { job } = await submitted.json();
  const deadline = Date.now() + 180_000;
  let status;
  do {
    status = await (
      await fetch(`${base}/jobs/${job}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
    ).json();
    if (["done", "error", "cancelled"].includes(status.status)) break;
    assert.ok(Date.now() < deadline, "Native slice deadline");
    await new Promise((done) => setTimeout(done, 250));
  } while (true);
  assert.equal(
    status.status,
    "done",
    "The real pinned native CLI must complete successfully",
  );
  const first = await fetch(`${base}/jobs/${job}/gcode`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const a = Buffer.from(await first.arrayBuffer());
  const second = await fetch(`${base}/jobs/${job}/gcode`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const b = Buffer.from(await second.arrayBuffer());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(a, b);
  const digest = createHash("sha256").update(a).digest("hex");
  assert.equal(first.headers.get("X-OrcaXR-Gcode-SHA256"), digest);
  assert.equal(Number(first.headers.get("X-OrcaXR-Gcode-Bytes")), a.byteLength);
  assert.match(a.toString("utf8"), /^G[01] .*E/m);
  assert.equal(
    (
      await fetch(`${base}/jobs/${job}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10_000),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/jobs/${job}/gcode`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
    ).status,
    404,
  );
  console.log(
    JSON.stringify({
      engine: "pinned native CLI",
      profile: profile.displayName,
      bytes: a.length,
      sha256: createHash("sha256").update(a).digest("hex"),
      repeatedDownload: true,
      released: true,
    }),
  );
} finally {
  docker("stop", "--time", "10", container);
}
