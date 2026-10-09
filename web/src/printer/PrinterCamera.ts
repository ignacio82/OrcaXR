/**
 * Watching the print (P9.6).
 *
 * Moonraker knows which cameras a printer has, where their streams live, and
 * how each one is mounted. Discovery is straightforward. *Where a reported URL
 * points* and *how to load it* are the two decisions that matter, and both were
 * originally answered wrongly for the ordinary Klipper box.
 *
 * Where. A snapshot URL is usually reported relative — `/webcam/snapshot.jpg` —
 * and on a stock machine that path is served by **nginx on port 80**, the same
 * origin the printer's own web UI is loaded from, while Moonraker answers the
 * API on 7125. Resolving it against the API endpoint asks 7125 for a file only
 * 80 has, which answers 404 forever; that is what left this panel sitting on
 * "Waiting for the first frame…". A relative path therefore resolves to the
 * printer's *web* origin, and the API path is kept as a second candidate for
 * the arrangement where Moonraker really does serve it.
 *
 * How. Two mechanisms, chosen by whether a credential is involved.
 *
 * A camera served by Moonraker itself is fetched through the transport as
 * bytes, because an `<img src>` cannot carry `x-api-key` and the only way to
 * make it load would be to put the key in the query string, which the transport
 * refuses on purpose.
 *
 * A camera served by anything else — nginx, crowsnest, camera-streamer — is a
 * separate service that never issued this app a credential, so nothing is sent
 * to it and an `<img src>` can simply load it. That matters beyond tidiness:
 * those services do not send CORS headers (verified on a Snapmaker running
 * camera-streamer behind nginx: `200 image/jpeg`, no `access-control-*` at
 * all), so reading their bytes cross-origin is blocked by the browser while
 * *displaying* them is not. An image needs no CORS; a fetch does.
 *
 * Neither mechanism can cross the mixed-content line: an HTTPS page cannot load
 * an HTTP image at all, and there the byte fetch — which Local Network Access
 * does let through — is the only route, so the camera has to allow cross-origin
 * reads. When that is the situation the panel says so instead of waiting.
 *
 * Live MJPEG, WebRTC, and HLS transports are reported as unsupported with that
 * reason rather than half-offered — see the platform-adaptation register.
 *
 * The timer is visibility-aware because every frame is its own request: a
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

/** Frames per second this app fetches for one camera, bounded at both ends. */
export function cameraFrameRate(camera: PrinterCamera): number {
  return Math.min(Math.max(camera.targetFps, 0.2), MAX_SNAPSHOT_FPS);
}

/** Poll interval in milliseconds for one camera. */
export function cameraPollIntervalMs(camera: PrinterCamera): number {
  return Math.round(1000 / cameraFrameRate(camera));
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
  const snapshot = resolveCameraSources(readString(entry.snapshot_url), endpointHttpUrl);
  const streamPath = normalizePath(readString(entry.stream_url), endpointHttpUrl);
  const targetFps = readNumber(entry.target_fps);
  // Why this camera cannot be shown, in the most specific terms available:
  // where it is served from, if that is the problem, and otherwise that it
  // offers no snapshot at all.
  const unsupportedReason =
    snapshot.snapshotPath === undefined && snapshot.snapshotUrl === undefined
      ? // Without a snapshot endpoint there is no way to fetch a frame with the
        // API key in a header, and the alternative leaks it into a URL.
        (snapshot.unsupportedReason ??
        'This camera offers only a live stream, which cannot carry the printer API key; OrcaXR shows authenticated snapshots instead.')
      : undefined;
  return Object.freeze({
    uid: readString(entry.uid) ?? name,
    name,
    service,
    enabled: entry.enabled !== false,
    ...(snapshot.snapshotPath ? { snapshotPath: snapshot.snapshotPath } : {}),
    ...(snapshot.snapshotUrl ? { snapshotUrl: snapshot.snapshotUrl } : {}),
    ...(streamPath ? { streamPath } : {}),
    targetFps: targetFps !== undefined && targetFps > 0 ? targetFps : DEFAULT_FPS,
    rotationDegrees: readRotation(entry.rotation),
    flipHorizontal: entry.flip_horizontal === true,
    flipVertical: entry.flip_vertical === true,
    ...(unsupportedReason ? { unsupportedReason } : {}),
  });
}

