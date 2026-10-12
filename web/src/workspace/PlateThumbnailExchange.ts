/**
 * The hosts' contract for a plate thumbnail's framing (`frameCamera` in
 * `PlateThumbnailRenderer.ts`): a canonical JSON request and reply answered by
 * the production function, which the shared Rust core answers the same way
 * (`orcaxr_project::slicing::thumbnails::frame`).
 *
 * A request is `{"aspect": number, "max": [x, y, z], "min": [x, y, z]}`: the
 * drawn models' bounds in three.js world axes (Y up) and the image's width over
 * its height. The reply is `{"fovDeg", "position": [x, y, z], "target": [x, y,
 * z]}`: the camera's vertical field of view, where it stands and the point it
 * looks at, with Y up. A malformed request is refused as `invalid_request`.
 */
import * as THREE from 'three';
import { canonicalStringify } from '../project/domain/canonical';
import { frameCamera } from './PlateThumbnailRenderer';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function finite(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}
function vector(value: Json | undefined): THREE.Vector3 {
  if (!Array.isArray(value) || value.length !== 3) invalid();
  return new THREE.Vector3(finite(value[0]), finite(value[1]), finite(value[2]));
}

/** `{"aspect","max","min"}` → the thumbnail camera's field of view, position and target. */
export function thumbnailViewExchange(requestJson: string): string {
  let request: Json;
  try {
    request = JSON.parse(requestJson) as Json;
  } catch {
    invalid();
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) invalid();
  const keys = Object.keys(request).sort();
  if (keys.join() !== 'aspect,max,min') invalid();
  const aspect = finite(request.aspect);
  if (!(aspect > 0)) invalid();
  const bounds = new THREE.Box3(vector(request.min), vector(request.max));
  if (bounds.isEmpty()) invalid();
  const camera = frameCamera(bounds, aspect);
  const target = bounds.getCenter(new THREE.Vector3());
  return canonicalStringify({
    fovDeg: camera.fov,
    position: camera.position.toArray(),
    target: target.toArray(),
  });
}
