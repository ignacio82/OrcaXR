/**
 * The picture a printer's display shows, rendered where the scene actually is.
 *
 * `libslic3r` cannot draw a thumbnail: it has geometry, not a view. The desktop
 * app solves that by handing the backend a `ThumbnailsGeneratorCallback` that
 * renders the plate offscreen in the GUI's own GL context. OrcaXR's engine runs
 * in WASM with no GUI at all, so the callback was null and the branch that
 * writes thumbnails never ran — every print arrived at the machine wearing the
 * firmware's stock image.
 *
 * This is that callback. It renders the plated models with the renderer the app
 * already owns, so the thumbnail is the model the operator has been looking at.
 *
 * Three decisions are worth stating, because each has a wrong version that
 * looks fine until it does not:
 *
 * **Nothing in the live scene is mutated.** The meshes are `clone()`d — which
 * shares geometry and material, so it costs a matrix each — into a throwaway
 * scene with their world transforms baked in. Toggling `visible` or `layers` on
 * the real objects would have been fewer lines and would leave the workspace in
 * a wrong state if anything between the toggle and the restore threw.
 *
 * **The bed is not drawn.** Upstream renders it (`show_bed: true`), but this app
 * has two beds — a dark XR tray with amber rings and a pale flat one — and a
 * thumbnail that depends on which shell you sliced from is a thumbnail that
 * cannot be compared to itself. Models on transparency is also what reads best
 * at the 48 px the U1 asks for.
 *
 * **`xr.enabled` is turned off around the render.** `WebGLRenderer.render`
 * substitutes the XR camera for the one it is given while a session presents,
 * so without this the thumbnail would be a picture of whatever the headset
 * happened to be looking at.
 */
import * as THREE from 'three';
import type { GcodeThumbnailRequest } from '../slicer/GcodeThumbnails';

/** What the renderer needs from the workspace, and nothing else. */
export interface PlateThumbnailSource {
  /** The display meshes of every printable model on the plate being sliced. */
  meshes(): readonly THREE.Mesh[];
  readonly renderer: THREE.WebGLRenderer;
}

/** Framing, in the same spirit as the desktop's three-quarter plate view. */
const CAMERA_ELEVATION_DEG = 28;
const CAMERA_AZIMUTH_DEG = -35;
/** Slack around the model's bounding sphere so nothing touches the edge. */
const FRAMING_MARGIN = 1.18;

export class PlateThumbnailRenderer {
  constructor(private readonly source: PlateThumbnailSource) {}

  /**
   * Render one thumbnail, or `null` when there is nothing to draw.
   *
   * An empty plate returns `null` rather than a blank image: a G-code with no
   * thumbnail block shows the firmware's own placeholder, which is a better
   * answer than a deliberate rectangle of nothing.
   */
  async render(request: GcodeThumbnailRequest): Promise<Uint8Array | null> {
    const meshes = this.source.meshes();
    if (meshes.length === 0) return null;

    const renderer = this.source.renderer;
    const scene = new THREE.Scene();
    const bounds = new THREE.Box3();

    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const clone = mesh.clone();
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(mesh.matrixWorld);
      clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
      clone.updateMatrixWorld(true);
      scene.add(clone);
      bounds.expandByObject(clone);
    }
    if (bounds.isEmpty()) return null;

    // The app's own key/fill, so a thumbnail is lit like the viewport.
    scene.add(new THREE.HemisphereLight(0xbbbbbb, 0x888888, 3));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(0.5, 2, 0.5);
    scene.add(key);

    const camera = frameCamera(bounds, request.width / request.height);
    const target = new THREE.WebGLRenderTarget(request.width, request.height, {
      depthBuffer: true,
      stencilBuffer: false,
    });

    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const previousXr = renderer.xr.enabled;
    const pixels = new Uint8Array(request.width * request.height * 4);
    try {
      renderer.xr.enabled = false;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, request.width, request.height, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClear, previousAlpha);
      renderer.xr.enabled = previousXr;
      target.dispose();
      // The clones share their geometry and material with the live scene, so
      // dropping the scene is the whole teardown; disposing here would take the
      // viewport's own meshes down with it.
      scene.clear();
    }

    return encodePng(pixels, request);
  }
}

/** A three-quarter view that fits `bounds`, whatever its proportions. */
function frameCamera(bounds: THREE.Box3, aspect: number): THREE.PerspectiveCamera {
  const centre = bounds.getCenter(new THREE.Vector3());
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const fovDeg = 30;
  const camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.001, 1000);

  // Fit the bounding sphere in whichever of the two axes is tighter, so a wide
  // thumbnail of a tall model still contains the model.
  const vFov = THREE.MathUtils.degToRad(fovDeg);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const radius = Math.max(sphere.radius, 1e-4) * FRAMING_MARGIN;
  const distance = radius / Math.sin(Math.min(vFov, hFov) / 2);

  const azimuth = THREE.MathUtils.degToRad(CAMERA_AZIMUTH_DEG);
  const elevation = THREE.MathUtils.degToRad(CAMERA_ELEVATION_DEG);
  camera.position.set(
    centre.x + distance * Math.cos(elevation) * Math.sin(azimuth),
    centre.y + distance * Math.sin(elevation),
    centre.z + distance * Math.cos(elevation) * Math.cos(azimuth),
  );
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * Turn a GL framebuffer into the image bytes the block carries.
 *
 * `readRenderTargetPixels` hands back rows bottom-up, which is how GL stores
 * them and the opposite of how every image format reads them; the flip here is
 * the same one `compress_thumbnail_png` does with miniz's `flip` flag.
 */
async function encodePng(pixels: Uint8Array, request: GcodeThumbnailRequest): Promise<Uint8Array | null> {
  const { width, height } = request;
  const flipped = new Uint8ClampedArray(pixels.length);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    const from = row * stride;
    const to = (height - row - 1) * stride;
    flipped.set(pixels.subarray(from, from + stride), to);
  }

  const canvas = createCanvas(width, height);
  if (!canvas) return null;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) return null;
  context.putImageData(new ImageData(flipped, width, height), 0, 0);

  const type = request.format === 'JPG' ? 'image/jpeg' : 'image/png';
  const blob = await canvasToBlob(canvas, type);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type: string): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type });
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}
