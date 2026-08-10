import assert from 'node:assert/strict';

import { CommandBus, InMemoryAssetRepository, ProjectStore, SelectionStore } from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';
import {
  AdaptiveLayerHeightProfileCommand,
  AdjustLayerHeightProfileCommand,
  ResetLayerHeightProfileCommand,
  SmoothLayerHeightProfileCommand,
} from '../layerHeightCommands';
import { baseLayerHeightProfile, layerHeightAt, type LayerHeightSlicingParameters } from '../layerHeightProfile';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PARAMETERS: LayerHeightSlicingParameters = Object.freeze({
  layerHeightMm: 0.2,
  minLayerHeightMm: 0.08,
  maxLayerHeightMm: 0.28,
  firstObjectLayerHeightMm: 0.2,
  firstObjectLayerHeightFixed: true,
  objectHeightMm: 20,
});

function session() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  const objectId = project.getSnapshot().state.plates[0].objects[0].id;
  return { project, commands, objectId };
}

function profileOf(project: ProjectStore) {
  return project.getSnapshot().state.plates[0].objects[0].layerHeightProfile;
}

test('a first edit starts from the base profile and undoes back to none', () => {
  const { project, commands, objectId } = session();
  assert.equal(profileOf(project), undefined, 'an unedited object carries no profile');

  commands.execute(
    new AdjustLayerHeightProfileCommand(objectId, PARAMETERS, {
      zMm: 10,
      thicknessDeltaMm: 0.05,
      bandWidthMm: 4,
      action: 'increase',
    }),
  );
  const edited = profileOf(project);
  assert.ok(edited && edited.length > baseLayerHeightProfile(PARAMETERS).length, 'the edit resampled the profile');
  assert.ok(layerHeightAt(edited, 10, 0.2) > 0.2);

  commands.undo();
  // Coming back with a flat profile instead of none would make every later
  // save carry one the operator never authored.
  assert.equal(profileOf(project), undefined, 'undo restores "no profile", not a flat one');
});

test('successive edits accumulate and undo one at a time', () => {
  const { project, commands, objectId } = session();
  const edit = (zMm: number) =>
    commands.execute(
      new AdjustLayerHeightProfileCommand(objectId, PARAMETERS, {
        zMm,
        thicknessDeltaMm: 0.05,
        bandWidthMm: 3,
        action: 'increase',
      }),
    );
  edit(6);
  edit(14);
  const both = profileOf(project)!;
  assert.ok(layerHeightAt(both, 6, 0.2) > 0.2 && layerHeightAt(both, 14, 0.2) > 0.2);

  commands.undo();
  const one = profileOf(project)!;
  assert.ok(layerHeightAt(one, 6, 0.2) > 0.2, 'the first edit survives');
  assert.ok(Math.abs(layerHeightAt(one, 14, 0.2) - 0.2) < 1e-9, 'the second is gone');
});

test('adaptive replaces the whole profile from the geometry', () => {
  const { project, commands, objectId } = session();
  // A shallow cone, which is the shape adaptive actually thins layers for.
  const segments = 24;
  const vertices: [number, number, number][] = [[0, 0, 0]];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    vertices.push([Math.cos(angle) * 60, Math.sin(angle) * 60, 0]);
  }
  vertices.push([0, 0, 20]);
  const apex = vertices.length - 1;
  const triangles: [number, number, number][] = [];
  for (let index = 0; index < segments; index += 1) {
    const a = 1 + index;
    const b = 1 + ((index + 1) % segments);
    triangles.push([0, b, a], [a, b, apex]);
  }

  commands.execute(new AdaptiveLayerHeightProfileCommand(objectId, PARAMETERS, { vertices, triangles }, 0.5));
  const profile = profileOf(project)!;
  assert.ok(profile.length > 10, 'adaptive produces a detailed profile');
  assert.ok(layerHeightAt(profile, 10, 0.2) < 0.2, 'a shallow surface got thinner layers');

  commands.undo();
  assert.equal(profileOf(project), undefined);
});

test('smoothing an unedited object is based on its implicit base profile', () => {
  const { project, commands, objectId } = session();
  commands.execute(new SmoothLayerHeightProfileCommand(objectId, PARAMETERS, { radius: 5, keepMin: false }));
  const profile = profileOf(project)!;
  // A flat profile smooths to itself, so this proves the base was used rather
  // than the command failing on a missing profile.
  for (let index = 1; index < profile.length; index += 2) {
    assert.ok(Math.abs(profile[index] - 0.2) < 1e-9, `sample ${index} drifted to ${profile[index]}`);
  }
});

test('reset clears the profile entirely and undoes to what was there', () => {
  const { project, commands, objectId } = session();
  commands.execute(
    new AdjustLayerHeightProfileCommand(objectId, PARAMETERS, {
      zMm: 10,
      thicknessDeltaMm: 0.05,
      bandWidthMm: 4,
      action: 'increase',
    }),
  );
  const edited = profileOf(project)!;

  commands.execute(new ResetLayerHeightProfileCommand(objectId));
  assert.equal(profileOf(project), undefined, 'reset removes the profile rather than flattening it');

  commands.undo();
  assert.deepEqual(profileOf(project), edited, 'undo brings the edited profile back exactly');
});

test('an object that is not in the project is refused', () => {
  const { commands } = session();
  assert.throws(
    () => commands.execute(new ResetLayerHeightProfileCommand('missing' as never)),
    /is not in this project/,
  );
});

console.log(`\nLayer height commands: ${passed} tests passed.`);
