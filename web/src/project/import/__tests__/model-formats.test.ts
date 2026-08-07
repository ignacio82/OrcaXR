import assert from 'node:assert/strict';
import { zipSync } from 'fflate';

import {
  MalformedModelSourceError,
  SUPPORTED_MODEL_IMPORT_EXTENSIONS,
  UnsupportedModelFormatError,
  decodeModelImport,
  detectModelFormat,
} from '../formats';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

type Triangle = readonly [readonly number[], readonly number[], readonly number[]];

/** Unit cube at the origin, 12 triangles over 8 shared corners. */
const CUBE_CORNERS: readonly (readonly number[])[] = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
  [0, 10, 0],
  [0, 0, 10],
  [10, 0, 10],
  [10, 10, 10],
  [0, 10, 10],
];
const CUBE_FACES: readonly (readonly number[])[] = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
];
const CUBE_TRIANGLES: readonly Triangle[] = CUBE_FACES.map(
  (face) => [CUBE_CORNERS[face[0]], CUBE_CORNERS[face[1]], CUBE_CORNERS[face[2]]] as Triangle,
);

function binaryStl(
  triangles: readonly Triangle[],
  header = 'orcaxr fixture',
  declaredCount = triangles.length,
): Uint8Array {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  bytes.set(new TextEncoder().encode(header).subarray(0, 80), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, declaredCount, true);
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const corner of triangle) {
      view.setFloat32(offset, corner[0], true);
      view.setFloat32(offset + 4, corner[1], true);
      view.setFloat32(offset + 8, corner[2], true);
      offset += 12;
    }
  });
  return bytes;
}

