import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { app, createSlicerService, terminateProcessTree } from "./server.js";
import {
  bearerTokenMatches,
  HttpError,
  inspect3mf,
  inspectStl,
  isOriginAllowed,
  loadServerConfig,
  parseOverridesJson,
  validateServerConfig,
  WindowRateLimiter,
} from "./security.mjs";
import { buildZip, valid3mf } from "./test-helpers.mjs";
import {
  detectSliceInputKind,
  startSliceInput,
} from "./slice_worker.mjs";

/** The Snapmaker Orca commit both engines are pinned to. */
const PINNED_ENGINE_COMMIT = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626";

const archiveLimits = {
  ...loadServerConfig({}),
  maxArchiveEntries: 20,
  maxArchiveCentralBytes: 1024 * 1024,
  maxArchiveEntryBytes: 4 * 1024 * 1024,
  maxArchiveUncompressedBytes: 8 * 1024 * 1024,
  maxArchiveCompressionRatio: 200,
  archiveValidationTimeoutMs: 5000,
};

async function withArchive(buffer, callback) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "orcaxr-zip-test-"),
  );
  const file = path.join(directory, "project.3mf");
  await fs.writeFile(file, buffer);
  try {
    return await callback(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withModel(buffer, callback) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "orcaxr-stl-test-"),
  );
  const file = path.join(directory, "model.stl");
  await fs.writeFile(file, buffer);
  try {
    return await callback(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("server exports an Express handler without listening on import", () => {
  assert.equal(typeof app, "function");
  assert.equal(typeof createSlicerService, "function");
});

test("WASM worker preserves project 3MF semantics and keeps STL on the model entry point", () => {
  const writes = [];
  const calls = [];
  const module = {
    FS: {
      writeFile(inputPath, bytes) {
        writes.push({ inputPath, bytes: Buffer.from(bytes) });
      },
    },
    startSliceProject(...args) {
      calls.push(["project", ...args]);
    },
    startSliceFile(...args) {
      calls.push(["model", ...args]);
    },
  };
  const project = valid3mf();
  const stl = Buffer.from("solid model\nendsolid model\n");

  assert.deepEqual(
    startSliceInput(module, "/upload/job.3mf", project, '{"from":"project"}', 3),
    { kind: "project", inputPath: "/tmp/in.3mf" },
  );
  assert.deepEqual(calls.shift(), [
    "project",
    "/tmp/in.3mf",
    3,
    '{"from":"project"}',
  ]);
  assert.deepEqual(writes.shift(), {
    inputPath: "/tmp/in.3mf",
    bytes: project,
  });

  assert.deepEqual(
    startSliceInput(module, "/upload/job.stl", stl, "{}", 4),
    { kind: "model", inputPath: "/tmp/in.stl" },
  );
  assert.deepEqual(calls.shift(), ["model", "/tmp/in.stl", 4, "{}"]);
  assert.deepEqual(writes.shift(), { inputPath: "/tmp/in.stl", bytes: stl });
});

test("WASM worker rejects extension/signature mismatches instead of flattening projects", () => {
  const project = valid3mf();
  const stl = Buffer.from("solid model\nendsolid model\n");
  assert.equal(detectSliceInputKind("project.3mf", project), "project");
  assert.equal(detectSliceInputKind("model.stl", stl), "model");
  assert.throws(
    () => detectSliceInputKind("project.3mf", stl),
    /does not have a ZIP signature/,
  );
  assert.throws(
    () => detectSliceInputKind("project.stl", project),
    /validated \.3mf route/,
  );
  assert.throws(
    () => detectSliceInputKind("model.obj", stl),
    /Unsupported slicer input extension/,
  );
});

test("deployment config defaults to loopback and fails closed off-loopback", () => {
  const local = validateServerConfig(loadServerConfig({}));
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.authRequired, false);
  assert.throws(
    () =>
      createSlicerService({
        env: { HOST: "0.0.0.0", ORCAXR_ALLOWED_ORIGINS: "https://app.example" },
      }),
    /requires ORCAXR_SERVER_TOKEN/,
  );
  assert.throws(
    () =>
      createSlicerService({
        env: { HOST: "0.0.0.0", ORCAXR_SERVER_TOKEN: "x".repeat(32) },
      }),
    /requires an explicit ORCAXR_ALLOWED_ORIGINS/,
  );
  assert.throws(
    () => loadServerConfig({ ORCAXR_ALLOWED_ORIGINS: "*" }),
    /may not contain/,
  );
  assert.throws(
    () =>
      createSlicerService({
        env: { ORCAXR_SERVER_TOKEN: `x${"y".repeat(31)} z` },
      }),
    /may not contain whitespace/,
  );
});

test("origin and bearer checks are exact", () => {
  const config = loadServerConfig({
    ORCAXR_ALLOWED_ORIGINS: "https://app.example",
  });
  assert.equal(isOriginAllowed("https://app.example", config), true);
  assert.equal(isOriginAllowed("https://app.example.evil.test", config), false);
  assert.equal(isOriginAllowed("http://localhost:5173", config), true);
  assert.equal(isOriginAllowed("null", config), false);
  const token = "test-only-token-00000000000000000";
  assert.equal(bearerTokenMatches(`Bearer ${token}`, token), true);
  assert.equal(bearerTokenMatches(`Bearer ${token}x`, token), false);
  assert.equal(bearerTokenMatches(`Basic ${token}`, token), false);
});

test("overrides parser bounds structure and rejects prototype keys", () => {
  assert.deepEqual(parseOverridesJson('{"layer_height":"0.2"}', 1024), {
    layer_height: "0.2",
  });
  assert.throws(
    () => parseOverridesJson("{", 1024),
    (error) => error instanceof HttpError && error.code === "INVALID_OVERRIDES",
  );
  assert.throws(
    () => parseOverridesJson('{"__proto__":{"polluted":true}}', 1024),
    (error) => error instanceof HttpError && error.code === "INVALID_OVERRIDES",
  );
  assert.throws(
    () => parseOverridesJson('{"value":"0123456789"}', 8),
    (error) =>
      error instanceof HttpError && error.code === "OVERRIDES_TOO_LARGE",
  );
});

test("rate limiter is bounded and reports retry time", () => {
  const limiter = new WindowRateLimiter({
    max: 2,
    windowMs: 1000,
    maxClients: 2,
  });
  assert.equal(limiter.consume("a", 0).allowed, true);
  assert.equal(limiter.consume("a", 1).allowed, true);
  const denied = limiter.consume("a", 2);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1);
  limiter.consume("b", 2);
  limiter.consume("c", 2);
  assert.equal(limiter.clients.size, 2);
});

