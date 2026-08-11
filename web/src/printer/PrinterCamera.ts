/**
 * Watching the print (P9.6).
 *
 * Moonraker knows which cameras a printer has, where their streams live, and
 * how each one is mounted. Discovery is straightforward; how to *show* one is
 * the decision that matters here, and it is constrained by something the rest
 * of this boundary already settled: a credential never goes in a URL.
 *
 * That rules out the obvious implementation. An `<img src>` or a `<video src>`
 * pointed at the printer cannot carry the `x-api-key` header, so on any printer
 * that requires one the feed would simply be a broken image — and the only way
 * to make it load would be to put the key in the query string, which the
 * transport refuses on purpose.
 *
 * So every camera is rendered the one way that keeps the credential in a
 * header: authenticated snapshots, fetched through the transport and swapped
 * into an object URL on a timer the camera itself declares. Live MJPEG, WebRTC,
 * and HLS transports are reported as unsupported with that reason rather than
 * being half-offered — see the platform-adaptation register.
 *
 * The timer is visibility-aware because it is a network fetch per frame: a
 * hidden tab polling a printer forever is somebody's bandwidth and somebody's
 * battery.
 */

import { MoonrakerTransportError } from './MoonrakerTypes';

export interface PrinterCameraTransport {
  request<T>(path: string, options?: { readonly signal?: AbortSignal; readonly operation?: string }): Promise<T>;
  download(path: string, options?: { readonly signal?: AbortSignal; readonly operation?: string }): Promise<Uint8Array>;
}

/** Transports Moonraker reports. Only `snapshot` is rendered; see the header. */
export type CameraService =
  | 'mjpegstreamer'
  | 'mjpegstreamer-adaptive'
  | 'uv4l-mjpeg'
  | 'hlsstream'
  | 'ipstream'
  | 'webrtc-camerastreamer'
  | 'webrtc-go2rtc'
  | 'webrtc-mediamtx'
  | 'unknown';

export interface PrinterCamera {
  readonly uid: string;
  readonly name: string;
  readonly service: CameraService;
  readonly enabled: boolean;
  /** Path this app fetches snapshots from, relative to the printer's host. */
  readonly snapshotPath?: string;
  /** Stream path as reported; recorded for diagnostics, never rendered. */
  readonly streamPath?: string;
  readonly targetFps: number;
  readonly rotationDegrees: 0 | 90 | 180 | 270;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  /** Why this camera cannot be shown, when it cannot. */
  readonly unsupportedReason?: string;
}

export class PrinterCameraError extends Error {
  override readonly name = 'PrinterCameraError';

  constructor(
    message: string,
    readonly code: 'unavailable' | 'no-snapshot' | 'snapshot-failed' | 'cancelled',
  ) {
    super(message);
  }
}

/**
 * Frames per second this app will actually fetch.
 *
 * Each frame is a separate authenticated request, so a camera advertising 30
 * fps is not an invitation to make thirty requests a second at a Raspberry Pi.
 */
export const MAX_SNAPSHOT_FPS = 4;
const DEFAULT_FPS = 2;

const SERVICES: ReadonlySet<string> = new Set([
  'mjpegstreamer',
  'mjpegstreamer-adaptive',
  'uv4l-mjpeg',
  'hlsstream',
  'ipstream',
  'webrtc-camerastreamer',
  'webrtc-go2rtc',
  'webrtc-mediamtx',
]);

/** Poll interval in milliseconds for one camera, bounded at both ends. */
export function cameraPollIntervalMs(camera: PrinterCamera): number {
  const fps = Math.min(Math.max(camera.targetFps, 0.2), MAX_SNAPSHOT_FPS);
  return Math.round(1000 / fps);
}

