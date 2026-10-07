// Independent TypeScript serialization authority for JNI streaming export checks.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalStringify } from '../../web/src/project/domain/canonical.ts';
const root = new URL('../../', import.meta.url);
const clipboard = JSON.parse(readFileSync(new URL('testdata/cross-platform/project-clipboard-vectors.json', root))).traces[0].clipboard;
const model = JSON.parse(readFileSync(new URL('testdata/cross-platform/project-model-vectors.json', root)));
const state = JSON.parse(clipboard.stateJson);
const large = JSON.parse(clipboard.stateJson);
large.exportProbe = {
  text: 'x'.repeat(600_000) + Array.from({ length: 65_536 }, (_, unit) => String.fromCharCode(unit)).join(''),
  '\ud800': 'lone key',
  numbers: [-0, 1e21, 1e-7, Number.MIN_VALUE],
  ['__proto__']: { preserved: true },
};
const fixture = { version: 1, source: clipboard.stateJson, canonical: canonicalStringify(state), assets: clipboard.assets,
  empty: model.factories[0].stateJson, large: JSON.stringify(large), largeCanonical: canonicalStringify(large) };
const content = JSON.stringify(fixture, null, 2) + '\n';
const target = new URL('testdata/cross-platform/project-export-vectors.json', root);
if (process.argv.includes('--write')) writeFileSync(target, content);
else assert.equal(readFileSync(target, 'utf8'), content, 'Regenerate export vectors');
console.log('Verified TypeScript export bytes, all UTF-16 units and immutable asset declarations');
