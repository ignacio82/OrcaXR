import assert from 'node:assert/strict';

import {
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  UuidIdSource,
  identityTransform,
  seededRandom,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';
import { AddSvgPartCommand, EditSvgPartCommand, prepareSvgPart, svgVolumeIdentity } from '../svgCommands';
import { SvgError } from '../svgShapes';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const DRAWING =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
  '<path d="M 0 0 H 40 V 20 H 0 Z M 10 5 V 15 H 30 V 5 Z"/></svg>';

function session() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  const object = project.getSnapshot().state.plates[0].objects[0];
  const ids = new UuidIdSource(seededRandom(5));
  return { project, commands, assets, ids, objectId: object.id, volumeCount: object.volumes.length };
}

function volumesOf(project: ProjectStore) {
  return project
    .getSnapshot()
    .state.plates.flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes);
}

test('adding an SVG part stores the drawing parameters with the volume', () => {
  const { project, commands, ids, objectId, volumeCount } = session();
  const identity = svgVolumeIdentity(ids);
  const prepared = prepareSvgPart(DRAWING, {
    fileName: 'logo.svg',
    volumeId: identity.volumeId,
    assetId: identity.assetId,
    drawingAssetId: identity.drawingAssetId,
    depthMm: 2,
    sourcePath: '/tmp/logo.svg',
  });
  // The drawing has a counter, so the extruded part must still close.
  assert.equal(prepared.mesh.openEdgeCount, 0);
  assert.deepEqual(prepared.unsupported, []);

  commands.execute(
    new AddSvgPartCommand(
      { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform: identityTransform() },
      prepared,
      'logo',
    ),
  );

  const volumes = volumesOf(project);
  assert.equal(volumes.length, volumeCount + 1);
  const added = volumes.find((volume) => volume.id === identity.volumeId);
  assert.ok(added);
  assert.equal(added.name, 'logo');
  assert.equal(added.embossSvg?.depthMm, 2);
  assert.equal(added.embossSvg?.sourcePath, '/tmp/logo.svg');
  assert.match(added.embossSvg?.pathIn3mf ?? '', /^Metadata\/svg\/.+\/logo\.svg$/);
  assert.ok((added.embossSvg?.widthMm ?? 0) > 0, 'the resolved width travels with the part');

  commands.undo();
  assert.equal(volumesOf(project).length, volumeCount);
});

test('two parts cut from the same file name never share an archive path', () => {
  const { ids } = session();
  const first = svgVolumeIdentity(ids);
  const second = svgVolumeIdentity(ids);
  const options = { fileName: 'logo.svg', depthMm: 1 } as const;
  const a = prepareSvgPart(DRAWING, { ...options, ...first });
  const b = prepareSvgPart(DRAWING, { ...options, ...second });
  assert.notEqual(a.part.pathIn3mf, b.part.pathIn3mf, 'one drawing must not overwrite the other in the archive');
});

test('re-cutting at a new width and depth replaces the mesh in one undo entry', () => {
  const { project, commands, ids, objectId } = session();
  const identity = svgVolumeIdentity(ids);
  const original = prepareSvgPart(DRAWING, {
    ...identity,
    fileName: 'logo.svg',
    depthMm: 1,
    widthMm: 40,
  });
  commands.execute(
    new AddSvgPartCommand(
      { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform: identityTransform() },
      original,
      'logo',
    ),
  );
  const before = volumesOf(project).find((volume) => volume.id === identity.volumeId)!;
  const undoBefore = commands.getHistorySnapshot().undoCount;

  const next = svgVolumeIdentity(ids);
  const nextAssetId = next.assetId;
  const edited = prepareSvgPart(DRAWING, {
    fileName: 'logo.svg',
    volumeId: identity.volumeId,
    assetId: nextAssetId,
    drawingAssetId: next.drawingAssetId,
    depthMm: 3,
    widthMm: 80,
  });
  commands.execute(new EditSvgPartCommand(identity.volumeId, edited));

  const after = volumesOf(project).find((volume) => volume.id === identity.volumeId)!;
  assert.equal(after.embossSvg?.depthMm, 3);
  assert.ok((after.embossSvg?.widthMm ?? 0) > (before.embossSvg?.widthMm ?? 0), 'the part grew');
  assert.equal(after.source.assetId, nextAssetId);
  assert.equal(after.source.topologyRevision, before.source.topologyRevision + 1);
  // A re-cut invalidates every triangle-indexed annotation on that volume.
  assert.equal(after.annotations.topologyRevision, after.source.topologyRevision);
  assert.equal(commands.getHistorySnapshot().undoCount, undoBefore + 1);

  commands.undo();
  const reverted = volumesOf(project).find((volume) => volume.id === identity.volumeId)!;
  assert.equal(reverted.embossSvg?.depthMm, 1);
  assert.equal(reverted.source.assetId, identity.assetId);
  assert.equal(
    project.getSnapshot().state.sourceAssets.some((asset) => asset.id === nextAssetId),
    false,
    'the abandoned mesh must not linger',
  );
});

test('a volume that is not an SVG part refuses the re-cut', () => {
  const { project, commands, ids } = session();
  const plain = volumesOf(project)[0];
  const identity = svgVolumeIdentity(ids);
  const prepared = prepareSvgPart(DRAWING, { ...identity, fileName: 'logo.svg', depthMm: 1 });
  assert.throws(() => commands.execute(new EditSvgPartCommand(plain.id, prepared)), /not an SVG part/);
});

test('a drawing with nothing solid in it is refused before any state changes', () => {
  const { ids } = session();
  const identity = svgVolumeIdentity(ids);
  const options = { ...identity, fileName: 'x.svg', depthMm: 1 };
  assert.throws(
    () =>
      prepareSvgPart(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"><text x="0" y="0">hi</text></svg>',
        options,
      ),
    (error: unknown) => error instanceof SvgError && error.code === 'no-geometry',
  );
  assert.throws(
    () => prepareSvgPart(DRAWING, { ...options, depthMm: 0 }),
    (error: unknown) => error instanceof SvgError,
  );
});

test('unsupported features travel with the prepared part so the caller can report them', () => {
  const { ids } = session();
  const identity = svgVolumeIdentity(ids);
  const prepared = prepareSvgPart(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
      '<rect width="40" height="20"/><text x="1" y="1">hi</text></svg>',
    { ...identity, fileName: 'mixed.svg', depthMm: 1 },
  );
  assert.equal(prepared.unsupported.length, 1);
  assert.equal(prepared.unsupported[0].reason, 'needs-font');
  assert.ok(prepared.mesh.triangleCount > 0, 'the parts that can be cut still are');
});

console.log(`\nSVG part commands: ${passed} tests passed.`);
