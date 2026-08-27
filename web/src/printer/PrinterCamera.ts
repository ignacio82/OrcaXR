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

import { fetchLocalNetwork } from '../net/LocalNetworkAccess';
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
  /**
   * Absolute snapshot URL, when the camera is served by the same machine on a
   * different port — the ordinary crowsnest / mjpg-streamer arrangement, where
   * Moonraker answers on 7125 and the stream on 8080. It is fetched directly
   * and *without* the printer's API key, because it is a different service and
   * this app does not hand credentials to one that did not issue them.
   */
  readonly snapshotUrl?: string;
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

/**
 * How long one frame may take before it is called a failure.
 *
 * An unreachable port on a LAN does not refuse a connection, it hangs, and a
 * hung fetch is exactly what leaves a panel saying "waiting for the first
 * frame" forever. A bounded wait turns that into a message naming the URL.
 */
const SNAPSHOT_TIMEOUT_MS = 8000;

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
  /**
   * The endpoint the transport is pointed at. Without it a camera reported on
   * another port cannot be told from one on Moonraker itself, which is the
   * difference between a picture and a permanent "waiting for the first frame".
   */
  endpointHttpUrl?: string,
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
    const camera = readCamera(entry, endpointHttpUrl);
    if (camera) cameras.push(camera);
  }
  return Object.freeze(cameras);
}

