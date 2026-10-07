import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { opcLowercase } from '../serialization/opcLowercase';

const reference = JSON.parse(
  readFileSync(new URL('../../../../contracts/opc-lowercase.json', import.meta.url), 'utf8'),
) as {
  lower: [number, number[]][];
  contexts: { input: number[]; output: number[] }[];
};

await test('OPC casing matches Unicode 16 for every scalar and preserves isolated surrogates', () => {
  const mappings = new Map(reference.lower.map(([cp, out]) => [cp, String.fromCodePoint(...out)]));
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const input = String.fromCodePoint(cp);
    assert.equal(opcLowercase(input), mappings.get(cp) ?? input, `U+${cp.toString(16)}`);
  }
});

await test('OPC casing matches captured Final_Sigma contexts and scales with combining runs', () => {
  for (const row of reference.contexts) {
    assert.equal(opcLowercase(String.fromCharCode(...row.input)), String.fromCharCode(...row.output));
  }
  const marks = '\u0345'.repeat(100_000);
  assert.equal(opcLowercase(`AΣ${marks}Σ${marks}`), `aσ${marks}ς${marks}`);
});