function asciiStl(solids: readonly { name: string; triangles: readonly Triangle[] }[]): Uint8Array {
  const lines: string[] = [];
  for (const solid of solids) {
    lines.push(`solid ${solid.name}`);
    for (const triangle of solid.triangles) {
      lines.push('  facet normal 0 0 0', '    outer loop');
      for (const corner of triangle) lines.push(`      vertex ${corner[0]} ${corner[1]} ${corner[2]}`);
      lines.push('    endloop', '  endfacet');
    }
    lines.push(`endsolid ${solid.name}`);
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test('decodes binary STL into one welded indexed object in assumed millimetres', () => {
  const decoded = decodeModelImport(binaryStl(CUBE_TRIANGLES), { filename: 'cube.stl' });
  assert.equal(decoded.format, 'stl-binary');
  assert.equal(decoded.unitScaleToMm, 1);
  assert.equal(decoded.objects.length, 1);
  const volume = decoded.objects[0].volumes[0];
  assert.equal(volume.mesh.indices.length / 3, 12);
  assert.equal(volume.mesh.positions.length / 3, 8, 'identical corners weld into eight vertices');
  assert.equal(decoded.objects[0].instances.length, 1);
  assert.ok(decoded.notices.some((notice) => notice.code === 'stl-assumed-millimetres'));
});

test('binary STL decoding is byte-deterministic for identical input', () => {
  const bytes = binaryStl(CUBE_TRIANGLES);
  const first = decodeModelImport(bytes, { filename: 'cube.stl' });
  const second = decodeModelImport(bytes.slice(), { filename: 'cube.stl' });
  assert.deepEqual(
    Array.from(first.objects[0].volumes[0].mesh.positions),
    Array.from(second.objects[0].volumes[0].mesh.positions),
  );
  assert.deepEqual(
    Array.from(first.objects[0].volumes[0].mesh.indices),
    Array.from(second.objects[0].volumes[0].mesh.indices),
  );
});

test('merges multi-solid ASCII STL like the pinned engine and says so', () => {
  const bytes = asciiStl([
    { name: 'left', triangles: CUBE_TRIANGLES.slice(0, 6) },
    { name: 'right', triangles: CUBE_TRIANGLES.slice(6) },
  ]);
  const decoded = decodeModelImport(bytes, { filename: 'pair.stl' });
  assert.equal(decoded.format, 'stl-ascii');
  assert.equal(decoded.objects.length, 1);
  assert.equal(decoded.objects[0].volumes[0].mesh.indices.length / 3, 12);
  const merged = decoded.notices.find((notice) => notice.code === 'stl-multiple-solids-merged');
  assert.ok(merged && merged.message.includes('left'));
});

test('drops degenerate STL facets with an explicit repair notice', () => {
  const degenerate: Triangle = [CUBE_CORNERS[0], CUBE_CORNERS[0], CUBE_CORNERS[1]] as Triangle;
  const decoded = decodeModelImport(binaryStl([...CUBE_TRIANGLES, degenerate]), { filename: 'cube.stl' });
  assert.equal(decoded.objects[0].volumes[0].mesh.indices.length / 3, 12);
  const repair = decoded.notices.find((notice) => notice.code === 'degenerate-triangles-dropped');
  assert.ok(repair && repair.message.includes('1 degenerate triangle'));
});

test('imports OBJ objects as canonical objects and material sections as parts', () => {
  const obj = `# fixture
mtllib palette.mtl
o Bracket
usemtl shell
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
f 1 2 3 4
usemtl insert
v 0 0 5
v 10 0 5
v 10 10 5
f -3 -2 -1
o Spacer
v 0 0 20
v 10 0 20
v 10 10 20
f 8 9 10
`;
  const decoded = decodeModelImport(utf8(obj), {
    filename: 'parts.obj',
    resolveCompanion: (name) =>
      name === 'palette.mtl' ? utf8('newmtl shell\nKd 1 0 0\nnewmtl insert\nKd 0 0 1\n') : undefined,
  });
  assert.equal(decoded.format, 'obj');
  assert.deepEqual(
    decoded.objects.map((object) => object.name),
    ['Bracket', 'Spacer'],
  );
  assert.deepEqual(
    decoded.objects[0].volumes.map((volume) => volume.materialName),
    ['shell', 'insert'],
  );
  assert.equal(decoded.objects[0].volumes[0].colorHex, '#ff0000');
  assert.equal(decoded.objects[0].volumes[1].colorHex, '#0000ff');
  assert.equal(decoded.objects[0].volumes[0].mesh.indices.length / 3, 2, 'quad faces fan-triangulate');
  assert.equal(decoded.objects[1].volumes[0].mesh.indices.length / 3, 1);
  assert.ok(decoded.notices.some((notice) => notice.code === 'obj-polygons-triangulated'));
  assert.ok(decoded.notices.some((notice) => notice.code === 'obj-mtllib-loaded'));
});

test('reports an OBJ material library that is not part of the import', () => {
  const decoded = decodeModelImport(utf8('mtllib missing.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), {
    filename: 'lonely.obj',
  });
  const notice = decoded.notices.find((item) => item.code === 'obj-mtllib-not-loaded');
  assert.ok(notice && notice.message.includes('missing.mtl'));
});

test('rejects an OBJ face that references an undeclared vertex', () => {
  assert.throws(
    () => decodeModelImport(utf8('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n'), { filename: 'bad.obj' }),
    (error: unknown) =>
      error instanceof MalformedModelSourceError && error.reasonCode === 'invalid-geometry' && error.format === 'obj',
  );
});

test('decodes AMF units, materials, modifier roles, and constellation instances', () => {
  const amf = `<?xml version="1.0" encoding="UTF-8"?>
<amf unit="inch" version="1.1">
  <object id="7">
    <metadata type="name">Inch bracket</metadata>
    <mesh>
      <vertices>
        <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>0</x><y>0</y><z>1</z></coordinates></vertex>
      </vertices>
      <volume materialid="2">
        <metadata type="name">Body</metadata>
        <triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle>
      </volume>
      <volume>
        <metadata type="slic3r.modifier">1</metadata>
        <triangle><v1>0</v1><v2>1</v2><v3>3</v3></triangle>
      </volume>
    </mesh>
  </object>
  <material id="2">
    <metadata type="name">Crimson</metadata>
    <color><r>1</r><g>0</g><b>0</b></color>
  </material>
  <constellation id="9">
    <instance objectid="7"><deltax>0</deltax><deltay>0</deltay><deltaz>0</deltaz></instance>
    <instance objectid="7"><deltax>25</deltax><deltay>5</deltay><deltaz>0</deltaz><rz>90</rz></instance>
  </constellation>
</amf>
`;
  const decoded = decodeModelImport(utf8(amf), { filename: 'bracket.amf' });
  assert.equal(decoded.format, 'amf');
  assert.equal(decoded.sourceUnit, 'inch');
  assert.equal(decoded.unitScaleToMm, 25.4);
  assert.equal(decoded.objects.length, 1);
  assert.equal(decoded.objects[0].name, 'Inch bracket');
  assert.deepEqual(
    decoded.objects[0].volumes.map((volume) => volume.role),
    ['model', 'parameter-modifier'],
  );
  assert.equal(decoded.objects[0].volumes[0].materialName, 'Crimson');
  assert.equal(decoded.objects[0].volumes[0].colorHex, '#ff0000');
  assert.equal(decoded.objects[0].instances.length, 2);
  assert.deepEqual(decoded.objects[0].instances[1].transform.translationMm, [25, 5, 0]);
  const rotation = decoded.objects[0].instances[1].transform.rotation;
  assert.ok(Math.abs(rotation[2] - Math.SQRT1_2) < 1e-6 && Math.abs(rotation[3] - Math.SQRT1_2) < 1e-6);
  assert.ok(decoded.notices.some((notice) => notice.code === 'amf-unit-converted'));
});

test('reports unmapped AMF metadata instead of dropping it silently', () => {
  const amf = `<amf unit="millimeter">
  <object id="1">
    <metadata type="slic3r.layer_height">0.3</metadata>
    <mesh>
      <vertices>
        <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates></vertex>
        <vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex>
      </vertices>
      <volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume>
    </mesh>
  </object>
</amf>`;
  const decoded = decodeModelImport(utf8(amf), { filename: 'meta.amf' });
  const dropped = decoded.notices.find((notice) => notice.code === 'amf-metadata-not-imported');
  assert.ok(dropped && dropped.message.includes('slic3r.layer_height'));
});

test('refuses AMF documents that declare a DTD or external entity', () => {
  const hostile = `<?xml version="1.0"?>
<!DOCTYPE amf [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<amf unit="millimeter"><object id="1"/></amf>`;
  assert.throws(
    () => decodeModelImport(utf8(hostile), { filename: 'hostile.amf' }),
    (error: unknown) => error instanceof MalformedModelSourceError && error.reasonCode === 'invalid-syntax',
  );
});

test('imports a ZIP archive of models atomically and reports skipped members', () => {
  const archive = zipSync({
    'models/cube.stl': binaryStl(CUBE_TRIANGLES),
    'models/tri.obj': utf8('v 0 0 0\nv 5 0 0\nv 0 5 0\nf 1 2 3\n'),
    'readme.txt': utf8('not a model'),
  });
  const decoded = decodeModelImport(archive, { filename: 'bundle.zip' });
  assert.equal(decoded.format, 'zip-archive');
  assert.equal(decoded.objects.length, 2);
  assert.ok(decoded.notices.some((notice) => notice.code === 'archive-members-imported'));
  const skipped = decoded.notices.find((notice) => notice.code === 'archive-member-skipped');
  assert.ok(skipped && skipped.path === 'readme.txt');
});

test('fails the whole archive when one member is malformed', () => {
  const archive = zipSync({
    'good.stl': binaryStl(CUBE_TRIANGLES),
    'bad.obj': utf8('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n'),
  });
  assert.throws(
    () => decodeModelImport(archive, { filename: 'mixed.zip' }),
    (error: unknown) => error instanceof MalformedModelSourceError,
  );
});

test('rejects archive members that escape the package root', () => {
  const archive = zipSync({ '../escape.stl': binaryStl(CUBE_TRIANGLES) });
  assert.throws(
    () => decodeModelImport(archive, { filename: 'traversal.zip' }),
    (error: unknown) => error instanceof MalformedModelSourceError && error.reasonCode === 'unsafe-archive',
  );
});

test('routes a 3MF package to the project import flow instead of mesh decoding', () => {
  const archive = zipSync({ '[Content_Types].xml': utf8('<Types/>'), '3D/3dmodel.model': utf8('<model/>') });
  const detection = detectModelFormat(archive, 'project.3mf');
  assert.equal(detection.format, 'project-3mf');
  assert.equal(detection.decodable, false);
  assert.throws(
    () => decodeModelImport(archive, { filename: 'project.3mf' }),
    (error: unknown) => error instanceof UnsupportedModelFormatError && error.reasonCode === 'requires-project-import',
  );
});

test('never reinterprets a renamed archive as STL', () => {
  const archive = zipSync({ 'models/cube.stl': binaryStl(CUBE_TRIANGLES) });
  assert.throws(
    () => decodeModelImport(archive, { filename: 'disguised.stl' }),
    (error: unknown) =>
      error instanceof UnsupportedModelFormatError && error.reasonCode === 'extension-signature-mismatch',
  );
});

test('classifies STEP, SVG, and G-code with machine-readable reasons', () => {
  const step = utf8("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('bracket'),'2;1');\nENDSEC;\n");
  assert.throws(
    () => decodeModelImport(step, { filename: 'bracket.step' }),
    (error: unknown) => error instanceof UnsupportedModelFormatError && error.reasonCode === 'requires-native-kernel',
  );
  const svg = utf8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  assert.throws(
    () => decodeModelImport(svg, { filename: 'logo.svg' }),
    (error: unknown) => error instanceof UnsupportedModelFormatError && error.reasonCode === 'requires-emboss-workflow',
  );
  const gcode = utf8('; generated by OrcaXR\nG90\nG1 X10 Y10 E1 F1200\n');
  assert.throws(
    () => decodeModelImport(gcode, { filename: 'plate.gcode' }),
    (error: unknown) => error instanceof UnsupportedModelFormatError && error.reasonCode === 'not-a-model-format',
  );
});

test('rejects empty and unrecognised inputs without guessing a parser', () => {
  assert.throws(
    () => decodeModelImport(new Uint8Array(0), { filename: 'nothing.stl' }),
    (error: unknown) => error instanceof UnsupportedModelFormatError && error.reasonCode === 'empty-input',
  );
  const noise = Uint8Array.from({ length: 512 }, (_unused, index) => (index * 37 + 11) % 251);
  noise[0] = 0xfe;
  assert.throws(
    () => decodeModelImport(noise, { filename: 'noise.bin' }),
    (error: unknown) => error instanceof UnsupportedModelFormatError && error.reasonCode === 'unknown-signature',
  );
});

test('rejects a truncated binary STL rather than importing partial geometry', () => {
  const truncated = binaryStl(CUBE_TRIANGLES.slice(0, 4), 'truncated', 12);
  assert.throws(
    () => decodeModelImport(truncated, { filename: 'short.stl' }),
    (error: unknown) => error instanceof MalformedModelSourceError && error.reasonCode === 'truncated',
  );
});

test('enforces the triangle import limit', () => {
  assert.throws(
    () => decodeModelImport(binaryStl(CUBE_TRIANGLES), { filename: 'cube.stl', limits: { maxTriangles: 4 } }),
    (error: unknown) => error instanceof MalformedModelSourceError && error.reasonCode === 'limit-exceeded',
  );
});

test('publishes the supported extension list used by pickers and drag/drop', () => {
  assert.deepEqual([...SUPPORTED_MODEL_IMPORT_EXTENSIONS].sort(), ['amf', 'amfz', 'obj', 'stl', 'zip']);
});

console.log(`\nModel import formats: ${passed} tests passed.`);
