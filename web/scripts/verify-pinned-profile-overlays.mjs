import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626';
const CATEGORIES = ['machine', 'process', 'filament'];
const VENDORS = ['Elegoo', 'Snapmaker'];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, '..', '..');
const upstreamRepository = join(repositoryRoot, 'third_party', 'SnapmakerOrca');
const profileRoot = join(repositoryRoot, 'web', 'public', 'profiles');
const lockPath = join(scriptDirectory, 'profile-overlays.lock.json');

const write = process.argv.includes('--write');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--write');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(', ')}`);
}

function runGitText(...arguments_) {
  return execFileSync('git', ['-C', upstreamRepository, ...arguments_], {
    encoding: 'utf8',
  });
}

function runGitBytes(...arguments_) {
  return execFileSync('git', ['-C', upstreamRepository, ...arguments_]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function listLocalProfiles() {
  const paths = [];
  for (const vendor of VENDORS) {
    for (const category of CATEGORIES) {
      const directory = join(profileRoot, vendor, category);
      if (!existsSync(directory)) continue;
      for (const filename of readdirSync(directory).sort()) {
        const absolutePath = join(directory, filename);
        if (!filename.endsWith('.json') || !statSync(absolutePath).isFile()) continue;
        paths.push(`${vendor}/${category}/${filename}`);
      }
    }
  }
  return paths.sort();
}

function readPinnedProfile(profilePath) {
  return runGitBytes('show', `${PINNED_COMMIT}:resources/profiles/${profilePath}`);
}

function parseLocalProfile(profilePath) {
  return JSON.parse(readFileSync(join(profileRoot, profilePath), 'utf8'));
}

function findMissingPinnedParents(profilePaths) {
  const records = profilePaths.map((path) => {
    const [vendor, category] = path.split('/');
    return { path, vendor, category, profile: parseLocalProfile(path) };
  });
  const scopedNames = new Set();
  const globalNameCounts = new Map();
  for (const record of records) {
    const name = record.profile.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    scopedNames.add(`${record.vendor}\0${record.category}\0${name}`);
    const globalKey = `${record.category}\0${name}`;
    globalNameCounts.set(globalKey, (globalNameCounts.get(globalKey) ?? 0) + 1);
  }

  const missing = new Map();
  const unresolved = [];
  for (const record of records) {
    const parentName = record.profile.inherits;
    if (typeof parentName !== 'string' || parentName.length === 0) continue;
    const scopedKey = `${record.vendor}\0${record.category}\0${parentName}`;
    const globalKey = `${record.category}\0${parentName}`;
    if (scopedNames.has(scopedKey) || globalNameCounts.get(globalKey) === 1) continue;

    const candidate = `${record.vendor}/${record.category}/${parentName}.json`;
    if (upstreamProfiles.has(candidate)) {
      const pinnedParent = JSON.parse(readPinnedProfile(candidate).toString('utf8'));
      if (pinnedParent.name === parentName) {
        missing.set(candidate, record.path);
        continue;
      }
    }
    unresolved.push(`${record.path} -> ${parentName}`);
  }
  return { missing, unresolved };
}

const upstreamAvailable = existsSync(join(upstreamRepository, '.git'));
if (!upstreamAvailable) {
  if (write) {
    throw new Error(
      `Refreshing the overlay needs the pinned upstream checkout at ${relative(repositoryRoot, upstreamRepository)}`,
    );
  }
  verifyAgainstLock();
  process.exit(process.exitCode ?? 0);
}

const actualCommit = runGitText('rev-parse', 'HEAD').trim();
if (actualCommit !== PINNED_COMMIT) {
  throw new Error(`SnapmakerOrca HEAD is ${actualCommit}; expected pinned ${PINNED_COMMIT}`);
}

const upstreamProfiles = new Set(
  runGitText(
    'ls-tree',
    '-r',
    '--name-only',
    PINNED_COMMIT,
    '--',
    ...VENDORS.map((vendor) => `resources/profiles/${vendor}`),
  )
    .split('\n')
    .filter((path) => path.endsWith('.json'))
    .map((path) => path.replace(/^resources\/profiles\//, '')),
);

let localProfiles = listLocalProfiles();
const driftedMirrors = [];
let updatedMirrors = 0;

for (const profilePath of localProfiles) {
  const localPath = join(profileRoot, profilePath);
  const localBytes = readFileSync(localPath);
  JSON.parse(localBytes.toString('utf8'));
  if (!upstreamProfiles.has(profilePath)) continue;

  const pinnedBytes = readPinnedProfile(profilePath);
  if (localBytes.equals(pinnedBytes)) continue;
  driftedMirrors.push(profilePath);
  if (write) {
    writeFileSync(localPath, pinnedBytes);
    updatedMirrors += 1;
  }
}

let addedParents = 0;
function completePinnedParentClosure() {
  for (;;) {
    const { missing, unresolved } = findMissingPinnedParents(localProfiles);
    const problems = [
      ...unresolved.map((problem) => `unresolved parent: ${problem}`),
      ...[...missing].map(([parent, child]) => `missing pinned parent: ${child} -> ${parent}`),
    ];
    if (unresolved.length > 0 || missing.size === 0 || !write) return problems;

    for (const parentPath of missing.keys()) {
      writeFileSync(join(profileRoot, parentPath), readPinnedProfile(parentPath));
      addedParents += 1;
    }
    localProfiles = listLocalProfiles();
  }
}
const closureProblems = completePinnedParentClosure();

if (write && closureProblems.some((problem) => problem.startsWith('unresolved parent:'))) {
  throw new Error(`Profile inheritance closure failed:\n${closureProblems.join('\n')}`);
}

const exactMirrors = localProfiles
  .filter((path) => upstreamProfiles.has(path))
  .map((path) => ({ path, sha256: sha256(readFileSync(join(profileRoot, path))) }));
const localAdaptations = localProfiles
  .filter((path) => !upstreamProfiles.has(path))
  .map((path) => ({
    path,
    sha256: sha256(readFileSync(join(profileRoot, path))),
  }));

const lock = {
  schemaVersion: 1,
  upstream: {
    repository: 'Snapmaker/SnapmakerOrca',
    commit: PINNED_COMMIT,
    profileRoot: 'resources/profiles',
  },
  policy: {
    exactMirrors:
      'Every local profile with the same vendor/category/filename as the pinned tree is byte-for-byte identical; its SHA-256 lets a checkout without the upstream clone verify the same bytes.',
    localAdaptations:
      'Profiles absent at the same path in the pinned tree are explicit OrcaXR target-printer adaptations locked by SHA-256.',
  },
  exactMirrors,
  localAdaptations,
};
const expectedLock = `${JSON.stringify(lock, null, 2)}\n`;

let lockMatches = existsSync(lockPath) && readFileSync(lockPath, 'utf8') === expectedLock;
if (write && !lockMatches) {
  writeFileSync(lockPath, expectedLock);
  lockMatches = true;
}

if (!write && driftedMirrors.length > 0) {
  console.error(
    `Pinned profile mirror drift (${driftedMirrors.length}):\n${driftedMirrors.map((path) => `  ${path}`).join('\n')}`,
  );
}
if (closureProblems.length > 0) {
  console.error(`Profile inheritance closure is incomplete:\n${closureProblems.join('\n')}`);
}
if (!lockMatches) {
  console.error(`Profile overlay lock is stale: ${relative(repositoryRoot, lockPath)}`);
}
if ((!write && driftedMirrors.length > 0) || closureProblems.length > 0 || !lockMatches) {
  console.error('Run `npm --prefix web run profiles:sync` to restore the pinned overlay.');
  process.exitCode = 1;
} else {
  console.log(
    `Pinned profile overlays: ${exactMirrors.length} exact mirrors, ${localAdaptations.length} locked local adaptations at ${PINNED_COMMIT}`,
  );
  if (write) {
    console.log(
      `Updated ${updatedMirrors} mirrored profile files, added ${addedParents} pinned parents, and refreshed the overlay lock.`,
    );
  }
}

/**
 * Verify the committed profile tree against the lock without the pinned
 * upstream checkout. This proves the shipped bytes are exactly the ones the
 * lock records; re-deriving the lock from the pinned commit still requires the
 * upstream clone and is reported as skipped so the weaker claim stays honest.
 */
function verifyAgainstLock() {
  if (!existsSync(lockPath)) {
    console.error(`Profile overlay lock is missing: ${relative(repositoryRoot, lockPath)}`);
    process.exitCode = 1;
    return;
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.upstream?.commit !== PINNED_COMMIT) {
    console.error(`Profile overlay lock does not describe schema 1 at ${PINNED_COMMIT}`);
    process.exitCode = 1;
    return;
  }
  const lockedEntries = [...(lock.exactMirrors ?? []), ...(lock.localAdaptations ?? [])];
  const problems = [];
  const lockedPaths = new Set();
  for (const entry of lockedEntries) {
    if (typeof entry?.path !== 'string' || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '')) {
      problems.push(`malformed lock entry: ${JSON.stringify(entry)}`);
      continue;
    }
    if (lockedPaths.has(entry.path)) {
      problems.push(`duplicate lock entry: ${entry.path}`);
      continue;
    }
    lockedPaths.add(entry.path);
    const absolutePath = join(profileRoot, entry.path);
    if (!existsSync(absolutePath)) {
      problems.push(`missing locked profile: ${entry.path}`);
      continue;
    }
    const bytes = readFileSync(absolutePath);
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      problems.push(`invalid JSON: ${entry.path} (${error.message})`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== entry.sha256) problems.push(`profile drift: ${entry.path} is ${actual}`);
  }
  for (const path of listLocalProfiles()) {
    if (!lockedPaths.has(path)) problems.push(`unlocked profile: ${path}`);
  }

  if (problems.length > 0) {
    console.error(`Pinned profile overlay verification failed:\n${problems.map((line) => `  ${line}`).join('\n')}`);
    console.error('Run `npm --prefix web run profiles:sync` with the pinned upstream checkout to restore it.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `Pinned profile overlays: ${lock.exactMirrors.length} exact mirrors and ${lock.localAdaptations.length} local adaptations match the lock at ${PINNED_COMMIT} ` +
      '(upstream re-derivation skipped: no pinned checkout).',
  );
}
