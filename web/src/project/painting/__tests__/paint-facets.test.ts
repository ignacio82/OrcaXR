import assert from 'node:assert/strict';

import { paintFacets, PaintFacetsRefusal, paintFacetColorsExchange } from '../PaintFacets';
import { paintOverlayFacets } from '../PaintOverlay';
import { channelOverlayColors, paintStateColor } from '../paintOverlayColors';
import { paintToolSampleExchange } from '../PaintToolExchange';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// A strip of eight facets.
const mesh = {
  vertices: Array.from({ length: 10 }, (_, i) => [i % 5, Math.floor(i / 5), 0] as [number, number, number]),
  triangles: Array.from({ length: 8 }, (_, t) => {
    const x = t >> 1;
    return (t % 2 === 0 ? [x, x + 1, x + 5] : [x + 1, x + 6, x + 5]) as unknown as readonly [number, number, number];
  }),
};
const assigned = (value: string) => ({ kind: 'assigned' as const, value });

test('whole facets come as runs of one state in source order, as the overlay draws them', () => {
  const regions = [
    { triangles: [6, 1, 2, 7], state: assigned('a') },
    { triangles: [3, 0], state: assigned('b') },
  ];
  const facets = paintFacets(8, 'color', regions);
  // Facet 0 is b, 1 and 2 are a, 3 is b, 6 and 7 are a: [first, count, state] runs.
  assert.deepEqual([...facets.runs], [0, 1, 1, 1, 2, 0, 3, 1, 1, 6, 2, 0]);
  assert.deepEqual(facets.states, [assigned('a'), assigned('b')]);
  assert.equal(facets.leafSources.length, 0);
  // The same facets and states the overlay draws.
  const overlay = paintOverlayFacets(mesh, 'color', regions);
  assert.deepEqual(overlay.states, facets.states);
  let whole = 0;
  for (let run = 0; run < facets.runs.length; run += 3) whole += facets.runs[run + 1];
  assert.equal(whole, overlay.stateIndices.length);
});

test('a facet two regions draw shows the later one; a facet past the mesh refuses', () => {
  const facets = paintFacets(8, 'support', [
    { triangles: [4], state: assigned('enforce') },
    { triangles: [4], state: assigned('block') },
  ]);
  assert.deepEqual([...facets.runs], [4, 1, 1]);
  assert.throws(
    () => paintFacets(8, 'support', [{ triangles: [8], state: assigned('enforce') }]),
    (error: unknown) => error instanceof PaintFacetsRefusal && error.code === 'invalid-annotations',
  );
});

test('states draw in their palette colour, fixed channel colours, or white', () => {
  const colors = channelOverlayColors('color', new Map([['f1', '#123456']]));
  assert.equal(paintStateColor(colors, assigned('f1')), '#123456');
  assert.equal(paintStateColor(colors, assigned('gone')), '#ffffff');
  assert.equal(paintStateColor(colors, { kind: 'unpainted' }), '#ffffff');
  assert.equal(
    paintStateColor(channelOverlayColors('fuzzySkin', new Map()), { kind: 'assigned', value: true }),
    '#bc8cff',
  );
  assert.equal(
    paintFacetColorsExchange(
      JSON.stringify({ channel: 'seam', filaments: { physical: [], mixed: [] }, states: ['avoid', 'prefer', null] }),
    ),
    '{"colors":["#ff9f43","#58a6ff","#ffffff"]}',
  );
});

test('the painter’s settings make the workspace’s sample, clamped to the gizmo limits', () => {
  const reply = JSON.parse(
    paintToolSampleExchange(
      JSON.stringify({
        channel: 'color',
        hit: { triangleIndex: 3, localPoint: [1, 2, 3], localCameraPosition: [0, 0, 50] },
        settings: { tool: 'circle', radiusMm: 20 },
        stateOrder: [],
      }),
    ),
  ) as { sample: string };
  const sample = JSON.parse(reply.sample) as { seedTriangle: number; tool: { circle: { radiusMm: number } } };
  assert.equal(sample.seedTriangle, 3);
  assert.equal(sample.tool.circle.radiusMm, 8);
  // A band starts at the hit's bed Z: the part's own Z unplaced, its placed Z on the bed.
  const band = (placement?: unknown) =>
    JSON.parse(
      paintToolSampleExchange(
        JSON.stringify({
          channel: 'color',
          hit: {
            triangleIndex: 3,
            localPoint: [1, 2, 3],
            localCameraPosition: [0, 0, 50],
            ...(placement ? { placement } : {}),
          },
          settings: { tool: 'heightRange' },
          stateOrder: [],
        }),
      ),
    ) as { sample?: string; error?: string; message?: string };
  const startZ = (reply: { sample?: string }) =>
    (JSON.parse(reply.sample!) as { tool: { heightRange: { startZMm: number } } }).tool.heightRange.startZMm;
  const unmoved = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  assert.equal(startZ(band()), 3);
  assert.equal(
    startZ(band({ instance: { ...unmoved, translationMm: [0, 0, 4], scale: [1, 1, 2] }, volume: unmoved })),
    10,
  );
  assert.deepEqual(band({ instance: { ...unmoved, scale: [1, 1, 0] }, volume: unmoved }), {
    error: 'invalid_hit',
    message: 'The paint placement must be finite and invertible',
  });
  assert.throws(() => paintToolSampleExchange('{}'), /invalid_request/);
});

console.log(`\nPaint facets: ${passed} tests passed.`);
