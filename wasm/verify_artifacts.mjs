import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const manifest = JSON.parse(
  readFileSync(join(here, "artifact-provenance.json"), "utf8"),
);
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

for (const [name, expected] of Object.entries(manifest.outputs)) {
  for (const directory of manifest.publishedCopies) {
    const path = join(root, directory, name);
    const actual = sha256(readFileSync(path));
    if (actual !== expected) {
      throw new Error(
        `${relative(root, path)} hash mismatch: ${actual} != ${expected}`,
      );
    }
  }
}

console.log(
  `WASM artifacts verified for ${manifest.engine.commit}: ` +
    Object.keys(manifest.outputs).join(", "),
);