function readCamera(entry: unknown, endpointHttpUrl?: string): PrinterCamera | undefined {
  if (!isRecord(entry)) return undefined;
  const name = readString(entry.name);
  if (!name) return undefined;
  const rawService = (readString(entry.service) ?? '').toLowerCase();
  const service = (SERVICES.has(rawService) ? rawService : 'unknown') as CameraService;
  const snapshot = resolveCameraSource(readString(entry.snapshot_url), endpointHttpUrl);
  const streamPath = normalizePath(readString(entry.stream_url), endpointHttpUrl);
  const targetFps = readNumber(entry.target_fps);
  // Why this camera cannot be shown, in the most specific terms available:
  // where it is served from, if that is the problem, and otherwise that it
  // offers no snapshot at all.
  const unsupportedReason =
    snapshot === undefined
      ? // Without a snapshot endpoint there is no way to fetch a frame with the
        // API key in a header, and the alternative leaks it into a URL.
        'This camera offers only a live stream, which cannot carry the printer API key; OrcaXR shows authenticated snapshots instead.'
      : snapshot.kind === 'unsupported'
        ? snapshot.reason
        : undefined;
  return Object.freeze({
    uid: readString(entry.uid) ?? name,
    name,
    service,
    enabled: entry.enabled !== false,
    ...(snapshot?.kind === 'path' ? { snapshotPath: snapshot.path } : {}),
    ...(snapshot?.kind === 'origin' ? { snapshotUrl: snapshot.url } : {}),
    ...(streamPath ? { streamPath } : {}),
    targetFps: targetFps !== undefined && targetFps > 0 ? targetFps : DEFAULT_FPS,
    rotationDegrees: readRotation(entry.rotation),
    flipHorizontal: entry.flip_horizontal === true,
    flipVertical: entry.flip_vertical === true,
    ...(unsupportedReason ? { unsupportedReason } : {}),
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
  // A camera on another port of the same machine is a different service, so it
  // is fetched directly and without the printer's API key. Handing one service's
  // credential to another is not something to do for a convenience.
  if (camera.snapshotUrl) {
    const deadline = new AbortController();
    const expiry = setTimeout(() => deadline.abort(), SNAPSHOT_TIMEOUT_MS);
    const forward = () => deadline.abort();
    signal?.addEventListener('abort', forward, { once: true });
    try {
      const response = await fetchLocalNetwork(camera.snapshotUrl, {
        signal: deadline.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new PrinterCameraError(
          `${camera.name} answered ${response.status} at ${camera.snapshotUrl}.`,
          'snapshot-failed',
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof PrinterCameraError) throw error;
      if (signal?.aborted) throw new PrinterCameraError('The snapshot request was cancelled.', 'cancelled');
      throw new PrinterCameraError(
        deadline.signal.aborted
          ? `${camera.name} did not answer at ${camera.snapshotUrl} within ${SNAPSHOT_TIMEOUT_MS / 1000} seconds.`
          : // A browser reports a refused connection and a refused *origin* the
            // same way, so the message names both possibilities: this is a
            // separate service from Moonraker, and it has to allow cross-origin
            // reads as well as be reachable.
            `${camera.name} could not be read from ${camera.snapshotUrl} ` +
              `(${error instanceof Error ? error.message : 'request failed'}). ` +
              'It is a separate service from Moonraker, so it has to be reachable and allow cross-origin requests.',
        'snapshot-failed',
      );
    } finally {
      clearTimeout(expiry);
      signal?.removeEventListener('abort', forward);
    }
  }
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
      `${camera.name} did not return a frame from ${camera.snapshotPath} (${
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

/**
 * Whether frames can be fetched for this camera at all.
 *
 * Two different arrangements can be shown — a snapshot path on Moonraker, and a
 * snapshot URL on another port of the same machine — and every caller that used
 * to test `snapshotPath` alone would have silently refused the second one.
 */
export function cameraCanShowFrames(camera: PrinterCamera): boolean {
  return camera.snapshotPath !== undefined || camera.snapshotUrl !== undefined;
}

export function describeCameraService(camera: PrinterCamera): string {
  const service = camera.service === 'unknown' ? 'an unrecognised service' : camera.service;
  if (!cameraCanShowFrames(camera)) return service;
  const rate = `at up to ${Math.min(camera.targetFps, MAX_SNAPSHOT_FPS)} fps`;
  return camera.snapshotPath
    ? `${service}, shown as authenticated snapshots ${rate}`
    : `${service}, shown as snapshots from ${camera.snapshotUrl} ${rate}`;
}

/** Where a reported camera URL actually points, relative to the printer. */
export type CameraSource =
  /** Served by Moonraker itself: fetched through the transport, with its key. */
  | { readonly kind: 'path'; readonly path: string }
  /** The same machine on another port: fetched directly, without the key. */
  | { readonly kind: 'origin'; readonly url: string }
  /** Somewhere else entirely, or unreadable. */
  | { readonly kind: 'unsupported'; readonly reason: string };

/**
 * Work out where a reported camera URL points.
 *
 * Moonraker reports these three ways, and the difference matters: relative
 * (`/webcam/?action=snapshot`), absolute against Moonraker's own origin, or —
 * the common one on a stock Klipper box — absolute against the *same host on a
 * different port*, because crowsnest and mjpg-streamer answer on 8080 while
 * Moonraker answers on 7125.
 *
 * The last case is why a camera could sit forever on "waiting for the first
 * frame". This function used to strip the origin off an absolute URL and hand
 * back the path, which quietly re-pointed `http://printer:8080/?action=snapshot`
 * at `http://printer:7125/?action=snapshot` — a URL that answers 404 on every
 * poll. Its own comment claimed such URLs were dropped; they were not.
 *
 * A different *host* is still refused, for the reason that comment gave: a
 * camera list is printer-host content, and following it elsewhere would make
 * this page a request forwarder.
 */
export function resolveCameraSource(url: string | undefined, endpointHttpUrl?: string): CameraSource | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (trimmed.startsWith('/')) return { kind: 'path', path: trimmed };
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { kind: 'unsupported', reason: `${trimmed} is not a URL this app can read.` };
    }
    let endpoint: URL | undefined;
    try {
      endpoint = endpointHttpUrl ? new URL(endpointHttpUrl) : undefined;
    } catch {
      endpoint = undefined;
    }
    // Without an endpoint to compare against, the safe reading is the historic
    // one: treat it as a path on whatever the transport is pointed at.
    if (!endpoint) return { kind: 'path', path: `${parsed.pathname}${parsed.search}` };
    if (parsed.origin === endpoint.origin) return { kind: 'path', path: `${parsed.pathname}${parsed.search}` };
    if (parsed.hostname === endpoint.hostname) return { kind: 'origin', url: parsed.toString() };
    return {
      kind: 'unsupported',
      reason:
        `This camera is served from ${parsed.origin}, which is not the printer at ${endpoint.origin}. ` +
        'OrcaXR only fetches from the printer it is connected to.',
    };
  }
  // A bare relative path like `webcam/?action=snapshot`.
  return /^[\w./?=&%-]+$/.test(trimmed)
    ? { kind: 'path', path: `/${trimmed}` }
    : { kind: 'unsupported', reason: `${trimmed} is not a URL this app can read.` };
}

/** Backwards-compatible reading for callers that only want a same-host path. */
export function normalizePath(url: string | undefined, endpointHttpUrl?: string): string | undefined {
  const source = resolveCameraSource(url, endpointHttpUrl);
  return source?.kind === 'path' ? source.path : undefined;
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
