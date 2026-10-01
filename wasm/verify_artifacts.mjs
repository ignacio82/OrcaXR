import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readArtifactManifest, verifyArtifactSet } from "./artifact-set.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const manifest = readArtifactManifest(join(here, "artifact-provenance.json"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const tracked = execFileSync(
  "git",
  ["ls-files", "wasm/patches", "wasm/shim-include"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();
tracked.push("wasm/slic3r_wasm.cpp", "wasm/build_wasm_module_snapmaker.sh");
const inputLedger = tracked
  .map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}\n`)
  .join("");
const inputHash = sha256(inputLedger);
if (inputHash !== manifest.inputs.aggregateSha256) {
  throw new Error(`WASM source/patch provenance drift: ${inputHash}`);
}

// A present directory is a deployment claim, even if only one file arrived.
const present = (filename) => {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const checked = [];
const skipped = [];
for (const directory of manifest.publishedCopies) {
  verifyArtifactSet(join(root, directory), manifest);
  checked.push(directory);
}
for (const directory of manifest.optionalPublishedCopies ?? []) {
  if (!present(join(root, directory))) {
    skipped.push(directory);
    continue;
  }
  verifyArtifactSet(join(root, directory), manifest);
  checked.push(directory);
}
for (const directory of manifest.optionalPublishedSets ?? []) {
  if (!present(join(root, directory))) {
    skipped.push(directory);
    continue;
  }
  verifyArtifactSet(join(root, directory, "current"), manifest);
  checked.push(directory + "/current");
}
console.log(
  `WASM artifacts verified for ${manifest.engine.commit}: ${checked.join(", ")}` +
    (skipped.length
      ? ` (skipped absent deployment copies: ${skipped.join(", ")})`
      : ""),
);
