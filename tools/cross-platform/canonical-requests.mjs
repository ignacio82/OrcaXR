// Raw request fixtures target the transport envelope, separately from input JSON.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const schemaBytes = readFileSync(new URL('contracts/core-protocol.json', root));
const schema = JSON.parse(schemaBytes);
assert.equal(schema.type, 'object');
assert.equal(schema.additionalProperties, false);
assert.equal(schema.properties.protocolVersion.const, 1);
const base = {protocolVersion: 1, requestId: 'probe', operation: 'canonicalize', input: 'null'};
const encoded = JSON.stringify(base);
const cases = [];
function success(id, request, canonical = 'null') {
  cases.push({id, request, type: 'canonicalized', requestId: 'probe', canonical});
}
function error(id, request, code = 'invalid_request', requestId = null) {
  cases.push({id, request, type: 'error', requestId, code});
}
success('object', encoded);
success('reordered', JSON.stringify({input: 'null', operation: 'canonicalize', requestId: 'probe', protocolVersion: 1}));
success('whitespace', ' \n' + JSON.stringify(base, null, 2) + '\t\r\n');
success('decimal-version', encoded.replace('"protocolVersion":1', '"protocolVersion":1.0'));
success('exponent-version', encoded.replace('"protocolVersion":1', '"protocolVersion":1e0'));
success('escaped-field', encoded.replace('operation', 'operat\\u0069on'));
success('input-array', JSON.stringify({...base, input: '[1,{"z":null}]'}), '[1,{"z":null}]');
success('input-duplicate-keeps-last', JSON.stringify({...base, input: '{"a":1,"a":2}'}), '{"a":2}');
error('positional-envelope', JSON.stringify(Object.values(base)));
error('extra-positional-field', JSON.stringify([...Object.values(base), 5]));
error('short-positional-envelope', JSON.stringify(Object.values(base).slice(0, -1)));
for (const [id, request] of Object.entries({empty: '', object: '{}', array: '[]', null: 'null', number: '1', boolean: 'true', string: '"value"', truncated: encoded.slice(0,-1), trailing: encoded + '{}'}))
  error('invalid-' + id, request);
for (const key of Object.keys(base)) {
  const missing = {...base}; delete missing[key];
  error('missing-' + key, JSON.stringify(missing));
  error('null-' + key, JSON.stringify({...base, [key]: null}));
  error('duplicate-' + key, encoded.slice(0,-1) + ',' + JSON.stringify(key) + ':' + JSON.stringify(base[key]) + '}');
}
error('escaped-duplicate', encoded.slice(0,-1) + ',"operat\\u0069on":"canonicalize"}');
error('unknown-field', encoded.slice(0,-1) + ',"private":"PRIVATE_MARKER"}');
error('prototype-field', encoded.slice(0,-1) + ',"__proto__":{}}');
error('object-input', JSON.stringify({...base, input: {private: 'PRIVATE_MARKER'}}));
error('array-input', JSON.stringify({...base, input: ['PRIVATE_MARKER']}));
error('number-input', JSON.stringify({...base, input: 0}));
error('boolean-version', JSON.stringify({...base, protocolVersion: true}));
error('string-version', JSON.stringify({...base, protocolVersion: '1'}));
for (const version of [0, 2, -1, 1.5])
  error('unsupported-version-' + version, JSON.stringify({...base, protocolVersion: version}), 'unsupported_protocol');
error('unsupported-operation', JSON.stringify({...base, operation: 'unknown'}));
error('invalid-id', JSON.stringify({...base, requestId: 'PRIVATE_MARKER with spaces'}));
error('inner-json-error', JSON.stringify({...base, input: '{"PRIVATE_MARKER":'}), 'invalid_json', 'probe');
success('valid-after-rejections', encoded);
assert.equal(new Set(cases.map(row => row.id)).size, cases.length);
const corpus = {schemaVersion: 1, description: 'Raw canonical request envelope conformance. Duplicate keys inside the input JSON retain canonical last-key-wins behavior.',
  contractSha256: createHash('sha256').update(schemaBytes).digest('hex'), cases};
const target = new URL('testdata/cross-platform/canonical-requests.json', root);
const output = JSON.stringify(corpus, null, 2) + '\n';
if (process.argv.includes('--write')) writeFileSync(target, output);
else assert.equal(readFileSync(target,'utf8'), output, 'Canonical request fixtures need regeneration');
console.log(`Verified ${cases.length} raw canonical request cases`);
