import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { isCanonicalRequest } from '../../contracts/generated/core.ts';

const corpus = JSON.parse(readFileSync(new URL('../../testdata/cross-platform/request-ids.json', import.meta.url)));
for (const [kind, ids] of Object.entries(corpus)) {
  for (const id of ids) {
    assert.equal(isCanonicalRequest({protocolVersion: 1, requestId: id, operation: 'canonicalize', input: 'null'}), kind === 'valid', JSON.stringify(id));
  }
}
console.log('Generated TypeScript validator agrees with the shared request-ID corpus');
