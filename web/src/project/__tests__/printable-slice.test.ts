/**
 * An unprintable instance is not printed (P2.2, P7.1, P11.2).
 *
 * The canonical model has carried `printable` on every instance since P1, the
 * command to change it has existed unused, the serializer writes it into
 * `Metadata/model_settings.config`, and arrange already skips one — everything
 * except a way to set it and any evidence that the *engine* honours it.
 *
 * That last one is the whole question. An archive assertion proves the file,
 * not the feature: writing `printable="0"` and watching it round-trip says
 * nothing about whether the slicer skips the instance. So this asks the engine,
 * with the one measurement that cannot be misread — two cubes on a plate print
 * about twice the filament of one, and marking a cube unprintable must put the
 * program back where one cube leaves it.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { contentDigest } from '../assets';
import { cloneProjectState, projectFingerprint } from '../domain/canonical';
import { emptyFacetAnnotations } from '../domain/model';
import { entityId } from '../domain/ids';
import { ProfileCatalog } from '../../slicer/ProfileLoader';
import { createProjectFixture } from './fixtures';
import type { ProjectArchiveSnapshot } from '..';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const CUBE_MM = 20;

function cubeMesh(): { bytes: Uint8Array; triangleCount: number } {
  const p: [number, number, number][] = [
    [0, 0, 0],
    [CUBE_MM, 0, 0],
    [CUBE_MM, CUBE_MM, 0],
    [0, CUBE_MM, 0],
    [0, 0, CUBE_MM],
    [CUBE_MM, 0, CUBE_MM],
    [CUBE_MM, CUBE_MM, CUBE_MM],
    [0, CUBE_MM, CUBE_MM],
  ];
  const faces = [
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
  const vertices = faces.flat().map((index) => p[index]);
  const bytes = new Uint8Array(vertices.length * 12);
  const view = new DataView(bytes.buffer);
  vertices.forEach((vertex, vertexIndex) => {
    vertex.forEach((coordinate, component) => {
      view.setFloat32(vertexIndex * 12 + component * 4, coordinate, true);
    });
  });
  return { bytes, triangleCount: faces.length };
}

async function baseConfig(): Promise<Record<string, string>> {
  const raw = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../../public/profiles/catalog.json'), 'utf8'),
  ) as unknown;
  const catalog = ProfileCatalog.fromRaw(raw);
  const profile = catalog.find('Snapmaker U1 (0.4 nozzle)', '', '') ?? catalog.profiles[0];
  assert.ok(profile);
  return { ...profile.config };
}

/** One plate holding `instances` cubes in a row; `unprintable` are marked so. */
async function buildArchive(instances: number, unprintable: readonly number[] = []): Promise<Uint8Array> {
  const fixture = createProjectFixture();
  const mesh = cubeMesh();
  const descriptor = {
    ...fixture.asset.descriptor,
    digest: contentDigest(mesh.bytes),
    byteLength: mesh.bytes.byteLength,
    sourceFilename: 'cube.stl',
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: mesh.bytes.byteLength,
        componentType: 'float32',
        componentCount: 3,
        count: mesh.triangleCount * 3,
      },
      triangleCount: mesh.triangleCount,
    },
  } as typeof fixture.asset.descriptor;

  const state = cloneProjectState(fixture.state);
  state.config = (await baseConfig()) as never;
  state.sourceAssets = [descriptor];
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      object.layerRanges = [];
      for (const volume of object.volumes) {
        volume.source = { assetId: descriptor.id, topologyRevision: 0, triangleCount: mesh.triangleCount };
        volume.annotations = emptyFacetAnnotations(0);
      }
      const template = object.instances[0];
      object.instances = Array.from({ length: instances }, (_, index) => ({
        ...template,
        id: index === 0 ? template.id : entityId<'instance'>(`import:test:instance-${index}`),
        transform: { ...template.transform, translationMm: [index * 40, 0, 0] as never },
        printable: !unprintable.includes(index),
      }));
    }
  }

  const snapshot: ProjectArchiveSnapshot = {
    state,
    assets: [{ descriptor, bytes: mesh.bytes }],
    sourceRevision: 1,
    sourceHash: projectFingerprint(state),
  };
  return (await new Bbs3mfProjectSerializer().serialize(snapshot)).bytes;
}

async function slice(archive: Uint8Array, label: string): Promise<string> {
  const createEngine = (await import('../../../public/slicer/slic3r.mjs')).default;
  const engine = await createEngine();
  engine.FS.writeFile(`/tmp/${label}.3mf`, archive);
  const output = engine.sliceProjectSync(`/tmp/${label}.3mf`, 1, JSON.stringify({}));
  if (output.startsWith('ORCAXR_ERROR:')) throw new Error(output.slice('ORCAXR_ERROR:'.length).trim());
  return output;
}

/** The engine's own filament total, in millimetres. */
function filamentMm(gcode: string): number {
  const match = /^; filament used \[mm\] = ([\d.]+)/m.exec(gcode);
  assert.ok(match, 'the program states its filament total');
  return Number.parseFloat(match[1]);
}

await test('marking an instance unprintable removes it from the program', async () => {
  const one = filamentMm(await slice(await buildArchive(1), 'printable-one'));
  const two = filamentMm(await slice(await buildArchive(2), 'printable-two'));
  const twoWithOneOff = filamentMm(await slice(await buildArchive(2, [1]), 'printable-two-one-off'));

  assert.ok(one > 0 && two > 0, 'both baselines print something');
  // Two cubes cost roughly twice one. The bound is loose because the second
  // cube adds its own skirt and travel, not exactly its own filament.
  assert.ok(two > one * 1.7, `two cubes used ${two} mm against one cube's ${one} mm`);

  // The measurement that matters: with the second cube marked unprintable, the
  // program must be the one-cube program, not the two-cube one.
  const distanceToOne = Math.abs(twoWithOneOff - one) / one;
  const distanceToTwo = Math.abs(twoWithOneOff - two) / two;
  assert.ok(
    distanceToOne < distanceToTwo,
    `an unprintable instance still printed: ${twoWithOneOff} mm sits nearer two cubes (${two}) than one (${one})`,
  );
  assert.ok(distanceToOne < 0.05, `expected about ${one} mm, got ${twoWithOneOff} mm`);
});

await test('the toggle writes the flag, survives a round trip, and undoes', async () => {
  const { CommandBus, ProjectStore, SelectionStore, InMemoryAssetRepository } = await import('..');
  const { SetInstancePrintableCommand } = await import('../objects/commands');
  const fixture = createProjectFixture();
  const project = new ProjectStore(cloneProjectState(fixture.state));
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
  bus.markCheckpoint();
  const instanceId = project.getSnapshot().state.plates[0].objects[0].instances[0].id;

  bus.execute(new SetInstancePrintableCommand(instanceId, false));
  const stored = project.getSnapshot().state.plates[0].objects[0].instances[0];
  assert.equal(stored.printable, false);

  const snapshot = project.getSnapshot();
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize({
    state: snapshot.state,
    assets: [fixture.asset],
    sourceRevision: snapshot.revision,
    sourceHash: projectFingerprint(snapshot.state),
  });
  const reopened = await serializer.deserialize(saved.bytes);
  assert.equal(
    reopened.state.plates[0].objects[0].instances[0].printable,
    false,
    'an excluded model must still be excluded when the project is opened again',
  );

  bus.undo();
  assert.equal(project.getSnapshot().state.plates[0].objects[0].instances[0].printable, true);
});

console.log(`\nUnprintable instances: ${passed} tests passed.`);
