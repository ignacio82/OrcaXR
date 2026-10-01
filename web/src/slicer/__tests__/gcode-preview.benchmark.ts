import assert from 'node:assert/strict';
import { GcodePreviewSession } from '../GcodePreviewSession';
import { parseRichGcodeModel } from '../RichGcodeModel';

// Compare on the same runtime/host, alternating order to reduce warmup bias.
// Qualification's five paired ratios were 1.45–1.65 (median 1.59). A 2.5 median
// ceiling leaves approximately 50% headroom over that observed worst pair.
// This is a relative regression guard, not an absolute device latency promise.
const MAXIMUM_MEDIAN_RATIO = 2.5;
const source =
  'G90\nM83\n;LAYER_CHANGE\nG1 Z0.2 F1200\n;TYPE:Outer wall\n' + 'G1 X1 E0.02\nG1 X2 E0.02\n'.repeat(150_000);
function sample(windowed: boolean): number {
  globalThis.gc?.();
  const start = performance.now();
  const model = windowed
    ? GcodePreviewSession.fromGcode(source, { kind: 'file', name: 'generated-benchmark.gcode' }).model
    : parseRichGcodeModel(source);
  const elapsed = performance.now() - start;
  assert.equal(model.columns.count, windowed ? 240_000 : 300_002);
  return elapsed;
}
sample(false);
sample(true);
const pairs: { whole: number; windowed: number; ratio: number }[] = [];
for (let index = 0; index < 5; index++) {
  let whole: number;
  let windowed: number;
  if (index % 2 === 0) {
    whole = sample(false);
    windowed = sample(true);
  } else {
    windowed = sample(true);
    whole = sample(false);
  }
  pairs.push({ whole, windowed, ratio: windowed / whole });
}
const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
const ratio = median(pairs.map((pair) => pair.ratio));
console.log(
  JSON.stringify({
    fixture: '300002-record-single-layer',
    node: process.version,
    wholeMedianMs: +median(pairs.map((pair) => pair.whole)).toFixed(2),
    indexedWindowMedianMs: +median(pairs.map((pair) => pair.windowed)).toFixed(2),
    medianRatio: +ratio.toFixed(3),
    maximumMedianRatio: MAXIMUM_MEDIAN_RATIO,
  }),
);
assert.ok(
  ratio <= MAXIMUM_MEDIAN_RATIO,
  `Index/window parsing regressed to ${ratio.toFixed(2)} times the whole-parse reference`,
);
