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
import {
  DEFAULT_EMBOSS_FONT_PROPERTY,
  type EmbossTextConfiguration,
  type GlyphOutline,
  type GlyphOutlineSource,
} from '../emboss';
import {
  AddEmbossTextCommand,
  EditEmbossTextCommand,
  embossVolumeIdentity,
  prepareEmbossedVolume,
} from '../embossCommands';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A square glyph, so every dimension of the result is predictable. */
const SQUARE: GlyphOutline = {
  advance: 1000,
  contours: [
    {
      points: [
        [0, 0],
        [1000, 0],
        [1000, 1000],
        [0, 1000],
      ],
    },
  ],
};
const font: GlyphOutlineSource = { unitsPerEm: 1000, outline: () => SQUARE };

function configuration(overrides: Partial<EmbossTextConfiguration> = {}): EmbossTextConfiguration {
  return {
    text: 'AB',
    styleName: 'Fixture',
    fontDescriptor: 'fixture.ttf',
    fontDescriptorType: 'file_name',
    font: DEFAULT_EMBOSS_FONT_PROPERTY,
    projection: { depthMm: 2, useSurface: false },
    ...overrides,
  };
}

function session() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  const object = project.getSnapshot().state.plates[0].objects[0];
  const ids = new UuidIdSource(seededRandom(42));
  return { project, commands, assets, ids, objectId: object.id, volumeCount: object.volumes.length, fixture };
}

function volumesOf(project: ProjectStore) {
  return project
    .getSnapshot()
    .state.plates.flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes);
}

test('adding embossed text creates a volume carrying its own recipe', () => {
  const { project, commands, ids, objectId, volumeCount } = session();
  const identity = embossVolumeIdentity(ids);
  const recipe = configuration();
  const prepared = prepareEmbossedVolume(recipe, font, identity.assetId);
  assert.equal(prepared.mesh.openEdgeCount, 0, 'the generated mesh must be a closed solid');

  commands.execute(
    new AddEmbossTextCommand(
      { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform: identityTransform() },
      recipe,
      prepared,
    ),
  );

  const volumes = volumesOf(project);
  assert.equal(volumes.length, volumeCount + 1);
  const added = volumes.find((volume) => volume.id === identity.volumeId);
  assert.ok(added, 'the embossed volume must exist');
  assert.deepEqual(added.embossText, recipe, 'the recipe is stored, not just the triangles');
  assert.equal(added.name, 'AB', 'the volume is named after its text');
  assert.ok(project.getSnapshot().state.sourceAssets.some((asset) => asset.id === identity.assetId));
});

test('undo removes the volume and its mesh asset together', () => {
  const { project, commands, assets, ids, objectId, volumeCount } = session();
  const identity = embossVolumeIdentity(ids);
  const recipe = configuration();
  commands.execute(
    new AddEmbossTextCommand(
      { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform: identityTransform() },
      recipe,
      prepareEmbossedVolume(recipe, font, identity.assetId),
    ),
  );
  assert.ok(assets.get(identity.assetId), 'the mesh asset is present after the add');

  commands.undo();
  assert.equal(volumesOf(project).length, volumeCount);
  assert.equal(
    project.getSnapshot().state.sourceAssets.some((asset) => asset.id === identity.assetId),
    false,
    'a dangling asset descriptor would survive a save and reload',
  );
  assert.equal(assets.get(identity.assetId), undefined);

  commands.redo();
  assert.equal(volumesOf(project).length, volumeCount + 1);
});

test('editing the text re-cuts the mesh and bumps the topology revision', () => {
  const { project, commands, ids, objectId } = session();
  const identity = embossVolumeIdentity(ids);
  const original = configuration({ text: 'A' });
  commands.execute(
    new AddEmbossTextCommand(
      { objectId, volumeId: identity.volumeId, assetId: identity.assetId, transform: identityTransform() },
      original,
      prepareEmbossedVolume(original, font, identity.assetId),
    ),
  );
  const before = volumesOf(project).find((volume) => volume.id === identity.volumeId)!;

  const edited = configuration({ text: 'ABC' });
  const nextAssetId = embossVolumeIdentity(ids).assetId;
  commands.execute(
    new EditEmbossTextCommand(identity.volumeId, edited, prepareEmbossedVolume(edited, font, nextAssetId)),
  );

  const after = volumesOf(project).find((volume) => volume.id === identity.volumeId)!;
  assert.equal(after.embossText?.text, 'ABC');
  assert.equal(after.name, 'ABC');
  assert.equal(after.source.assetId, nextAssetId, 'the volume points at the newly cut mesh');
  assert.equal(after.source.triangleCount, before.source.triangleCount * 3, 'three glyphs instead of one');
  assert.equal(after.source.topologyRevision, before.source.topologyRevision + 1);
  // Facet annotations index triangles, so they cannot survive a re-cut.
  assert.equal(after.annotations.topologyRevision, after.source.topologyRevision);

  commands.undo();
  const reverted = volumesOf(project).find((volume) => volume.id === identity.volumeId)!;
  assert.equal(reverted.embossText?.text, 'A');
  assert.equal(reverted.source.assetId, identity.assetId);
  assert.equal(
    project.getSnapshot().state.sourceAssets.some((asset) => asset.id === nextAssetId),
    false,
    'the abandoned mesh must not linger in the project',
  );
});

test('a volume that is not embossed text refuses the edit', () => {
  const { commands, project, ids } = session();
  const plain = volumesOf(project)[0];
  const recipe = configuration();
  const prepared = prepareEmbossedVolume(recipe, font, embossVolumeIdentity(ids).assetId);
  assert.throws(() => commands.execute(new EditEmbossTextCommand(plain.id, recipe, prepared)), /not embossed text/);
});

console.log(`\nEmboss commands: ${passed} tests passed.`);
