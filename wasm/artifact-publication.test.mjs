import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishArtifactSet } from "./publish-artifacts.mjs";
import { verifyArtifactSet, readArtifactManifest } from "./artifact-set.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = new URL("./verify_artifacts.mjs", import.meta.url);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orcaxr-artifacts-"));
  await fs.mkdir(path.join(root, "wasm/dist"), { recursive: true });
  await fs.copyFile(source, path.join(root, "wasm/verify_artifacts.mjs"));
  // The verifier must remain usable in clean clones, without engine source.
  for (const name of ["artifact-set.mjs", "publish-artifacts.mjs"]) {
    try {
      await fs.copyFile(new URL(name, source), path.join(root, "wasm", name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  execFileSync("git", ["init", "--quiet", root]);
  let ledger = "";
  for (const name of [
    "wasm/slic3r_wasm.cpp",
    "wasm/build_wasm_module_snapmaker.sh",
  ]) {
    await fs.writeFile(path.join(root, name), name);
    ledger += `${sha256(name)}  ${name}\n`;
  }
  const manifest = JSON.parse(
    await fs.readFile(
      new URL("./artifact-provenance.json", import.meta.url),
      "utf8",
    ),
  );
  manifest.inputs.aggregateSha256 = sha256(ledger);
  manifest.publishedCopies = ["wasm/dist"];
  manifest.optionalPublishedCopies = ["server/wasm-dist"];
  for (const name of Object.keys(manifest.outputs)) {
    const contents = `fixture ${name}`;
    manifest.outputs[name] = sha256(contents);
    await fs.writeFile(path.join(root, "wasm/dist", name), contents);
  }
  const encoded = JSON.stringify(manifest);
  await fs.writeFile(path.join(root, "wasm/artifact-provenance.json"), encoded);
  await fs.writeFile(
    path.join(root, "wasm/dist/artifact-provenance.json"),
    encoded,
  );
  return {
    root,
    manifest,
    check() {
      return spawnSync(process.execPath, ["wasm/verify_artifacts.mjs"], {
        cwd: root,
        encoding: "utf8",
      });
    },
    async close() {
      const writable = async (dir) => {
        await fs.chmod(dir, 0o755);
        for (const entry of await fs.readdir(dir, { withFileTypes: true }))
          if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(root);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("artifact verification rejects a stale adjacent manifest even when all binaries match", async () => {
  const f = await fixture();
  try {
    assert.equal(f.check().status, 0);
    f.manifest.outputs["slic3r.wasm"] = "0".repeat(64);
    await fs.writeFile(
      path.join(f.root, "wasm/dist/artifact-provenance.json"),
      JSON.stringify(f.manifest),
    );
    assert.notEqual(f.check().status, 0, "stale adjacent provenance must fail");
  } finally {
    await f.close();
  }
});

test("each required or present optional copy needs adjacent schema, source, files and hashes", async () => {
  const f = await fixture();
  const directory = path.join(f.root, "server/wasm-dist");
  try {
    await fs.cp(path.join(f.root, "wasm/dist"), directory, { recursive: true });
    assert.equal(f.check().status, 0);
    for (const [change, code] of [
      [
        (m) => {
          m.schemaVersion = 2;
        },
        "MANIFEST_SCHEMA",
      ],
      [
        (m) => {
          m.engine.commit = "0".repeat(40);
        },
        "SOURCE_IDENTITY",
      ],
      [
        (m) => {
          m.engine.tag = "v2.3.3";
        },
        "SOURCE_IDENTITY",
      ],
      [
        (m) => {
          delete m.inputs;
        },
        "INPUT_IDENTITY",
      ],
      [
        (m) => {
          m.inputs.aggregateSha256 = "0".repeat(64);
        },
        "MANIFEST_MISMATCH",
      ],
      [
        (m) => {
          m.outputs["unexpected.wasm"] = "0".repeat(64);
        },
        "OUTPUT_SCHEMA",
      ],
    ]) {
      const manifest = structuredClone(f.manifest);
      change(manifest);
      await fs.writeFile(
        path.join(directory, "artifact-provenance.json"),
        JSON.stringify(manifest),
      );
      assert.throws(() => verifyArtifactSet(directory, f.manifest), { code });
      assert.notEqual(f.check().status, 0, code);
    }
    await fs.copyFile(
      path.join(f.root, "wasm/artifact-provenance.json"),
      path.join(directory, "artifact-provenance.json"),
    );
    await fs.writeFile(path.join(directory, "slic3r.wasm"), "changed bytes");
    assert.throws(() => verifyArtifactSet(directory, f.manifest), {
      code: "ARTIFACT_HASH",
    });
    await fs.rm(path.join(directory, "slic3r.wasm"));
    assert.throws(() => verifyArtifactSet(directory, f.manifest), {
      code: "ARTIFACT_MISSING",
    });
    await fs.rm(path.join(directory, "artifact-provenance.json"));
    assert.throws(() => verifyArtifactSet(directory, f.manifest), {
      code: "MANIFEST_MISSING",
    });
  } finally {
    await f.close();
  }
});

test("atomic publication preserves old readers and never activates an invalid source", async () => {
  const f = await fixture();
  const sourceDir = path.join(f.root, "wasm/dist");
  const destination = path.join(f.root, "server/wasm-artifacts");
  try {
    const first = await publishArtifactSet(sourceDir, destination, f.manifest);
    const current = path.join(destination, "current");
    const oldReader = await fs.realpath(current);
    await fs.writeFile(
      path.join(sourceDir, "slic3r.wasm"),
      "incomplete next publication",
    );
    await assert.rejects(
      publishArtifactSet(sourceDir, destination, f.manifest),
      { code: "ARTIFACT_HASH" },
    );
    assert.equal(await fs.realpath(current), oldReader);
    assert.equal(verifyArtifactSet(oldReader).identity, first.identity);
    const next = structuredClone(f.manifest);
    next.outputs["slic3r.wasm"] = sha256("incomplete next publication");
    await fs.writeFile(
      path.join(sourceDir, "artifact-provenance.json"),
      JSON.stringify(next),
    );
    const readings = [];
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        // The worker resolves the pointer once, before opening either engine file.
        const resolved = await fs.realpath(current);
        readings.push(verifyArtifactSet(resolved).identity);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    let second;
    try {
      second = await publishArtifactSet(sourceDir, destination, next);
    } finally {
      stop = true;
      await reader;
    }
    assert.ok(readings.length > 0);
    assert.ok(
      readings.every(
        (identity) =>
          identity === first.identity || identity === second.identity,
      ),
    );
    assert.equal(verifyArtifactSet(current, next).identity, second.identity);
    assert.equal(
      verifyArtifactSet(oldReader, f.manifest).identity,
      first.identity,
    );
    const repeated = await Promise.all([
      publishArtifactSet(sourceDir, destination, next),
      publishArtifactSet(sourceDir, destination, next),
    ]);
    assert.ok(repeated.every((item) => item.identity === second.identity));
    assert.deepEqual((await fs.readdir(destination)).sort(), [
      "current",
      "sets",
    ]);
    assert.deepEqual(
      (await fs.readdir(path.join(destination, "sets"))).sort(),
      [first.identity, second.identity].sort(),
    );
  } finally {
    await f.close();
  }
});

test("publication interruption before activation leaves the previous complete set", async () => {
  const f = await fixture();
  const sourceDir = path.join(f.root, "wasm/dist");
  const destination = path.join(f.root, "versions");
  try {
    const old = await publishArtifactSet(sourceDir, destination, f.manifest);
    const next = structuredClone(f.manifest);
    next.outputs["slic3r.wasm"] = sha256("new engine bytes");
    await fs.writeFile(path.join(sourceDir, "slic3r.wasm"), "new engine bytes");
    await fs.writeFile(
      path.join(sourceDir, "artifact-provenance.json"),
      JSON.stringify(next),
    );
    // Simulate an interrupted prior staging write; it must never be a candidate.
    const interrupted = path.join(destination, "sets/.staging-interrupted");
    await fs.mkdir(interrupted);
    await fs.writeFile(path.join(interrupted, "slic3r.mjs"), "partial");
    assert.equal(
      verifyArtifactSet(path.join(destination, "current"), f.manifest).identity,
      old.identity,
    );
    const published = await publishArtifactSet(sourceDir, destination, next);
    assert.equal(
      verifyArtifactSet(path.join(destination, "current"), next).identity,
      published.identity,
    );
    assert.equal(
      readArtifactManifest(path.join(old.directory, "artifact-provenance.json"))
        .outputs["slic3r.wasm"],
      f.manifest.outputs["slic3r.wasm"],
    );
  } finally {
    await f.close();
  }
});

test("the first publication never exposes an incomplete deployment directory", async () => {
  const f = await fixture();
  const destination = path.join(f.root, "first-deployment");
  let finished = false;
  try {
    const publication = publishArtifactSet(
      path.join(f.root, "wasm/dist"),
      destination,
      f.manifest,
    ).finally(() => {
      finished = true;
    });
    const observations = [];
    while (!finished) {
      try {
        await fs.lstat(destination);
        try {
          verifyArtifactSet(path.join(destination, "current"), f.manifest);
        } catch (error) {
          observations.push(error.code);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await publication;
    assert.deepEqual(
      observations,
      [],
      "legacy readers must not see an unactivated deployment root",
    );
  } finally {
    await f.close();
  }
});

test("artifact verification rejects a present but partial optional deployment", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, "server/wasm-dist"), { recursive: true });
    await fs.copyFile(
      path.join(f.root, "wasm/dist/slic3r.mjs"),
      path.join(f.root, "server/wasm-dist/slic3r.mjs"),
    );
    assert.notEqual(f.check().status, 0, "partial deployment must fail");
  } finally {
    await f.close();
  }
});

test("simultaneous first publishers leave one complete readable deployment", async () => {
  const f = await fixture();
  const destination = path.join(f.root, "first-deployment");
  try {
    const publications = await Promise.all(
      Array.from({ length: 4 }, () =>
        publishArtifactSet(
          path.join(f.root, "wasm/dist"),
          destination,
          f.manifest,
        ),
      ),
    );
    const active = verifyArtifactSet(
      path.join(destination, "current"),
      f.manifest,
    );
    assert.ok(publications.every((item) => item.identity === active.identity));
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(active.directory)).mode & 0o777, 0o555);
    assert.equal(
      (await fs.readdir(f.root)).some((name) => name.includes("bootstrap")),
      false,
    );
  } finally {
    await f.close();
  }
});
