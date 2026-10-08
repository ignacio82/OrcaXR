/**
 * The renderer projection and its revisioned deltas: records are normalized so
 * an edit touches only what it changed, deltas applied to their base rebuild
 * the target, the feed pages, retains, resets and refuses as the shared core
 * does, and the Three surface shows exactly what the projection says.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { InMemoryAssetRepository, ProjectStore, cloneJson, cloneProjectState, entityId } from '..';
import type { ProjectObject } from '../domain/model';
import {
  RENDER_PAGE_LIMIT,
  RENDER_RETAINED_SNAPSHOTS,
  RenderFeed,
  RenderRefusal,
  diffRender,
  projectRender,
  type RenderChange,
  type RenderProjection,
} from '../renderProjection';
import { ThreeProjectSurface, getThreeProjectEntity } from '../surfaces/ThreeProjectSurface';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function copy(source: ProjectObject, suffix: string): ProjectObject {
  const object = cloneJson(source);
  object.id = entityId<'object'>(`import:test:render-object-${suffix}`);
  object.volumes[0].id = entityId<'volume'>(`import:test:render-volume-${suffix}`);
  object.instances[0].id = entityId<'instance'>(`import:test:render-instance-${suffix}`);
  object.layerRanges[0].id = entityId<'layer-range'>(`import:test:render-range-${suffix}`);
  return object;
}

/** Two plates: the active one holds the fixture object and a mixed-colour copy;
 * the other a copy on the second tool. */
function scene() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const mixed = copy(fixture.object, 'mixed');
  mixed.volumes[0].filamentId = fixture.ids.mixed;
  mixed.instances[0].transform.translationMm = [40, 0, 0];
  const second = copy(fixture.object, 'second');
  second.filamentId = fixture.ids.physical1;
  state.plates[0].objects.push(mixed);
  state.plates.push({
    id: entityId<'plate'>('import:test:render-plate-2'),
    name: 'Plate 2',
    order: 1,
    printable: false,
    config: {},
    objects: [second],
  });
  return { fixture, state, store: new ProjectStore(state) };
}

/** A host's scene: records keyed by ID, built by applying changes in order. */
function apply(base: Map<string, unknown>, changes: readonly RenderChange[]): Map<string, unknown> {
  const out = new Map(base);
  for (const change of changes) {
    switch (change.kind) {
      case 'plate':
        out.set(`plate:${change.plate.plateId}`, change.plate);
        break;
      case 'instance':
        out.set(`instance:${change.instance.instanceId}`, change.instance);
        break;
      case 'volume':
        out.set(`volume:${change.volume.volumeId}`, change.volume);
        break;
      case 'remove-plate':
        assert.ok(out.delete(`plate:${change.id}`));
        break;
      case 'remove-instance':
        assert.ok(out.delete(`instance:${change.id}`));
        break;
      case 'remove-volume':
        assert.ok(out.delete(`volume:${change.id}`));
        break;
    }
  }
  return out;
}
const records = (projection: RenderProjection) => apply(new Map(), diffRender(undefined, projection));

test('a sync from empty holds one record per entity, plates by order', () => {
  const { state } = scene();
  const projection = projectRender(state);
  assert.deepEqual(
    projection.plates.map((p) => [p.order, p.active, p.printable]),
    [
      [0, true, true],
      [1, false, false],
    ],
  );
  assert.equal(projection.instances.length, 3);
  assert.equal(projection.volumes.length, 3);
  // Colours resolve exactly as the palette does: the object's tool, a
  // volume's mixed recipe, the second tool.
  assert.deepEqual(
    projection.volumes.map((v) => v.color),
    ['#ff0000', '#800080', '#0000ff'],
  );
  const changes = diffRender(undefined, projection);
  assert.equal(changes.length, 8);
  assert.deepEqual(
    changes.map((c) => c.kind),
    ['plate', 'plate', 'instance', 'instance', 'instance', 'volume', 'volume', 'volume'],
  );
  assert.deepEqual(diffRender(projection, projection), []);
});

test('an edit touches only the records it changes', () => {
  const { fixture, state } = scene();
  const base = projectRender(state);

  const switched = cloneProjectState(state);
  switched.activePlateId = switched.plates[1].id;
  assert.deepEqual(
    diffRender(base, projectRender(switched)).map((c) => c.kind),
    ['plate', 'plate'],
    'switching plates touches plates only',
  );

  const recoloured = cloneProjectState(state);
  recoloured.filaments.physical[1].color = '#00ff00';
  assert.deepEqual(
    diffRender(base, projectRender(recoloured)),
    [{ kind: 'volume', volume: { ...base.volumes[2], color: '#00ff00' } }],
    'recolouring a tool touches the volumes that use it',
  );

  const moved = cloneProjectState(state);
  moved.plates[0].objects[1].instances[0].transform.translationMm = [41, 0, 0];
  const delta = diffRender(base, projectRender(moved));
  assert.equal(delta.length, 1);
  assert.equal(delta[0].kind === 'instance' && delta[0].instance.instanceId, base.instances[1].instanceId);

  const removed = cloneProjectState(state);
  removed.plates[0].objects = removed.plates[0].objects.filter((o) => o.id !== fixture.ids.object);
  assert.deepEqual(diffRender(base, projectRender(removed)), [
    { kind: 'remove-volume', id: fixture.ids.volume },
    { kind: 'remove-instance', id: fixture.ids.instance },
  ]);

  // Any delta applied to its base rebuilds the target exactly.
  for (const target of [switched, recoloured, moved, removed, createProjectFixture({ withObject: false }).state]) {
    const projection = projectRender(target);
    assert.deepEqual(apply(records(base), diffRender(base, projection)), records(projection));
  }
});

