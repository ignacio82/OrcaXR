import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(root, 'src');
const args = process.argv.slice(2);
// `--exclude <substring>` keeps a slow family out of a suite without moving the
// files: the WASM slice tests belong with the project code they exercise, but
// running them ahead of the browser suites starves those of CPU.
const excludes = [];
const filters = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--exclude') {
    const value = args[index + 1];
    if (value) excludes.push(value);
    index += 1;
    continue;
  }
  filters.push(args[index]);
}

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? collect(path) : [path];
  });
}

const tests = collect(sourceRoot)
  .filter((file) => file.endsWith('.test.ts'))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .filter((file) => !excludes.some((exclude) => file.includes(exclude)))
  .sort();

if (tests.length === 0) {
  console.error(`No TypeScript tests matched: ${filters.join(', ') || '(all)'}`);
  process.exit(1);
}

const failures = [];
for (const file of tests) {
  const display = relative(root, file);
  console.log(`\n[TEST] ${display}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', file], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
  });
  if (result.status !== 0) failures.push(display);
}

console.log(`\n${tests.length - failures.length}/${tests.length} test files passed.`);
if (failures.length > 0) {
  console.error(`Failed:\n${failures.map((file) => `  - ${file}`).join('\n')}`);
  process.exit(1);
}
