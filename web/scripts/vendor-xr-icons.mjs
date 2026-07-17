#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, 'src', 'ui', 'icons.ts');
const packageDir = join(root, 'node_modules', '@material-symbols', 'svg-400', 'outlined');
const outputDir = join(root, 'public', 'icons', 'material');
const write = process.argv.includes('--write');

const catalog = await readFile(catalogPath, 'utf8');
const names = new Set([...catalog.matchAll(/\bxr:\s*'([a-z0-9_]+)'/g)].map((match) => match[1]));

// A few layout controls are intentionally not public action icons.
for (const name of ['chevron_right', 'close']) names.add(name);

const expected = new Map();
for (const name of [...names].sort()) {
  const sourcePath = join(packageDir, `${name}.svg`);
  let bytes;
  try {
    bytes = await readFile(sourcePath);
  } catch (error) {
    throw new Error(`Material Symbols 0.33.0 has no outlined icon ${name}`, {
      cause: error,
    });
  }
  expected.set(`${name}.svg`, bytes);
}
const expectedFiles = [...expected.keys()].sort();

if (write) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const [file, bytes] of expected) await writeFile(join(outputDir, file), bytes);
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(expectedFiles, null, 2)}\n`);
  console.log(`Vendored ${expected.size} offline XR icons.`);
  process.exit(0);
}

let actualFiles;
try {
  actualFiles = (await readdir(outputDir)).filter((file) => file.endsWith('.svg')).sort();
} catch (error) {
  throw new Error('Offline XR icons are missing; run npm run icons:vendor.', {
    cause: error,
  });
}

if (actualFiles.join('\n') !== expectedFiles.join('\n')) {
  throw new Error('Offline XR icon inventory is stale; run npm run icons:vendor.');
}
for (const [file, bytes] of expected) {
  const actual = await readFile(join(outputDir, file));
  if (!actual.equals(bytes)) {
    throw new Error(`Offline XR icon differs from pinned package: ${file}`);
  }
}
const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
if (JSON.stringify(manifest) !== JSON.stringify(expectedFiles)) {
  throw new Error('Offline XR icon manifest is stale; run npm run icons:vendor.');
}
console.log(`Verified ${expected.size} offline XR icons.`);