test('the feed pages deltas between acknowledged snapshots', () => {
  const { state, store } = scene();
  const feed = new RenderFeed(() => store.getSnapshot());
  const cursor = (s: { revision: number; hash: string }) => ({ revision: s.revision, semanticHash: s.hash });
  const opened = store.getSnapshot();

  const first = feed.page({ start: 0, count: 3 });
  assert.equal(first.base, undefined);
  assert.deepEqual(first.target, cursor(opened));
  assert.equal(first.total, 8);
  assert.equal(first.changes.length, 3);
  const rest = feed.page({ target: first.target, start: 3, count: RENDER_PAGE_LIMIT });
  assert.equal(rest.changes.length, 5);
  assert.deepEqual(feed.page({ base: first.target, start: 0, count: 8 }).changes, []);

  // A newer edit does not disturb paging toward a retained target.
  const moved = cloneProjectState(state);
  moved.plates[0].objects[0].instances[0].transform.translationMm = [5, 0, 0];
  store.replaceState(moved);
  const delta = feed.page({ base: first.target, start: 0, count: 1 });
  assert.equal(delta.total, 1);
  const switched = cloneProjectState(moved);
  switched.activePlateId = switched.plates[1].id;
  store.replaceState(switched);
  assert.deepEqual(feed.page({ base: first.target, target: delta.target, start: 0, count: 8 }), delta);

  // An unknown base starts from empty; an unknown target and an oversized
  // page refuse.
  const reset = feed.page({ base: { revision: 99, semanticHash: 'fnv1a64:0' }, start: 0, count: 1 });
  assert.equal(reset.base, undefined);
  assert.equal(reset.total, 8);
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof RenderRefusal);
      return error.code;
    }
    assert.fail('expected a refusal');
  };
  assert.equal(
    refusal(() => feed.page({ target: { revision: 99, semanticHash: 'fnv1a64:0' }, start: 0, count: 1 })),
    'stale',
  );
  assert.equal(
    refusal(() => feed.page({ start: 0, count: RENDER_PAGE_LIMIT + 1 })),
    'invalid-request',
  );

  // More newer served snapshots than the feed retains release the opening one.
  for (let n = 0; n < RENDER_RETAINED_SNAPSHOTS; n++) {
    const next = cloneProjectState(store.getSnapshot().state);
    next.name = `Render ${n}`;
    store.replaceState(next);
    feed.page({ start: 0, count: 0 });
  }
  assert.equal(
    refusal(() => feed.page({ target: cursor(opened), start: 0, count: 1 })),
    'stale',
  );
  const rebuilt = feed.page({ base: cursor(opened), start: 0, count: 8 });
  assert.equal(rebuilt.base, undefined, 'a released base rebuilds from empty');
});

test('the Three surface shows what the projection says', () => {
  const { fixture, store } = scene();
  const surface = new ThreeProjectSurface({
    parent: new THREE.Scene(),
    assets: (() => {
      const repository = new InMemoryAssetRepository();
      repository.put(fixture.asset.descriptor, fixture.asset.bytes);
      return repository;
    })(),
    mapping: { bedSizeMm: [200, 100], worldUnitsPerMm: 0.002 },
  });
  try {
    const snapshot = store.getSnapshot();
    surface.renderProject(snapshot);
    const projection = projectRender(snapshot.state);
    const active = new Map(projection.plates.map((p) => [p.plateId, p]));
    for (const instance of projection.instances) {
      const group = surface.getInstanceGroup(instance.instanceId)!;
      const plate = active.get(instance.plateId)!;
      assert.equal(group.visible, plate.active);
      assert.equal(getThreeProjectEntity(group)!.printable, plate.printable && instance.printable);
      assert.deepEqual(group.position.toArray(), instance.transform.translationMm);
      for (const volume of projection.volumes.filter((v) => v.objectId === instance.objectId)) {
        const mesh = surface.getVolumeMesh(instance.instanceId, volume.volumeId)!;
        const material = mesh.material as THREE.MeshStandardMaterial;
        assert.equal(`#${material.color.getHexString()}`, volume.color);
        assert.equal(mesh.geometry.getIndex()!.count / 3, volume.triangleCount);
        assert.equal(getThreeProjectEntity(mesh)!.role, volume.role);
      }
    }
  } finally {
    surface.dispose();
  }
});

console.log(`render projection tests passed: ${passed}`);
