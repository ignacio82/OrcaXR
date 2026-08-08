import assert from 'node:assert/strict';
import type { FacetRefinementNode } from '../domain/model';
import { BbsFacetCodecError, decodeBbsFacetRoot, encodeBbsFacetRoot } from './bbsFacetCodec';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const assigned = (value: number): FacetRefinementNode<number> => ({
  kind: 'leaf',
  state: { kind: 'assigned', value },
});

test('matches pinned simple, extended, and base-15 continuation states', () => {
  assert.equal(
    encodeBbsFacetRoot(assigned(1), (value) => value),
    '4',
  );
  assert.equal(
    encodeBbsFacetRoot(assigned(2), (value) => value),
    '8',
  );
  assert.equal(
    encodeBbsFacetRoot(assigned(3), (value) => value),
    '0C',
  );
  assert.equal(
    encodeBbsFacetRoot(assigned(18), (value) => value),
    '0FC',
  );
  assert.equal(
    encodeBbsFacetRoot(assigned(255), (value) => value),
    'CFFFFFFFFFFFFFFFFC',
  );
  for (const state of [1, 2, 3, 18, 255]) {
    assert.deepEqual(
      decodeBbsFacetRoot(
        encodeBbsFacetRoot(assigned(state), (value) => value),
        (value) => value,
      ),
      assigned(state),
    );
  }
});

test('uses reverse child order and reverse hex output exactly', () => {
  const root: FacetRefinementNode<number> = {
    kind: 'split',
    splitSides: 1,
    specialSide: 0,
    children: [assigned(2), assigned(1)],
  };
  assert.equal(
    encodeBbsFacetRoot(root, (value) => value),
    '841',
  );
  assert.deepEqual(
    decodeBbsFacetRoot('841', (value) => value),
    root,
  );
  const split = (splitSides: 1 | 2 | 3, specialSide: 0 | 1 | 2, values: number[]) => ({
    kind: 'split' as const,
    splitSides,
    specialSide,
    children: values.map(assigned),
  });
  for (const [expected, candidate] of [
    ['845', split(1, 1, [2, 1])],
    ['849', split(1, 2, [2, 1])],
    ['0482', split(2, 0, [0, 1, 2])],
    ['0486', split(2, 1, [0, 1, 2])],
    ['048A', split(2, 2, [0, 1, 2])],
    ['0480C3', split(3, 0, [0, 1, 2, 3])],
  ] as const) {
    const normalized = {
      ...candidate,
      children: candidate.children.map((child) =>
        child.kind === 'leaf' && child.state.kind === 'assigned' && child.state.value === 0
          ? ({ kind: 'leaf', state: { kind: 'unpainted' } } as const)
          : child,
      ),
    };
    assert.equal(
      encodeBbsFacetRoot(normalized, (value) => value),
      expected,
    );
    assert.deepEqual(
      decodeBbsFacetRoot(expected, (value) => value),
      normalized,
    );
  }
  const nested: FacetRefinementNode<number> = {
    kind: 'split',
    splitSides: 2,
    specialSide: 1,
    children: [
      assigned(18),
      { kind: 'split', splitSides: 1, specialSide: 2, children: [assigned(1), assigned(255)] },
      { kind: 'leaf', state: { kind: 'unpainted' } },
    ],
  };
  assert.deepEqual(
    decodeBbsFacetRoot(
      encodeBbsFacetRoot(nested, (value) => value),
      (value) => value,
    ),
    nested,
  );
});

test('rejects truncated, trailing, invalid-channel, deep, and over-budget streams', () => {
  assert.throws(() => decodeBbsFacetRoot('3', (value) => value), BbsFacetCodecError);
  assert.throws(() => decodeBbsFacetRoot('44', (value) => value), /trailing data/);
  assert.throws(() => decodeBbsFacetRoot('8', () => undefined), /invalid for this channel/);
  assert.throws(() => decodeBbsFacetRoot('a', (value) => value), /uppercase hex/);
  assert.throws(() => decodeBbsFacetRoot('G', (value) => value), /uppercase hex/);
  assert.throws(() => decodeBbsFacetRoot('44D', (value) => value), /special side/);
  assert.throws(() => decodeBbsFacetRoot('44447', (value) => value), /special side/);
  assert.deepEqual(
    decodeBbsFacetRoot('0', (value) => value),
    { kind: 'leaf', state: { kind: 'unpainted' } },
  );
  const deepStream = [...new Array(65).fill(1), 0, ...new Array(65).fill(0)];
  const deepEncoded = deepStream
    .reverse()
    .map((nibble) => nibble.toString(16))
    .join('');
  assert.throws(() => decodeBbsFacetRoot(deepEncoded, (value) => value), /depth limit/);
  assert.throws(() => decodeBbsFacetRoot('4', (value) => value, { remainingNodes: 0 }), /node limit/);
});

console.log(`\nBBS facet codec: ${passed} tests passed.`);
