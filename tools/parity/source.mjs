import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const UPSTREAM_COMMIT = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626";
export const UPSTREAM_REPOSITORY =
  "https://github.com/Snapmaker/OrcaSlicer.git";
export const EXTRACTOR_VERSION = "1.0.0";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../..");
const LOCAL_CHECKOUT = join(REPOSITORY_ROOT, "third_party", "SnapmakerOrca");
const FALLBACK_CACHE = join(
  homedir(),
  ".cache",
  "orcaxr",
  "parity",
  "SnapmakerOrca.git",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function git(repository, args, options = {}) {
  return run("git", ["-C", repository, ...args], options);
}

function containsCommit(repository, commit) {
  if (!existsSync(repository)) return false;
  const result = spawnSync(
    "git",
    ["-C", repository, "cat-file", "-e", `${commit}^{commit}`],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

/**
 * Resolve a repository containing the exact pinned object without reading its worktree.
 *
 * `commit` defaults to the pin. The drift audit (P12.1) is the only caller that
 * passes anything else, and it passes a commit it discovered rather than one
 * this module names — the pin is a constant here on purpose.
 */
export function resolveSourceRepository({
  allowFetch = true,
  commit = UPSTREAM_COMMIT,
} = {}) {
  const configured = process.env.SNAPMAKER_ORCA_REPO;
  const candidates = [configured, LOCAL_CHECKOUT, FALLBACK_CACHE].filter(
    Boolean,
  );
  for (const candidate of candidates) {
    if (containsCommit(candidate, commit)) return resolve(candidate);
  }

  if (!allowFetch) {
    throw new Error(
      `Snapmaker OrcaSlicer commit ${commit} is unavailable. ` +
        "Set SNAPMAKER_ORCA_REPO to a Git repository containing it.",
    );
  }

  mkdirSync(FALLBACK_CACHE, { recursive: true });
  if (!existsSync(join(FALLBACK_CACHE, "HEAD"))) {
    run("git", ["init", "--bare", FALLBACK_CACHE]);
  }
  run("git", [
    "-C",
    FALLBACK_CACHE,
    "fetch",
    "--no-tags",
    "--depth=1",
    UPSTREAM_REPOSITORY,
    commit,
  ]);
  if (!containsCommit(FALLBACK_CACHE, commit)) {
    throw new Error(`Fetch completed without the required commit ${commit}`);
  }
  return FALLBACK_CACHE;
}

function syntheticBlobId(text) {
  return `synthetic-sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Read-only view of exact Git blobs at the parity commit. Tests may supply in-memory
 * overrides; production extraction never reads dirty worktree files.
 */
export class PinnedSource {
  constructor({
    repository,
    overrides = new Map(),
    allowFetch = true,
    commit = UPSTREAM_COMMIT,
  } = {}) {
    this.commit = commit;
    this.repository =
      repository ?? resolveSourceRepository({ allowFetch, commit });
    this.overrides =
      overrides instanceof Map ? overrides : new Map(Object.entries(overrides));
    const resolved = git(this.repository, [
      "rev-parse",
      `${commit}^{commit}`,
    ]).trim();
    if (resolved !== commit) {
      throw new Error(`Expected ${commit}, resolved ${resolved}`);
    }
    this.tree = git(this.repository, ["rev-parse", `${commit}^{tree}`]).trim();
    this.cache = new Map();
  }

  listTree() {
    return git(this.repository, ["ls-tree", "-r", "--name-only", this.commit])
      .split("\n")
      .filter(Boolean);
  }

  hasPath(path) {
    if (this.overrides.has(path)) return true;
    const result = spawnSync(
      "git",
      ["-C", this.repository, "cat-file", "-e", `${this.commit}:${path}`],
      { encoding: "utf8" },
    );
    return result.status === 0;
  }

  read(path) {
    if (!this.hasPath(path))
      throw new Error(`Stale or missing upstream source path: ${path}`);
    if (this.cache.has(path)) return this.cache.get(path).text;
    const text = this.overrides.has(path)
      ? String(this.overrides.get(path))
      : git(this.repository, ["show", `${this.commit}:${path}`]);
    const blob = this.overrides.has(path)
      ? syntheticBlobId(text)
      : git(this.repository, ["rev-parse", `${this.commit}:${path}`]).trim();
    this.cache.set(path, { text, blob });
    return text;
  }

  blob(path) {
    this.read(path);
    return this.cache.get(path).blob;
  }

  sourceRecord(path) {
    return { path, blob: this.blob(path) };
  }
}
