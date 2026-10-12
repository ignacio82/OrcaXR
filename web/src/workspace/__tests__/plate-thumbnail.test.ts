/**
 * The picture a plate's G-code carries: what is drawn, and how it is stored.
 *
 * Two regressions pinned here. Slicing every plate drew each file's picture
 * from the active plate's models, and only an object's first part was in it;
 * the plate's own printable model parts are. And three.js writes linear light
 * into a plain render target, so the PNG bytes held linear values and every
 * picture came out darker than the model on screen; the target stores sRGB.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InMemoryAssetRepository, ProjectStore, cloneJson, cloneProjectState, entityId } from '../../project';
import { emptyFacetAnnotations } from '../../project/domain/model';
import { ThreeProjectSurface, getThreeProjectEntity } from '../../project/surfaces/ThreeProjectSurface';
import { createProjectFixture } from '../../project/__tests__/fixtures';
import { PlateThumbnailRenderer, frameCamera, plateThumbnailMeshes } from '../PlateThumbnailRenderer';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Plate 1: an object with two model parts and a modifier, placed by a printable and an unprintable
 * instance. Plate 2: another object. */
function twoPlates() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const object = state.plates[0].objects[0];
  const body = object.volumes[0];
  object.volumes.push(
    {
      ...cloneJson(body),
      id: entityId<'volume'>('import:test:thumbnail-modifier'),
      role: 'parameter-modifier',
      annotations: emptyFacetAnnotations(0),
    },
    { ...cloneJson(body), id: entityId<'volume'>('import:test:thumbnail-second-part') },
  );
  object.instances.push({
    ...cloneJson(object.instances[0]),
    id: entityId<'instance'>('import:test:thumbnail-unprintable'),
    printable: false,
  });
  const other = cloneJson(object);
  other.id = entityId<'object'>('import:test:thumbnail-other-object');
  other.volumes = [{ ...cloneJson(body), id: entityId<'volume'>('import:test:thumbnail-other-volume') }];
  other.instances = [{ ...cloneJson(object.instances[0]), id: entityId<'instance'>('import:test:thumbnail-other') }];
  other.layerRanges = [];
  state.plates.push({
    ...cloneJson(state.plates[0]),
    id: entityId<'plate'>('import:test:thumbnail-plate-2'),
    name: 'Plate 2',
    order: 1,
    objects: [other],
  });
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const surface = new ThreeProjectSurface({
    parent: new THREE.Scene(),
    assets,
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  });
  surface.renderProject(new ProjectStore(state).getSnapshot());
  return { surface, plates: state.plates.map((plate) => plate.id) };
}

const drawn = (meshes: readonly THREE.Mesh[]) =>
  meshes.map((mesh) => {
    const entity = getThreeProjectEntity(mesh)!;
    return `${entity.instanceId} ${entity.volumeId}`;
  });

await test('a plate’s picture is every model part of its own printable instances', () => {
  const { surface, plates } = twoPlates();
  const [first, second] = plates;
  const instance = surface.root.children
    .map((child) => getThreeProjectEntity(child))
    .find((entity) => entity?.plateId === first && entity.printable)!.instanceId;
  assert.deepEqual(drawn(plateThumbnailMeshes(surface.root, first)), [
    `${instance} ${createProjectFixture().ids.volume}`,
    `${instance} import:test:thumbnail-second-part`,
  ]);
  // The other plate shows its own object, whichever plate is active.
  assert.deepEqual(drawn(plateThumbnailMeshes(surface.root, second)), [
    'import:test:thumbnail-other import:test:thumbnail-other-volume',
  ]);
  surface.dispose();
});

await test('the thumbnail is drawn into an sRGB target, so its bytes are what the screen shows', async () => {
  const { surface, plates } = twoPlates();
  const targets: THREE.WebGLRenderTarget[] = [];
  const asked: string[] = [];
  const renderer = {
    xr: { enabled: true },
    getRenderTarget: () => null,
    getClearColor: (color: THREE.Color) => color.set(0xffffff),
    getClearAlpha: () => 1,
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) => {
      if (target) targets.push(target);
    },
    setClearColor: () => {},
    clear: () => {},
    render: () => {},
    readRenderTargetPixels: () => {},
  } as unknown as THREE.WebGLRenderer;
  const thumbnails = new PlateThumbnailRenderer({
    renderer,
    meshes: (plateId) => {
      asked.push(plateId);
      return plateThumbnailMeshes(surface.root, plateId);
    },
  });
  // No canvas in Node, so no image; the render itself still happened.
  await thumbnails.render({ width: 48, height: 48, format: 'PNG' }, plates[1]);
  assert.deepEqual(asked, [plates[1]]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(renderer.xr.enabled, true, 'the XR camera is restored after the render');
  surface.dispose();
});

await test('the camera frames the plate’s bounds from the front left, above', () => {
  const camera = frameCamera(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)), 1);
  assert.ok(camera.position.x < 0 && camera.position.y > 1 && camera.position.z > 0);
  assert.equal(camera.fov, 30);
});

console.log(`\nPlate thumbnails: ${passed} tests passed.`);
