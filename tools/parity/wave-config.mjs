// Reconstruct the build's config authority without reading or modifying an
// engine worktree. Clean clones use PinnedSource's existing object-cache fetch.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PinnedSource, REPOSITORY_ROOT } from "./source.mjs";

export function readWaveConfig() {
  const sourcePath = "src/libslic3r/PrintConfig.cpp";
  const source = new PinnedSource().read(sourcePath);
  const temporary = mkdtempSync(join(tmpdir(), "orcaxr-wave-config-"));
  try {
    const target = join(temporary, sourcePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    execFileSync(
      "git",
      ["apply", `--include=${sourcePath}`, "--whitespace=error-all"],
      {
        cwd: temporary,
        input: readFileSync(
          join(REPOSITORY_ROOT, "wasm/patches/snapmaker-fork-wasm-port.diff"),
        ),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return readFileSync(target, "utf8");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(readWaveConfig());
}
