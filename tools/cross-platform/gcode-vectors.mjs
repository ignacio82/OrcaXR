// Capture the production parser's existing behavioral regressions without
// modifying either the parser or its tests. Float32 columns compare by bits.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseRichGcodeModel, indexRichGcodeLayers, parseRichGcodeLayerWindow } from '../../web/src/slicer/RichGcodeModel.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'web/package.json'));
const ts = require('typescript');
const parserPath = resolve(root, 'web/src/slicer/RichGcodeModel.ts');
const testPath = resolve(root, 'web/src/slicer/__tests__/rich-gcode-model.test.ts');
const units = text => Array.from({length: text.length}, (_, i) => text.charCodeAt(i));
const snapshot = value => {
  if (value instanceof Float32Array) return {$f32: Array.from(new Uint32Array(value.buffer, value.byteOffset, value.length))};
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
    key === 'roles' && Array.isArray(value) ? value.map(units) : (key === 'message' || key === 'color') && typeof value === 'string' ? units(value) : snapshot(value)]));
  return value;
};
const cases = new Map();
const capture = (source, options = {}) => {
  const model = parseRichGcodeModel(source, options);
  const key = JSON.stringify({source, options});
  cases.set(key, {source, options, model: snapshot(model)});
  return model;
};
globalThis.__orcaxrCaptureGcode = capture;
const temporary = mkdtempSync(resolve(root, 'web/node_modules/.orcaxr-gcode-capture-'));
const originalLog = console.log;
try {
  writeFileSync(resolve(temporary, 'wrapper.mjs'), `export * from ${JSON.stringify(pathToFileURL(parserPath).href)}; export const parseRichGcodeModel = globalThis.__orcaxrCaptureGcode;\n`);
  const compiled = ts.transpileModule(readFileSync(testPath, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
  }).outputText.replace(/from\s+(['"])([^'"]+)\1/g, (match, quote, specifier) => {
    let target;
    if (specifier === '../RichGcodeModel') target = pathToFileURL(resolve(temporary, 'wrapper.mjs')).href;
    else if (specifier.startsWith('.')) target = pathToFileURL(resolve(dirname(testPath), specifier + '.ts')).href;
    else if (!specifier.startsWith('node:')) target = pathToFileURL(require.resolve(specifier)).href;
    return target ? `from ${JSON.stringify(target)}` : match;
  });
  writeFileSync(resolve(temporary, 'tests.mjs'), compiled);
  console.log = () => {};
  await import(pathToFileURL(resolve(temporary, 'tests.mjs')).href);
} finally {
  console.log = originalLog;
  delete globalThis.__orcaxrCaptureGcode;
  rmSync(temporary, {recursive: true, force: true});
}

// Supplement existing regressions with UTF-16 source spans and index boundaries.
capture(readFileSync(resolve(root, 'testdata/parity/fixtures/reference.gcode'), 'utf8'));
capture('\ufeff;TYPE:🐳 漢字\r\n;LAYER_CHANGE\r\nG1 X1 E1\r\nG1 X2 E2\n');
capture('; ignored 🐳\n;LAYER_CHANGE\nG1 X1 E1\n;LAYER_CHANGE\nG1 X2 E2\n', {limits: {records: 1}});
capture(Array.from({length: 8}, (_, i) => `G1 X${i + 1} E${i + 1}`).join('\n'), {limits: {records: 2}});
capture('G1 X10 Y0\nG2 X10 Y0 I-10 J0 E1\nG3 X10 Y0 I-10 J0 E2\n', {limits: {pathPoints: 80}});
capture('G1 X1\n;LAYER_CHANGE\nG1 X2\n', {limits: {inputCharacters: 14}});
capture('invalid\n???\nG1 Xbad\n', {limits: {warnings: 1}});
capture(';TYPE:\ud800\nG1 X1 E1\n;TYPE:\ufffd\nG1 X2 E2\n;TYPE:\udfff\nG1 X3 E3\n', {limits: {records: 1}});
capture('G1 X1 🐳\ud800\udfff\n;HEIGHT:\ud800\n;WIDTH:\udfff\n; MANUAL_TOOL_CHANGE \ud800\n;COLOR_CHANGE,T0,\udfff\n;COLOR_CHANGE,\ud800\n');
capture(';TYPE:\ud800\n;TYPE:\udfff\nG1 X1 E1\n', {limits: {roles: 1}, filamentColors: ['\ud800']});
capture('G20\nG91\nM83\n;TYPE:Outer wall\nG1 X1 Y1 Z.01 E.1\nG2 X1 Y0 I.5 J0 E.1\nG92 X0 E0\nG90\nG1 X1 Y2 E.4\n', {limits: {records: 1}});
let seed = 0x47cda789;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
for (let test = 0; test < 48; test++) {
  const source = ['G21', 'G90', 'M83', ';TYPE:Outer wall'];
  for (let line = 0; line < 14; line++) {
    if (line % 5 === 0) source.push(';LAYER_CHANGE');
    const x = (random() * 100).toFixed(7), y = (random() * 100).toFixed(7), e = (random() * 2 - 0.3).toFixed(8);
    source.push(line % 4 === 0 ? `G2 X${x} Y${y} I${(random() * 20 + 1).toFixed(5)} J-5 E${e} F1200`
      : `G1 X${x} Y${y} Z${(line * 0.1).toFixed(2)} E${e} F${(random() * 5000).toFixed(2)}`);
  }
  capture(source.join('\n'), {limits: {records: 5, pathPoints: 2000}});
}
const vectors = [...cases.values()].map((value, id) => {
  const index = indexRichGcodeLayers(value.source, value.options);
  const windows = index.entries.map((_, entry) => snapshot(parseRichGcodeLayerWindow(value.source, index, entry, entry, value.options)));
  const options = {...value.options};
  if (options.filamentColors) options.filamentColors = options.filamentColors.map(units);
  const boundedOptions = {...value.options, limits: {...value.options.limits, records: Math.min(240000, value.options.limits?.records ?? 240000)}};
  const boundedIndex = indexRichGcodeLayers(value.source, boundedOptions);
  const binding = {model: snapshot(parseRichGcodeModel(value.source, boundedOptions)), index: snapshot(boundedIndex),
    windows: boundedIndex.entries.map((_, entry) => snapshot(parseRichGcodeLayerWindow(value.source, boundedIndex, entry, entry, boundedOptions)))};
  return {id: `gcode-${id}`, sourceUnits: units(value.source), options, model: value.model, index: snapshot(index), windows, binding};
});
const authority = Object.fromEntries([parserPath, testPath].map(path => [path.slice(root.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')]));
const preamble = {schemaVersion: 1, authority, provenance: 'Existing production parser tests and deterministic synthetic inputs; text fields are UTF-16 code units, Float32 columns are raw bits; no private print files.'};
const content = JSON.stringify(preamble).slice(0, -1) + ',"vectors":[\n' + vectors.map(vector => JSON.stringify(vector)).join(',\n') + '\n]}\n';
const target = resolve(root, 'testdata/cross-platform/gcode-vectors.json');
if (process.argv.includes('--write')) writeFileSync(target, content);
else assert.equal(readFileSync(target, 'utf8'), content, 'G-code reference vectors drifted');
console.log(`Verified ${vectors.length} G-code parse/index traces and ${vectors.reduce((sum, vector) => sum + vector.windows.length, 0)} windows against production TypeScript`);
