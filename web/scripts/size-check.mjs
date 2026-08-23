import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

function resolveHtmlEntryChunk(indexHtml, emittedJs) {
  const sources = [...indexHtml.matchAll(/<script\b[^>]*>/gi)]
    .filter(([tag]) => /\btype\s*=\s*(["'])module\1/i.test(tag))
    .map(([tag]) => /\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2])
    .filter(Boolean)
    .map((source) => decodeURIComponent(source.split(/[?#]/, 1)[0]));
  assert.equal(sources.length, 1, `Expected exactly one module entry script in index.html, found ${sources.length}.`);
  const source = sources[0];
  assert.match(source, /(?:^|\/)assets\/[^/]+\.js$/, `Unexpected production entry path ${source}.`);
  const name = basename(source);
  const matches = emittedJs.filter((file) => file.name === name);
  assert.equal(matches.length, 1, `Production entry ${name} was not emitted exactly once.`);
  return matches[0];
}

function selfTestEntryResolution() {
  const emitted = [
    { name: 'index-helper.js', bytes: 7_251 },
    { name: 'index-entry.js', bytes: 2_072_668 },
  ];
  assert.equal(
    resolveHtmlEntryChunk('<script type="module" crossorigin src="/assets/index-entry.js"></script>', emitted).name,
    'index-entry.js',
  );
  assert.throws(() => resolveHtmlEntryChunk('<script type="module" src="/assets/missing.js"></script>', emitted));
  assert.throws(() => resolveHtmlEntryChunk('<script type="module" src="../outside.js"></script>', emitted));
}

selfTestEntryResolution();

const dist = resolve(import.meta.dirname, '..', 'dist');
const assets = join(dist, 'assets');
const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(join(assets, name)).size }));
const js = files.filter((file) => extname(file.name) === '.js');
const css = files.filter((file) => extname(file.name) === '.css');
const main = resolveHtmlEntryChunk(readFileSync(join(dist, 'index.html'), 'utf8'), js);

assert.ok(main.bytes <= 2_350_000, `Main chunk ${main.name} is ${main.bytes} bytes (budget 2,350,000).`);
for (const file of js) {
  assert.ok(file.bytes <= 5_200_000, `Chunk ${file.name} is ${file.bytes} bytes (budget 5,200,000).`);
}
const jsTotal = js.reduce((sum, file) => sum + file.bytes, 0);
const cssTotal = css.reduce((sum, file) => sum + file.bytes, 0);
// Roughly 7.2 MB of the total is pinned vendor code — the splat renderer, three,
// uikit, the bundled font, the XR Blocks vision/audio bundles — which no feature
// work can move. The total is a ceiling on that floor, not the regression signal;
// the main-chunk budget above is what actually catches a feature growing the app.
// Raised from 10,000,000 on 2026-08-16 when P6.4 landed with 18 KB of headroom left.
assert.ok(jsTotal <= 10_500_000, `JavaScript total is ${jsTotal} bytes (budget 10,500,000).`);
assert.ok(cssTotal <= 200_000, `CSS total is ${cssTotal} bytes (budget 200,000).`);
console.log(`Bundle budgets passed: main=${main.bytes}, JS total=${jsTotal}, CSS total=${cssTotal}.`);
