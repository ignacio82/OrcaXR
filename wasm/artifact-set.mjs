import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const MANIFEST_NAME = "artifact-provenance.json";
export const PINNED_SOURCE = Object.freeze({
  repository: "https://github.com/Snapmaker/OrcaSlicer.git",
  tag: "v2.3.4",
  commit: "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626",
});
export const ARTIFACT_NAMES = Object.freeze(["slic3r.mjs", "slic3r.wasm"]);
const INPUT_PATHS = [
  "wasm/patches",
  "wasm/shim-include",
  "wasm/slic3r_wasm.cpp",
  "wasm/build_wasm_module_snapmaker.sh",
];
const HASH = /^[a-f0-9]{64}$/;
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export class ArtifactSetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactSetError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new ArtifactSetError(code, message);
};

export function validateArtifactManifest(manifest) {
  if (!plain(manifest) || manifest.schemaVersion !== 1)
    fail("MANIFEST_SCHEMA", "Unsupported artifact manifest schema.");
  if (
    !plain(manifest.engine) ||
    Object.entries(PINNED_SOURCE).some(
      ([key, value]) => manifest.engine[key] !== value,
    )
  ) {
    fail(
      "SOURCE_IDENTITY",
      "Artifact source identity does not match the pinned Snapmaker revision.",
    );
  }
  if (
    !plain(manifest.inputs) ||
    !HASH.test(manifest.inputs.aggregateSha256 ?? "") ||
    JSON.stringify(manifest.inputs.paths) !== JSON.stringify(INPUT_PATHS)
  )
    fail("INPUT_IDENTITY", "Invalid artifact build-input identity.");
  if (
    !plain(manifest.outputs) ||
    Object.keys(manifest.outputs).sort().join("|") !==
      ARTIFACT_NAMES.join("|") ||
    ARTIFACT_NAMES.some((name) => !HASH.test(manifest.outputs[name]))
  )
    fail(
      "OUTPUT_SCHEMA",
      "Artifact manifest must name exactly the expected engine files and SHA-256 digests.",
    );
  return manifest;
}

export function artifactIdentity(manifest) {
  validateArtifactManifest(manifest);
  return JSON.stringify({
    engine: PINNED_SOURCE,
    input: manifest.inputs.aggregateSha256,
    outputs: ARTIFACT_NAMES.map((name) => [name, manifest.outputs[name]]),
  });
}

function readManifestJson(filename) {
  let encoded;
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile())
      fail(
        "MANIFEST_MISSING",
        "The adjacent artifact manifest must be a regular file.",
      );
    if (stat.size > 1024 * 1024)
      fail(
        "MANIFEST_SCHEMA",
        "The adjacent artifact manifest exceeds its size limit.",
      );
    encoded = readFileSync(filename, "utf8");
  } catch (error) {
    if (error instanceof ArtifactSetError) throw error;
    fail(
      "MANIFEST_MISSING",
      "The adjacent artifact manifest is missing or unreadable.",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(encoded);
  } catch {
    fail(
      "MANIFEST_JSON",
      "The adjacent artifact manifest contains invalid JSON.",
    );
  }
  return manifest;
}

export function readArtifactManifest(filename) {
  return validateArtifactManifest(readManifestJson(filename));
}

/** Native manifests attest their pinned build and executable, not WASM hashes. */
export function verifyNativeArtifact(filename) {
  const manifest = readManifestJson(filename);
  if (!plain(manifest) || manifest.schemaVersion !== 1)
    fail("MANIFEST_SCHEMA", "Unsupported native engine manifest schema.");
  if (
    !plain(manifest.engine) ||
    manifest.engine.name !== "snapmaker-orca" ||
    manifest.engine.version !== PINNED_SOURCE.tag.slice(1) ||
    manifest.engine.commit !== PINNED_SOURCE.commit
  )
    fail(
      "SOURCE_IDENTITY",
      "Native engine source identity does not match the pinned Snapmaker revision.",
    );
  if (
    !Array.isArray(manifest.patches) ||
    manifest.patches.length > 64 ||
    manifest.patches.some(
      (patch) =>
        !plain(patch) ||
        typeof patch.name !== "string" ||
        !/^[A-Za-z0-9_-]+\.patch$/.test(patch.name) ||
        !HASH.test(patch.sha256 ?? ""),
    ) ||
    new Set(manifest.patches.map((patch) => patch.name)).size !==
      manifest.patches.length
  )
    fail("MANIFEST_SCHEMA", "Invalid native engine patch identities.");
  const binary = manifest.binary;
  if (
    !plain(binary) ||
    typeof binary.path !== "string" ||
    !path.isAbsolute(binary.path) ||
    path.basename(binary.path) !== "snapmaker-orca" ||
    !HASH.test(binary.sha256 ?? "")
  )
    fail("MANIFEST_SCHEMA", "Invalid native engine executable identity.");
  let digest;
  try {
    if (!lstatSync(binary.path).isFile())
      fail(
        "ARTIFACT_MISSING",
        "The native engine executable must be a regular file.",
      );
    digest = sha256(readFileSync(binary.path));
  } catch (error) {
    if (error instanceof ArtifactSetError) throw error;
    fail(
      "ARTIFACT_MISSING",
      "The native engine executable is missing or unreadable.",
    );
  }
  if (digest !== binary.sha256)
    fail(
      "ARTIFACT_HASH",
      "The native engine executable does not match the provenance manifest.",
    );
  return { manifest, artifacts: { "snapmaker-orca": digest } };
}

/** Resolve the directory once: an atomic current-pointer change cannot mix sets. */
export function verifyArtifactSet(directory, expectedManifest) {
  let resolved;
  try {
    resolved = realpathSync(directory);
  } catch {
    fail("SET_MISSING", "The artifact set directory is missing.");
  }
  const manifest = readArtifactManifest(path.join(resolved, MANIFEST_NAME));
  if (
    expectedManifest &&
    artifactIdentity(manifest) !== artifactIdentity(expectedManifest)
  ) {
    fail(
      "MANIFEST_MISMATCH",
      "The adjacent artifact manifest does not match canonical provenance.",
    );
  }
  const artifacts = {};
  for (const name of ARTIFACT_NAMES) {
    const filename = path.join(resolved, name);
    try {
      if (!lstatSync(filename).isFile())
        fail("ARTIFACT_MISSING", `Artifact ${name} must be a regular file.`);
      artifacts[name] = sha256(readFileSync(filename));
    } catch (error) {
      if (error instanceof ArtifactSetError) throw error;
      fail("ARTIFACT_MISSING", `Artifact ${name} is missing or unreadable.`);
    }
    if (artifacts[name] !== manifest.outputs[name])
      fail(
        "ARTIFACT_HASH",
        `Artifact ${name} does not match the provenance manifest.`,
      );
  }
  return {
    directory: resolved,
    manifest,
    artifacts,
    identity: sha256(artifactIdentity(manifest)),
  };
}
