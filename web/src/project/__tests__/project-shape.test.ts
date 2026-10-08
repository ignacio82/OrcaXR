import assert from 'node:assert/strict';

import { cloneJson } from '../domain/canonical';
import { assertProjectShape } from '../domain/projectShape';
import { admitCanonicalState } from '../serialization/CanonicalEnvelope';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const fixture = createProjectFixture({ withObject: true });
type Json = Record<string, any>;
/** The fixture's state with one edit applied. */
function edited(edit: (state: Json) => void): Json {
  const state = cloneJson(fixture.state) as unknown as Json;
  edit(state);
  return state;
}
function refused(edit: (state: Json) => void, at: RegExp): void {
  const state = edited(edit);
  assert.throws(() => assertProjectShape(state), at);
  assert.throws(() => admitCanonicalState(state as never), at);
}

test('a complete state has the schema-1 shape', () => {
  assertProjectShape(fixture.state);
  assert.ok(admitCanonicalState(fixture.state).state);
});

// Found against the native core: the browser admitted canonical envelopes
// whose state lacked fields schema 1 requires, which native decode refused.
test('required fields the old checks missed are refused', () => {
  refused((s) => delete s.sourceAssets[0].mediaType, /at sourceAssets\[0\]\.mediaType: missing field/);
  refused((s) => delete s.plates[0].printable, /at plates\[0\]\.printable: missing field/);
  refused((s) => delete s.plates[0].objects[0].name, /at plates\[0\]\.objects\[0\]\.name: missing field/);
  refused(
    (s) => delete s.sourceAssets[0].mesh.positions.componentCount,
    /at sourceAssets\[0\]\.mesh\.positions\.componentCount: missing field/,
  );
});

test('an optional field may be absent but never null', () => {
  admitCanonicalState(edited((s) => delete s.sourceAssets[0].sourceFilename) as never);
  refused((s) => (s.sourceAssets[0].sourceFilename = null), /sourceFilename: expected text/);
  refused((s) => (s.plates[0].objects[0].extensionData = null), /extensionData: expected an object/);
});

test('literals, tuples, identifiers and numbers are checked as native decodes them', () => {
  refused((s) => (s.sourceAssets[0].mesh.positions.componentType = 'float64'), /unsupported MeshComponentType/);
  refused((s) => (s.sourceAssets[0].mesh.positions.componentCount = 5), /unsupported ComponentCount/);
  refused((s) => (s.plates[0].objects[0].instances[0].transform.rotation = [0, 0, 1]), /expected 4 items/);
  refused((s) => (s.plates[0].objects[0].id = 'not stable'), /expected a stable entity ID/);
  refused((s) => (s.printer.toolCount = Number.POSITIVE_INFINITY), /expected a finite number/);
  refused((s) => (s.config.future = [Number.NaN]), /at config: expected finite numbers/);
});

test('unknown fields are kept when finite', () => {
  const admitted = admitCanonicalState(edited((s) => (s.plates[0].future = { retained: [1, 'two'] })) as never);
  assert.deepEqual((admitted.state.plates[0] as unknown as Json).future, { retained: [1, 'two'] });
  refused((s) => (s.plates[0].future = Number.NEGATIVE_INFINITY), /at plates\[0\]\.future: expected finite numbers/);
});

test('mixed distributions decode by mode', () => {
  const mixed = (s: Json) => s.filaments.mixed[0];
  refused((s) => (mixed(s).distribution = { mode: 'spiral' }), /distribution\.mode: unsupported distribution mode/);
  refused((s) => (mixed(s).distribution = { mode: 'match' }), /distribution\.targetColor: missing field/);
  refused((s) => (mixed(s).distribution = { mode: 'cycle', cycleLengthMm: null }), /cycleLengthMm: expected a number/);
});

test('facet assignments are { value, triangles } entries of the channel type', () => {
  const annotations = (s: Json) => s.plates[0].objects[0].volumes[0].annotations;
  refused((s) => (annotations(s).support = [{ value: 'paint', triangles: [0] }]), /unsupported SupportPaint/);
  refused((s) => (annotations(s).seam = [{ value: 'prefer' }]), /seam\[0\]\.triangles: missing field/);
  refused(
    (s) => (annotations(s).brim = [{ value: true, triangles: ['0'] }]),
    /brim\[0\]\.triangles\[0\]: expected a number/,
  );
  refused((s) => (annotations(s).color = {}), /color: expected an array/);
});

console.log(`project shape: ${passed} passed`);