/**
 * How one frame is fetched.
 *
 * A camera served by anything but Moonraker is a different service, so it is
 * fetched directly and without the printer's API key — handing one service's
 * credential to another is not something to do for a convenience. A camera
 * Moonraker serves is downloaded through the transport, credential in a
 * header: bytes rather than a URL, because an `<img>` cannot authenticate and
 * the transport refuses a credential in the query string.
 */
export type CameraSnapshotPlan =
  | { readonly kind: 'direct'; readonly url: string; readonly timeoutMs: number }
  | { readonly kind: 'transport'; readonly path: string; readonly operation: string };

/** How one frame's fetch ended without bytes. */
export type CameraSnapshotOutcome =
  | { readonly kind: 'cancelled' }
  /** A direct fetch answered with a status that is not OK. */
  | { readonly kind: 'status'; readonly status: number }
  /** A direct fetch got no answer within the plan's deadline. */
  | { readonly kind: 'timeout' }
  /** A direct fetch failed; the platform's own words. */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** The transport failed, with its code when it gave one. */
  | { readonly kind: 'transport'; readonly code?: string };

/** The route a frame takes: [mechanism], or the first fetchable one. */
export function planCameraSnapshot(camera: PrinterCamera, mechanism?: CameraMechanism): CameraSnapshotPlan {
  const route = mechanism ?? (camera.snapshotUrl ? 'direct' : 'transport');
  if (route === 'direct' && camera.snapshotUrl) {
    return { kind: 'direct', url: camera.snapshotUrl, timeoutMs: SNAPSHOT_TIMEOUT_MS };
  }
  if (!camera.snapshotPath) {
    throw new PrinterCameraError(camera.unsupportedReason ?? 'This camera has no snapshot endpoint.', 'no-snapshot');
  }
  if (route === 'image') {
    throw new PrinterCameraError('An image route is loaded by the browser, not fetched here.', 'no-snapshot');
  }
  return { kind: 'transport', path: camera.snapshotPath, operation: 'camera_snapshot' };
}

/** What a frame's failed fetch reads as. */
export function cameraSnapshotFailure(
  camera: PrinterCamera,
  plan: CameraSnapshotPlan,
  outcome: CameraSnapshotOutcome,
): PrinterCameraError {
  if (outcome.kind === 'cancelled') return new PrinterCameraError('The snapshot request was cancelled.', 'cancelled');
  if (plan.kind === 'transport') {
    return new PrinterCameraError(
      `${camera.name} did not return a frame from ${plan.path} (${
        outcome.kind === 'transport' && outcome.code !== undefined ? outcome.code : 'request failed'
      }).`,
      'snapshot-failed',
    );
  }
  if (outcome.kind === 'status') {
    return new PrinterCameraError(`${camera.name} answered ${outcome.status} at ${plan.url}.`, 'snapshot-failed');
  }
  if (outcome.kind === 'timeout') {
    return new PrinterCameraError(
      `${camera.name} did not answer at ${plan.url} within ${plan.timeoutMs / 1000} seconds.`,
      'snapshot-failed',
    );
  }
  // A browser reports a refused connection and a refused *origin* the same
  // way, so the message names both possibilities: this is a separate service
  // from Moonraker, and it has to allow cross-origin reads as well as be
  // reachable.
  return new PrinterCameraError(
    `${camera.name} could not be read from ${plan.url} ` +
      `(${outcome.kind === 'unreachable' ? outcome.detail : 'request failed'}). ` +
      'It is a separate service from Moonraker, so it has to be reachable and allow cross-origin requests.',
    'snapshot-failed',
  );
}

