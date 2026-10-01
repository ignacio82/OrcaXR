import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSlicerService } from "./server.js";
import {
  isSameOriginRequest,
  isOriginAllowed,
  isTrustedProxyPeer,
  rateLimitIdentity,
} from "./security.mjs";

async function fixture(config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orcaxr-deployment-"));
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><body>Application</body></html>",
  );
  for (let i = 0; i < 6; i++)
    await fs.writeFile(
      path.join(root, "assets", `chunk${i}-abcdefgh.js`),
      `export const value = ${i};`,
    );
  const service = createSlicerService({
    webRoot: root,
    env: {},
    config: {
      maxRequestsPerWindow: 3,
      maxSliceRequestsPerWindow: 100,
      ...config,
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const server = service.start(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await service.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("a cold static load preserves the entire API allowance and cache/security headers", async () => {
  const app = await fixture();
  try {
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${app.url}/assets/chunk${i}-abcdefgh.js`);
      assert.equal(
        response.status,
        200,
        `cold asset ${i} must not consume API allowance`,
      );
      assert.match(response.headers.get("cache-control"), /immutable/);
      assert.equal(
        response.headers.get("cross-origin-embedder-policy"),
        "credentialless",
      );
      await response.text();
    }
    for (const route of ["/index.html", "/"]) {
      const response = await fetch(`${app.url}${route}`, {
        headers: { accept: "text/html" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      await response.text();
    }
    for (let i = 0; i < 3; i++)
      assert.equal((await fetch(`${app.url}/ping`)).status, 200);
    assert.equal(
      (await fetch(`${app.url}/ping`)).status,
      429,
      "API traffic is still rate limited",
    );
  } finally {
    await app.close();
  }
});

test("unknown API routes cannot fall through to application HTML", async () => {
  const app = await fixture({ maxRequestsPerWindow: 100 });
  try {
    for (const route of [
      "/api/missing",
      "/%2fapi/missing",
      "/%2e%2fapi/missing",
      "/%5capi/missing",
      "/jobs/missing/extra",
      "/slice/unknown",
      "/engine/unknown",
      "/ping/unknown",
    ]) {
      const response = await fetch(`${app.url}${route}`, {
        headers: { accept: "text/html" },
      });
      assert.equal(response.status, 404, route);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal((await response.json()).error.code, "NOT_FOUND");
    }
  } finally {
    await app.close();
  }
});

test("an untrusted socket cannot claim proxy HTTPS even if req.ip claims loopback", () => {
  const headers = {
    host: "app.example",
    origin: "https://app.example",
    "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin",
  };
  const request = {
    method: "POST",
    protocol: "http",
    ip: "127.0.0.1",
    socket: { remoteAddress: "192.0.2.44" },
    get: (name) => headers[name],
  };
  const config = { trustSameOrigin: true, trustedProxy: true };
  assert.equal(isSameOriginRequest(request, config), false);
  assert.equal(isOriginAllowed(headers.origin, config, request), false);
});

test("a trusted proxy with ambiguous protocol cannot authorize a write", () => {
  const config = { trustSameOrigin: true, trustedProxy: true };
  for (const protocol of ["https,http", "https, https", "ftp", ""]) {
    const headers = {
      host: "app.example",
      origin: "https://app.example",
      "x-forwarded-proto": protocol,
    };
    const request = {
      method: "POST",
      protocol: "http",
      socket: { remoteAddress: "127.0.0.1" },
      get: (name) => headers[name],
    };
    assert.equal(isSameOriginRequest(request, config), false, protocol);
    assert.equal(
      isOriginAllowed(headers.origin, config, request),
      false,
      protocol,
    );
  }
});

test("proxy authorization and rate identity use the same actual socket predicate", () => {
  const config = { trustSameOrigin: true, trustedProxy: true };
  const headers = {
    host: "app.example",
    origin: "https://app.example",
    "x-forwarded-proto": "https",
    "tailscale-user-login": "operator@example.test",
  };
  for (const address of [
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "::ffff:127.0.0.1",
    "192.0.2.44",
    "::ffff:192.0.2.44",
    "localhost",
    undefined,
  ]) {
    const trusted = [
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "::ffff:127.0.0.1",
    ].includes(address);
    const req = {
      method: "POST",
      protocol: "https",
      ip: "127.0.0.1",
      socket: { remoteAddress: address },
      get: (key) => headers[key],
    };
    assert.equal(isTrustedProxyPeer(req, config), trusted, address);
    assert.equal(isSameOriginRequest(req, config), trusted, address);
    assert.equal(
      isOriginAllowed(headers.origin, config, req),
      trusted,
      address,
    );
    assert.equal(
      rateLimitIdentity(req, config),
      trusted ? "user:operator@example.test" : `peer:${address || "unknown"}`,
    );
    assert.equal(isTrustedProxyPeer(req, { trustedProxy: false }), false);
  }
});

test("real HTTP rejects malformed proxy protocols and retains mutation authentication", async () => {
  const app = await fixture({
    trustMode: "same-origin",
    trustedProxy: true,
    maxRequestsPerWindow: 100,
  });
  try {
    for (const protocol of ["https,http", "ftp", ""]) {
      const response = await fetch(`${app.url}/ping`, {
        headers: { "x-forwarded-proto": protocol },
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error.code,
        "INVALID_FORWARDED_PROTOCOL",
      );
    }
    const missing = await fetch(`${app.url}/slice`, { method: "POST" });
    assert.equal(missing.status, 401);
    const sameOrigin = await fetch(`${app.url}/slice`, {
      method: "POST",
      headers: { origin: app.url },
    });
    assert.equal(sameOrigin.status, 400, "authorized but missing model");
    const proxied = await fetch(`${app.url}/slice`, {
      method: "POST",
      headers: {
        origin: app.url.replace("http:", "https:"),
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(
      proxied.status,
      400,
      "trusted HTTPS is authorized but missing model",
    );
    const hostile = await fetch(`${app.url}/slice`, {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(hostile.status, 403);
  } finally {
    await app.close();
  }
});

test("SPA documents and token-protected APIs stay separate", async () => {
  const app = await fixture({
    token: "fixture-credential-value-of-at-least-32-bytes",
    trustMode: "token",
    maxRequestsPerWindow: 100,
  });
  try {
    const asset = await fetch(`${app.url}/assets/chunk0-abcdefgh.js`);
    assert.equal(asset.status, 200);
    const document = await fetch(`${app.url}/workspace`, {
      headers: { accept: "text/html" },
    });
    assert.equal(document.status, 200);
    assert.equal(
      document.headers.get("cross-origin-opener-policy"),
      "same-origin",
    );
    assert.equal((await fetch(`${app.url}/ping`)).status, 401);
    for (const route of [
      "/api/missing",
      "/%61pi/missing",
      "/workspace",
      "/missing.js",
    ]) {
      const response = await fetch(`${app.url}${route}`, {
        headers: {
          authorization: "Bearer fixture-credential-value-of-at-least-32-bytes",
        },
      });
      assert.equal(response.status, 404, route);
      assert.equal((await response.json()).error.code, "NOT_FOUND");
    }
  } finally {
    await app.close();
  }
});
