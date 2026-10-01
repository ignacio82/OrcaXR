import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  startDeploymentFixture,
  FIXTURE_GCODE,
} from "./deployment-fixture.mjs";
import { startMoonrakerSimulator } from "../web/scripts/moonraker-simulator.mjs";

const requireWeb = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const puppeteer = requireWeb("puppeteer");
const root = path.resolve(new URL("..", import.meta.url).pathname);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "orcaxr-deployment-browser-"),
);
let fixture, container, browser, printer;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      path.join(temporary, "key.pem"),
      "-out",
      path.join(temporary, "cert.pem"),
      "-subj",
      "/CN=orcaxr-proxy.test",
      "-addext",
      "subjectAltName=DNS:orcaxr-proxy.test",
    ],
    { stdio: "ignore" },
  );
  if (process.argv.includes("--container")) {
    // Disposable test certificates must be readable by the image's runtime UID.
    await fs.chmod(temporary, 0o755);
    await fs.chmod(path.join(temporary, "key.pem"), 0o644);
    container = docker(
      "run",
      "--rm",
      "-d",
      "--init",
      "-p",
      "127.0.0.1::3000",
      "-p",
      "127.0.0.1::3443",
      "--user",
      "10001:10001",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m",
      "-e",
      "TS_AUTHKEY=",
      "-e",
      "HOST=0.0.0.0",
      "-e",
      "ORCAXR_TRUST=same-origin",
      "-e",
      "ORCAXR_ACCEPT_LAN_EXPOSURE=yes-i-understand",
      "-v",
      `${temporary}:/test-certs:ro`,
      "-v",
      `${root}/server/deployment-fixture.mjs:/app/deployment-fixture.mjs:ro`,
      "--entrypoint",
      "node",
      process.env.ORCAXR_TEST_IMAGE || "server-orcaxr",
      "/app/deployment-fixture.mjs",
    );
    const ports = JSON.parse(
      docker(
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        container,
      ),
    );
    fixture = {
      port: Number(ports["3000/tcp"][0].HostPort),
      tlsPort: Number(ports["3443/tcp"][0].HostPort),
    };
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        if ((await fetch(`http://127.0.0.1:${fixture.port}/ping`)).ok) break;
      } catch {}
      if (Date.now() > deadline)
        throw new Error("Built container did not start its deployment fixture");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const forged = await fetch(`http://127.0.0.1:${fixture.port}/slice`, {
      method: "POST",
      headers: {
        origin: `https://127.0.0.1:${fixture.port}`,
        "x-forwarded-proto": "https",
        "x-forwarded-for": "127.0.0.1",
        "tailscale-user-login": "forged@example.test",
      },
    });
    assert.equal(
      forged.status,
      403,
      "the container bridge peer cannot forge loopback proxy trust",
    );
  } else {
    fixture = await startDeploymentFixture({
      webRoot: path.join(root, "web/dist"),
      certDirectory: temporary,
    });
  }
  printer = await startMoonrakerSimulator();
  browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--no-proxy-server",
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP orcaxr-lan.test 127.0.0.1, MAP orcaxr-proxy.test 127.0.0.1",
    ],
  });
  for (const [scheme, hostname, port] of [
    ["http", "orcaxr-lan.test", fixture.port],
    ["https", "orcaxr-proxy.test", fixture.tlsPort],
  ]) {
    const url = `${scheme}://${hostname}:${port}`;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const assetFailures = [],
      errors = [];
    page.on("response", (response) => {
      if (
        response.url().startsWith(`${url}/`) &&
        /\/(?:assets|icons|profiles|slicer)\//.test(response.url()) &&
        response.status() >= 400
      )
        assetFailures.push([response.status(), response.url()]);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
    await page.waitForSelector("#app-boot.ready", { timeout: 60_000 });
    assert.equal(
      await page.evaluate(() => isSecureContext),
      scheme === "https",
      "LAN must exercise a genuinely insecure browser origin",
    );
    if (scheme === "https") {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        { timeout: 60_000 },
      );
      const precache = await page.evaluate(async () => {
        const script = await (await fetch("/sw.js")).text();
        const expected = [...script.matchAll(/\{url:"([^"]+)",revision:/g)].map(
          (match) => new URL(match[1], location.href).pathname,
        );
        const cached = new Set();
        for (const name of await caches.keys()) {
          if (!name.includes("precache")) continue;
          for (const request of await (await caches.open(name)).keys())
            cached.add(new URL(request.url).pathname);
        }
        return {
          count: expected.length,
          missing: expected.filter((url) => !cached.has(url)),
        };
      });
      assert.ok(
        precache.count > 100,
        "check the whole real precache inventory",
      );
      assert.deepEqual(precache.missing, []);
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    }
    await page.waitForFunction(
      () =>
        document.querySelector("#external-slicer-enabled")?.checked === true,
      { timeout: 10_000 },
    );
    assert.match(
      await page.$eval("#external-slicer-status", (node) => node.textContent),
      /Slicing here.*attested/,
    );
    const allowance = await page.evaluate(async () => {
      const reply = await fetch("/ping");
      return {
        status: reply.status,
        remaining: Number(reply.headers.get("x-ratelimit-remaining")),
      };
    });
    assert.equal(allowance.status, 200);
    assert.ok(
      allowance.remaining >= 30,
      `cold boot/precache spent the API allowance: ${allowance.remaining}`,
    );
    assert.deepEqual(assetFailures, []);
    assert.deepEqual(errors, []);

    const api = await page.evaluate(async () => {
      const bytes = new Uint8Array(134);
      const view = new DataView(bytes.buffer);
      view.setUint32(80, 1, true);
      view.setFloat32(108, 1, true);
      view.setFloat32(124, 1, true);
      const body = new FormData();
      body.append("file", new Blob([bytes]), "fixture.stl");
      body.append("overrides", "{}");
      const submitted = await fetch("/slice?async=1", { method: "POST", body });
      if (submitted.status !== 202)
        throw new Error(
          `Submission failed: ${submitted.status} ${(await submitted.json()).error?.code}`,
        );
      const { job } = await submitted.json();
      let status;
      for (let attempt = 0; attempt < 15; attempt++) {
        status = await (await fetch(`/jobs/${job}`)).json();
        if (status.status === "done") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const response = await fetch(`/jobs/${job}/gcode`);
      const first = await response.text();
      const second = await (await fetch(`/jobs/${job}/gcode`)).text();
      const release = await (
        await fetch(`/jobs/${job}`, { method: "DELETE" })
      ).json();
      const unknown = await fetch("/api/missing", {
        headers: { accept: "text/html" },
      });
      return {
        status: status.status,
        first,
        second,
        jobHeader: response.headers.get("x-orcaxr-job-id"),
        job,
        release,
        unknown: unknown.status,
        unknownType: unknown.headers.get("content-type"),
      };
    });
    assert.equal(api.status, "done");
    assert.equal(api.first, FIXTURE_GCODE);
    assert.equal(api.second, api.first);
    assert.equal(api.jobHeader, api.job);
    assert.deepEqual(api.release, { status: "done", released: true });
    assert.equal(api.unknown, 404);
    assert.match(api.unknownType, /application\/json/);
    if (scheme === "http") {
      // Exercise the existing simulated printer from the real served browser.
      await page.evaluate((endpoint) => {
        const input = document.getElementById("printer-host");
        input.value = endpoint;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("btn-printer-test")?.click();
      }, printer.url);
      await page.waitForFunction(
        () =>
          /Connected.*orcaxr-simulator/.test(
            document.getElementById("status-text")?.textContent ?? "",
          ),
        { timeout: 15_000 },
      );
      assert.equal(
        await page.$eval(
          "[data-printer-status-headline]",
          (node) => node.textContent,
        ),
        "Idle",
      );
    }
    const rateLimited = await page.evaluate(async () => {
      for (let attempt = 0; attempt < 41; attempt++) {
        const reply = await fetch("/ping");
        if (reply.status === 429)
          return {
            status: reply.status,
            retry: reply.headers.get("retry-after"),
          };
        if (!reply.ok) throw new Error(`Unexpected API status ${reply.status}`);
      }
      return null;
    });
    assert.equal(rateLimited?.status, 429);
    assert.ok(Number(rateLimited.retry) > 0);
    console.log(
      `Deployment browser passed: ${scheme}, cold assets, ${scheme === "https" ? "complete precache, isolation, " : "insecure LAN, printer simulator, "}retained downloads, API limits.`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await printer?.close();
  if (container) docker("rm", "-f", container);
  else await fixture?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