/** Fetch one frame along [mechanism], or the first fetchable route. */
export async function fetchCameraSnapshot(
  transport: PrinterCameraTransport,
  camera: PrinterCamera,
  signal?: AbortSignal,
  /** Which route to take; defaults to the first fetchable one for this camera. */
  mechanism?: CameraMechanism,
): Promise<Uint8Array> {
  const plan = planCameraSnapshot(camera, mechanism);
  if (plan.kind === 'direct') {
    const deadline = new AbortController();
    const expiry = setTimeout(() => deadline.abort(), plan.timeoutMs);
    const forward = () => deadline.abort();
    signal?.addEventListener('abort', forward, { once: true });
    let response: Response;
    try {
      // No headers, deliberately. This has to stay a *simple* cross-origin GET:
      // mjpg-streamer answers `OPTIONS` with 501, so anything that turns this
      // into a preflighted request stops it working entirely.
      response = await fetchLocalNetwork(plan.url, { signal: deadline.signal, cache: 'no-store' });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw cameraSnapshotFailure(
        camera,
        plan,
        signal?.aborted
          ? { kind: 'cancelled' }
          : deadline.signal.aborted
            ? { kind: 'timeout' }
            : { kind: 'unreachable', detail: error instanceof Error ? error.message : 'request failed' },
      );
    } finally {
      clearTimeout(expiry);
      signal?.removeEventListener('abort', forward);
    }
    throw cameraSnapshotFailure(camera, plan, { kind: 'status', status: response.status });
  }
  try {
    return await transport.download(plan.path, { operation: plan.operation, ...(signal ? { signal } : {}) });
  } catch (error) {
    throw cameraSnapshotFailure(
      camera,
      plan,
      signal?.aborted || (error instanceof MoonrakerTransportError && error.code === 'cancelled')
        ? { kind: 'cancelled' }
        : { kind: 'transport', ...(error instanceof MoonrakerTransportError ? { code: error.code } : {}) },
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

export function describeCameraService(camera: PrinterCamera, route?: CameraMechanism, pageProtocol?: string): string {
  const service = camera.service === 'unknown' ? 'an unrecognised service' : camera.service;
  if (!cameraCanShowFrames(camera)) return service;
  // The rate frames are actually fetched at; it used to quote the camera's own
  // rate below the floor, as "0.1 fps" for a camera polled at 0.2.
  const rate = `at up to ${cameraFrameRate(camera)} fps`;
  // Named by how the frames are actually being obtained, because
  // "authenticated" is a claim about this app's own behaviour and only one of
  // these routes carries a credential at all.
  return (route ?? cameraMechanisms(camera, pageProtocol)[0]) === 'transport'
    ? `${service}, shown as authenticated snapshots ${rate}`
    : `${service}, shown as snapshots ${rate}`;
}

/** Where a reported camera URL actually points, relative to the printer. */
export interface CameraSnapshotSources {
  /**
   * Path on the endpoint this session is connected to, fetched through the
   * transport with the API key. Used when Moonraker itself serves the camera.
   */
  readonly snapshotPath?: string;
  /**
   * Absolute URL on the printer's machine but *not* on Moonraker's API origin —
   * nginx on port 80, or crowsnest on 8080. Loaded directly and without the
   * printer's API key, because that service never issued one.
   */
  readonly snapshotUrl?: string;
  /** Why neither is possible, when neither is. */
  readonly unsupportedReason?: string;
}

/**
 * Work out where a reported camera URL points.
 *
 * Moonraker reports these three ways, and the difference decides everything:
 * relative (`/webcam/snapshot.jpg`), absolute on Moonraker's own origin, or
 * absolute on the same host at a different port, because crowsnest and
 * mjpg-streamer answer on 8080 while Moonraker answers on 7125.
 *
 * A relative path yields **both** candidates, most likely first. Moonraker
 * reports it relative to the origin the printer's own web UI is served from —
 * nginx on port 80 — not to the API port, so that is where it is looked for;
 * the API path is kept behind it for a setup where Moonraker does serve it, and
 * for the simulator, which does. Trying the second only after the first fails
 * is what keeps both arrangements working without asking anyone to configure
 * which one they have.
 *
 * A different *host* is refused: a camera list is printer-host content, and
 * following it elsewhere would make this page a request forwarder.
 */
export function resolveCameraSources(url: string | undefined, endpointHttpUrl?: string): CameraSnapshotSources {
  if (!url) return {};
  const trimmed = url.trim();
  const endpoint = parseUrl(endpointHttpUrl);

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseUrl(trimmed);
    if (!parsed) return { unsupportedReason: `${trimmed} is not a URL this app can read.` };
    const path = `${parsed.pathname}${parsed.search}`;
    // Without an endpoint to compare against, the only safe reading is that it
    // is a path on whatever the transport is pointed at.
    if (!endpoint) return { snapshotPath: path };
    if (parsed.origin === endpoint.origin) return { snapshotPath: path, snapshotUrl: parsed.toString() };
    if (parsed.hostname === endpoint.hostname) return { snapshotUrl: parsed.toString() };
    return {
      unsupportedReason:
        `This camera is served from ${parsed.origin}, which is not the printer at ${endpoint.origin}. ` +
        'OrcaXR only fetches from the printer it is connected to.',
    };
  }

  // A path, either rooted or bare (`webcam/?action=snapshot`).
  if (!/^[\w./?=&%-]+$/.test(trimmed.replace(/^\//, ''))) {
    return { unsupportedReason: `${trimmed} is not a URL this app can read.` };
  }
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (!endpoint) return { snapshotPath: path };
  // The printer's web origin: same machine, default port for the scheme, which
  // is where a stock install's nginx serves both the UI and `/webcam/`. The
  // host name, brackets and all: cutting the host at its first `:` turned an
  // IPv6 printer into `http://[fd00/webcam/…`.
  return { snapshotUrl: `${endpoint.protocol}//${endpoint.hostname}${path}`, snapshotPath: path };
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether the browser can load this camera as an image from the current page.
 *
 * An HTTPS page cannot load an HTTP subresource, and Local Network Access does
 * not change that for images — it is a `fetch` option. So on the hosted app a
 * plain-HTTP camera has to go through the byte fetch, which is the path that
 * needs the camera to allow cross-origin reads.
 */
export function cameraLoadsAsImage(camera: PrinterCamera, pageProtocol = globalThis.location?.protocol): boolean {
  if (!camera.snapshotUrl) return false;
  return !(pageProtocol === 'https:' && camera.snapshotUrl.startsWith('http:'));
}

/**
 * How a frame can be obtained, in the order worth trying.
 *
 * - `image`: point an `<img>` at the camera's own URL. No credential, and no
 *   CORS involved, which is the only thing that works against a service that
 *   sends no `access-control-*` headers — the normal case.
 * - `direct`: fetch that same URL as bytes. Only worth trying when the image
 *   route is closed (an HTTPS page cannot load an HTTP image, while Local
 *   Network Access does let the fetch through), and it needs the camera to
 *   allow cross-origin reads.
 * - `transport`: fetch the path through Moonraker, credentialed. For the
 *   arrangement where Moonraker really does serve the camera.
 *
 * A caller walks this list, moving on when one fails, so a printer whose
 * cameras sit somewhere unusual still ends up showing a picture without anyone
 * being asked to configure which arrangement they have.
 */
export type CameraMechanism = 'image' | 'direct' | 'transport';

export function cameraMechanisms(camera: PrinterCamera, pageProtocol?: string): readonly CameraMechanism[] {
  const asImage = cameraLoadsAsImage(camera, pageProtocol);
  return Object.freeze([
    ...(asImage ? (['image'] as const) : []),
    // Skipped when the image route is open: it is the same URL, so it would
    // fail the same way and only spend a request saying so.
    ...(camera.snapshotUrl && !asImage ? (['direct'] as const) : []),
    ...(camera.snapshotPath ? (['transport'] as const) : []),
  ]);
}

/**
 * The URL to point an `<img>` at, made unique so the browser fetches a frame
 * rather than showing the one it already has.
 */
export function cameraDirectFrameUrl(camera: PrinterCamera, nonce: number | string): string | undefined {
  if (!camera.snapshotUrl) return undefined;
  const url = parseUrl(camera.snapshotUrl);
  if (!url) return undefined;
  url.searchParams.set('orcaxr_frame', String(nonce));
  return url.toString();
}

/** The path reading alone, for a stream URL that is recorded but never loaded. */
export function normalizePath(url: string | undefined, endpointHttpUrl?: string): string | undefined {
  return resolveCameraSources(url, endpointHttpUrl).snapshotPath;
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