/** Every camera the printer knows about, whether or not it can be shown. */
export async function listPrinterCameras(
  transport: PrinterCameraTransport,
  signal?: AbortSignal,
): Promise<readonly PrinterCamera[]> {
  let payload: unknown;
  try {
    payload = await transport.request<unknown>('/server/webcams/list', {
      operation: 'list_webcams',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')) {
      throw new PrinterCameraError('Reading the printer cameras was cancelled.', 'cancelled');
    }
    throw new PrinterCameraError(
      `The printer did not report any cameras (${
        error instanceof MoonrakerTransportError ? error.code : 'request failed'
      }).`,
      'unavailable',
    );
  }
  if (!isRecord(payload)) throw new PrinterCameraError("The printer's camera list was not readable.", 'unavailable');

  const cameras: PrinterCamera[] = [];
  for (const entry of asArray(payload.webcams)) {
    const camera = readCamera(entry);
    if (camera) cameras.push(camera);
  }
  return Object.freeze(cameras);
}

function readCamera(entry: unknown): PrinterCamera | undefined {
  if (!isRecord(entry)) return undefined;
  const name = readString(entry.name);
  if (!name) return undefined;
  const rawService = (readString(entry.service) ?? '').toLowerCase();
  const service = (SERVICES.has(rawService) ? rawService : 'unknown') as CameraService;
  const snapshotPath = normalizePath(readString(entry.snapshot_url));
  const streamPath = normalizePath(readString(entry.stream_url));
  const targetFps = readNumber(entry.target_fps);
  return Object.freeze({
    uid: readString(entry.uid) ?? name,
    name,
    service,
    enabled: entry.enabled !== false,
    ...(snapshotPath ? { snapshotPath } : {}),
    ...(streamPath ? { streamPath } : {}),
    targetFps: targetFps !== undefined && targetFps > 0 ? targetFps : DEFAULT_FPS,
    rotationDegrees: readRotation(entry.rotation),
    flipHorizontal: entry.flip_horizontal === true,
    flipVertical: entry.flip_vertical === true,
    ...(snapshotPath
      ? {}
      : {
          // Without a snapshot endpoint there is no way to fetch a frame with
          // the API key in a header, and the alternative leaks it into a URL.
          unsupportedReason:
            'This camera offers only a live stream, which cannot carry the printer API key; OrcaXR shows authenticated snapshots instead.',
        }),
  });
}

/**
 * Fetch one frame, credential in a header.
 *
 * Bytes rather than a URL: an `<img>` cannot authenticate, and the transport
 * refuses a credential in the query string.
 */
export async function fetchCameraSnapshot(
  transport: PrinterCameraTransport,
  camera: PrinterCamera,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!camera.snapshotPath) {
    throw new PrinterCameraError(camera.unsupportedReason ?? 'This camera has no snapshot endpoint.', 'no-snapshot');
  }
  try {
    return await transport.download(camera.snapshotPath, {
      operation: 'camera_snapshot',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')) {
      throw new PrinterCameraError('The snapshot request was cancelled.', 'cancelled');
    }
    throw new PrinterCameraError(
      `${camera.name} did not return a frame (${
        error instanceof MoonrakerTransportError ? error.code : 'request failed'
      }).`,
      'snapshot-failed',
    );
  }
}

/** CSS transform that reproduces how the camera is physically mounted. */
export function cameraTransform(camera: PrinterCamera): string {
  const parts: string[] = [];
  if (camera.rotationDegrees !== 0) parts.push(`rotate(${camera.rotationDegrees}deg)`);
  if (camera.flipHorizontal || camera.flipVertical) {
    parts.push(`scale(${camera.flipHorizontal ? -1 : 1}, ${camera.flipVertical ? -1 : 1})`);
  }
  return parts.join(' ');
}

export function describeCameraService(camera: PrinterCamera): string {
  const service = camera.service === 'unknown' ? 'an unrecognised service' : camera.service;
  return camera.snapshotPath
    ? `${service}, shown as authenticated snapshots at up to ${Math.min(camera.targetFps, MAX_SNAPSHOT_FPS)} fps`
    : service;
}

/**
 * Normalize a reported URL into a printer-relative path.
 *
 * Moonraker reports these either relative (`/webcam/?action=snapshot`) or
 * absolute against the printer's own host. An absolute URL pointing somewhere
 * else entirely is dropped rather than fetched: a camera list is printer-host
 * content, and following it off-host would make the page a request forwarder.
 */
export function normalizePath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (trimmed.startsWith('/')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return undefined;
    }
  }
  // A bare relative path like `webcam/?action=snapshot`.
  return /^[\w./?=&%-]+$/.test(trimmed) ? `/${trimmed}` : undefined;
}

function readRotation(value: unknown): 0 | 90 | 180 | 270 {
  const rotation = readNumber(value);
  return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