test("3MF validator accepts a bounded archive", async () => {
  await withArchive(valid3mf(), async (file) => {
    const result = await inspect3mf(file, archiveLimits);
    assert.equal(result.entries, 2);
    assert(result.totalUncompressedBytes > 0);
  });
});

test("3MF validator rejects traversal and symlinks", async () => {
  const traversal = valid3mf([{ name: "../escape.txt", data: "bad" }]);
  await withArchive(traversal, async (file) => {
    await assert.rejects(
      () => inspect3mf(file, archiveLimits),
      (error) => error instanceof HttpError && error.code === "INVALID_3MF",
    );
  });
  const symlink = valid3mf([
    {
      name: "Metadata/link",
      data: "target",
      externalAttributes: 0xa000 << 16,
    },
  ]);
  await withArchive(symlink, async (file) => {
    await assert.rejects(
      () => inspect3mf(file, archiveLimits),
      (error) => error instanceof HttpError && error.code === "INVALID_3MF",
    );
  });
});

test("3MF validator rejects declared and deceptive expansion bombs", async () => {
  const declaredBomb = buildZip([
    { name: "[Content_Types].xml", data: "<Types />" },
    {
      name: "3D/3dmodel.model",
      data: "x",
      method: 8,
      declaredUncompressed: 5 * 1024 * 1024,
    },
  ]);
  await withArchive(declaredBomb, async (file) => {
    await assert.rejects(
      () => inspect3mf(file, archiveLimits),
      (error) => error instanceof HttpError && error.code === "ARCHIVE_LIMIT",
    );
  });

  const deceptive = buildZip([
    { name: "[Content_Types].xml", data: "<Types />" },
    {
      name: "3D/3dmodel.model",
      data: Buffer.alloc(2 * 1024 * 1024, 65),
      method: 8,
      declaredUncompressed: 64,
    },
  ]);
  await withArchive(deceptive, async (file) => {
    await assert.rejects(
      () => inspect3mf(file, archiveLimits),
      (error) =>
        error instanceof HttpError &&
        ["ARCHIVE_LIMIT", "INVALID_3MF"].includes(error.code),
    );
  });
});

test("STL validator accepts exact binary and ASCII forms and rejects arbitrary bytes", async () => {
  const binary = Buffer.alloc(84);
  binary.writeUInt32LE(0, 80);
  await withModel(binary, async (file) => {
    assert.deepEqual(await inspectStl(file), { format: "binary", facets: 0 });
  });
  await withModel(
    Buffer.from("solid model\nendsolid model\n"),
    async (file) => {
      assert.deepEqual(await inspectStl(file), { format: "ascii" });
    },
  );
  await withModel(Buffer.from("this is not a mesh"), async (file) => {
    await assert.rejects(
      () => inspectStl(file),
      (error) => error instanceof HttpError && error.code === "INVALID_STL",
    );
  });
});

test(
  "child-process termination reaps a detached process",
  { timeout: 5000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
      },
    );
    await terminateProcessTree(child, 50);
    assert(child.exitCode !== null || child.signalCode !== null);
  },
);

