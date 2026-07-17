import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(root, 'src');
const filters = process.argv.slice(2);

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? collect(path) : [path];
  });
}

const tests = collect(sourceRoot)
  .filter((file) => file.endsWith('.test.ts'))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
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
