import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_NAMES,
  MANIFEST_NAME,
  readArtifactManifest,
  verifyArtifactSet,
} from "./artifact-set.mjs";

async function syncPath(filename) {
  const file = await fs.open(filename, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Immutable version directories plus one atomic pointer; old readers keep their set. */
export async function publishArtifactSet(
  source,
  destination,
  expectedManifest,
) {
  const verified = verifyArtifactSet(source, expectedManifest);
  const root = path.resolve(destination);
  try {
    await fs.lstat(root);
    return publishInto(verified, root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // A legacy deployment must keep serving until the first versioned root is
  // complete too. Creating its visible root before current exists would make
  // the fail-closed resolver select a partially published deployment.
  const parent = path.dirname(root);
  await fs.mkdir(parent, { recursive: true });
  const bootstrap = await fs.mkdtemp(
    path.join(parent, `.${path.basename(root)}.bootstrap-`),
  );
  try {
    await publishInto(verified, bootstrap);
    await fs.chmod(bootstrap, 0o755);
    await syncPath(bootstrap);
    try {
      await fs.rename(bootstrap, root);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      // A simultaneous first publisher won. Add our verified version through
      // the ordinary atomic-pointer path; never replace that directory.
      return await publishInto(verified, root);
    }
    await syncPath(parent);
    return verifyArtifactSet(
      path.join(root, "sets", verified.identity),
      verified.manifest,
    );
  } finally {
    await fs
      .chmod(path.join(bootstrap, "sets", verified.identity), 0o755)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    await fs.rm(bootstrap, { recursive: true, force: true });
  }
}

async function publishInto(verified, root) {
  const versions = path.join(root, "sets");
  await fs.mkdir(versions, { recursive: true });
  const staged = await fs.mkdtemp(path.join(versions, ".staging-"));
  const target = path.join(versions, verified.identity);
  const pointer = path.join(root, `.current-${randomUUID()}`);
  try {
    for (const name of [...ARTIFACT_NAMES, MANIFEST_NAME]) {
      await fs.copyFile(
        path.join(verified.directory, name),
        path.join(staged, name),
      );
      await fs.chmod(path.join(staged, name), 0o444);
      await syncPath(path.join(staged, name));
    }
    // Re-read copied bytes: a changing or interrupted source cannot activate.
    verifyArtifactSet(staged, verified.manifest);
    await syncPath(staged);
    try {
      await fs.rename(staged, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      verifyArtifactSet(target, verified.manifest);
    }
    await fs.chmod(target, 0o555);
    await syncPath(versions);
    await fs.symlink(path.relative(root, target), pointer, "dir");
    await fs.rename(pointer, path.join(root, "current"));
    await syncPath(root);
    return verifyArtifactSet(target, verified.manifest);
  } finally {
    await fs.rm(pointer, { force: true });
    await fs.rm(staged, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, destination, manifestPath] = process.argv.slice(2);
  if (!source || !destination || !manifestPath)
    throw new Error(
      "Usage: node publish-artifacts.mjs SOURCE VERSION_ROOT CANONICAL_MANIFEST",
    );
  const result = await publishArtifactSet(
    source,
    destination,
    readArtifactManifest(manifestPath),
  );
  console.log(`Published verified artifact set ${result.identity}`);
}