test("engine attestation proves the WASM build and refuses to claim one for CLI", async () => {
  const { createSlicerService } = await import("./server.js");
  // `wasm-dist/` holds build output and is not committed, so a clean checkout —
  // CI included — has no engine to attest. The refusal path is the one that
  // must hold everywhere; the proof path is asserted wherever a build exists.
  let provenance = null;
  try {
    provenance = JSON.parse(
      await fs.readFile(new URL("./wasm-dist/artifact-provenance.json", import.meta.url), "utf8"),
    );
  } catch {
    provenance = null;
  }

  const read = async (app, route) => {
    const http = await import("node:http");
    return new Promise((resolve, reject) => {
      const server = app.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        http
          .get({ host: "127.0.0.1", port, path: route }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              server.close();
              resolve(JSON.parse(body));
            });
          })
          .on("error", (error) => {
            server.close();
            reject(error);
          });
      });
    });
  };

  const wasm = await read(createSlicerService({ engine: "wasm" }).app, "/engine");
  assert.equal(wasm.engine, "wasm");
  if (provenance) {
    assert.equal(wasm.attested, true, "a wasm engine matching its manifest attests");
    assert.equal(wasm.upstream.commit, provenance.engine.commit);
    // The digests must be computed from the files this process would load, not
    // copied out of the manifest, so a swapped artifact cannot pass.
    assert.deepEqual(wasm.artifacts, provenance.outputs);
  } else {
    // No build present: the server must say it cannot prove an engine rather
    // than assert one. Claiming attestation here would let an unverified binary
    // through the client's canonical-slicing gate.
    assert.equal(wasm.attested, false, "an absent build attests to nothing");
    assert.match(wasm.reason, /could not read|ships no engine provenance/i);
  }

  // A CLI server with no manifest beside it proves nothing and says so.
  const cli = await read(createSlicerService({ engine: "cli" }).app, "/engine");
  assert.equal(cli.attested, false, "a CLI binary with no manifest has no provenance to report");
  assert.equal(cli.engine, "cli");
  assert.match(cli.reason, /no engine provenance manifest/i);
});

test("a CLI engine attests its upstream commit, patch set, and the binary it will run", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orcaxr-cli-attest-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binaryPath = path.join(dir, "snapmaker-orca");
  await fs.writeFile(binaryPath, "#!/bin/sh\nexit 0\n");
  const digest = createHash("sha256").update(await fs.readFile(binaryPath)).digest("hex");

  const patchDirectory = new URL("./patches/", import.meta.url);
  const patchNames = (await fs.readdir(patchDirectory)).filter((name) => name.endsWith(".patch")).sort();
  const patches = [];
  for (const name of patchNames) {
    patches.push({
      name,
      sha256: createHash("sha256")
        .update(await fs.readFile(new URL(name, patchDirectory)))
        .digest("hex"),
    });
  }
  const manifestPath = path.join(dir, "engine-provenance.json");
  const manifest = {
    schemaVersion: 1,
    engine: { name: "snapmaker-orca", version: "2.3.4", commit: PINNED_ENGINE_COMMIT },
    patches,
    binary: { path: binaryPath, sha256: digest },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const read = async (route) => {
    const previous = process.env.ORCAXR_CLI_PROVENANCE;
    process.env.ORCAXR_CLI_PROVENANCE = manifestPath;
    try {
      const { createSlicerService } = await import(`./server.js?cli-attest=${encodeURIComponent(manifestPath)}`);
      const app = createSlicerService({ engine: "cli" }).app;
      return await new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", () => {
          const { port } = server.address();
          http
            .get({ host: "127.0.0.1", port, path: route }, (res) => {
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () => {
                server.close();
                resolve(JSON.parse(body));
              });
            })
            .on("error", (error) => {
              server.close();
              reject(error);
            });
        });
      });
    } finally {
      if (previous === undefined) delete process.env.ORCAXR_CLI_PROVENANCE;
      else process.env.ORCAXR_CLI_PROVENANCE = previous;
    }
  };

  const attestation = await read("/engine");
  assert.equal(attestation.engine, "cli");
  assert.equal(attestation.attested, true, "a CLI engine built from a pinned commit can prove itself");
  assert.equal(attestation.upstream.commit, PINNED_ENGINE_COMMIT);
  assert.deepEqual(attestation.patches, patches, "the patch set is part of the engine's identity");
  // The digest must come from the file on disk, not from the manifest, so a
  // swapped binary cannot inherit the manifest's good name.
  assert.equal(attestation.artifacts["snapmaker-orca"], digest);

  await fs.writeFile(binaryPath, "#!/bin/sh\nexit 1\n");
  const swapped = await read("/engine");
  assert.equal(swapped.attested, false, "a binary that no longer matches its manifest cannot attest");
  assert.match(swapped.reason, /does not match the provenance manifest/i);
});
