import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const assets = join(dist, 'assets');
const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(join(assets, name)).size }));
const js = files.filter((file) => extname(file.name) === '.js');
const css = files.filter((file) => extname(file.name) === '.css');
const main = js.find((file) => file.name.startsWith('index-'));

assert.ok(main, 'No production index JavaScript chunk was emitted.');
assert.ok(main.bytes <= 2_200_000, `Main chunk ${main.name} is ${main.bytes} bytes (budget 2,200,000).`);
for (const file of js) {
  assert.ok(file.bytes <= 5_200_000, `Chunk ${file.name} is ${file.bytes} bytes (budget 5,200,000).`);
}
const jsTotal = js.reduce((sum, file) => sum + file.bytes, 0);
const cssTotal = css.reduce((sum, file) => sum + file.bytes, 0);
assert.ok(jsTotal <= 10_000_000, `JavaScript total is ${jsTotal} bytes (budget 10,000,000).`);
assert.ok(cssTotal <= 200_000, `CSS total is ${cssTotal} bytes (budget 200,000).`);
console.log(`Bundle budgets passed: main=${main.bytes}, JS total=${jsTotal}, CSS total=${cssTotal}.`);
