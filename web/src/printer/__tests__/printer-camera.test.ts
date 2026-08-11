/**
 * Webcam discovery and authenticated snapshots (P9.6).
 *
 * The constraint that shapes this module is that a credential never goes in a
 * URL, so the tests pin the consequences: frames are fetched as bytes through
 * the transport, a camera that offers only a stream says why it cannot be
 * shown, and a URL pointing off the printer's host is dropped rather than
 * followed.
 */
import assert from 'node:assert/strict';

import { MoonrakerTransportError } from '../MoonrakerTypes';
import {
  MAX_SNAPSHOT_FPS,
  PrinterCameraError,
  cameraPollIntervalMs,
  cameraTransform,
  describeCameraService,
  fetchCameraSnapshot,
  listPrinterCameras,
  normalizePath,
} from '../PrinterCamera';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeTransport {
  readonly calls: string[] = [];
  constructor(
    private readonly reply: unknown = {},
    private readonly failure?: Error,
  ) {}
  async request<T>(path: string): Promise<T> {
    this.calls.push(path);
    if (this.failure) throw this.failure;
    return this.reply as T;
  }
  async download(path: string): Promise<Uint8Array> {
    this.calls.push(path);
    if (this.failure) throw this.failure;
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }
}

const WEBCAMS = {
  webcams: [
    {
      uid: 'cam-1',
      name: 'Nozzle',
      service: 'mjpegstreamer-adaptive',
      enabled: true,
      target_fps: 15,
      snapshot_url: '/webcam/?action=snapshot',
      stream_url: '/webcam/?action=stream',
      rotation: 90,
      flip_horizontal: true,
    },
    {
      uid: 'cam-2',
      name: 'Chamber',
      service: 'webrtc-go2rtc',
      enabled: true,
      stream_url: 'http://printer.local/webrtc',
      target_fps: 30,
    },
    { uid: 'cam-3', name: 'Off', service: 'ipstream', enabled: false, snapshot_url: 'http://printer.local/snap.jpg' },
    { uid: 'cam-4', service: 'mjpegstreamer' },
  ],
};

await test('lists every camera the printer knows, named or not usable', async () => {
  const transport = new FakeTransport(WEBCAMS);
  const cameras = await listPrinterCameras(transport);
  assert.equal(transport.calls[0], '/server/webcams/list');
  // The nameless entry is dropped: it identifies no camera.
  assert.deepEqual(
    cameras.map((camera) => camera.uid),
    ['cam-1', 'cam-2', 'cam-3'],
  );
  assert.equal(cameras[2].enabled, false, 'a disabled camera is still listed, so it can be explained');
});

await test('a stream-only camera says why it cannot be shown', async () => {
  const cameras = await listPrinterCameras(new FakeTransport(WEBCAMS));
  const nozzle = cameras.find((camera) => camera.uid === 'cam-1')!;
  assert.equal(nozzle.snapshotPath, '/webcam/?action=snapshot');
  assert.equal(nozzle.unsupportedReason, undefined);

  const chamber = cameras.find((camera) => camera.uid === 'cam-2')!;
  assert.equal(chamber.snapshotPath, undefined);
  assert.match(chamber.unsupportedReason ?? '', /cannot carry the printer API key/);
  assert.equal(chamber.streamPath, '/webrtc', 'the stream path is recorded even though it is not rendered');
});

await test('caps the frame rate the camera asks for', async () => {
  const cameras = await listPrinterCameras(new FakeTransport(WEBCAMS));
  const nozzle = cameras[0];
  assert.equal(nozzle.targetFps, 15);
  // Each frame is its own authenticated request; 15 fps is not an invitation.
  assert.equal(cameraPollIntervalMs(nozzle), Math.round(1000 / MAX_SNAPSHOT_FPS));
  assert.match(describeCameraService(nozzle), /up to 4 fps/);
  const slow = { ...nozzle, targetFps: 0.01 };
  assert.equal(cameraPollIntervalMs(slow), 5000, 'a nonsensical rate is bounded at both ends');
});

await test('reproduces how the camera is mounted', async () => {
  const cameras = await listPrinterCameras(new FakeTransport(WEBCAMS));
  assert.equal(cameraTransform(cameras[0]), 'rotate(90deg) scale(-1, 1)');
  assert.equal(cameraTransform({ ...cameras[0], rotationDegrees: 0, flipHorizontal: false }), '');
  // A rotation Moonraker should never report falls back to upright rather than
  // tilting the image by an arbitrary amount.
  const cameras2 = await listPrinterCameras(
    new FakeTransport({ webcams: [{ name: 'Odd', rotation: 45, snapshot_url: '/s' }] }),
  );
  assert.equal(cameras2[0].rotationDegrees, 0);
});

await test('fetches a frame as bytes and never as a URL the browser would load', async () => {
  const transport = new FakeTransport(WEBCAMS);
  const cameras = await listPrinterCameras(transport);
  const bytes = await fetchCameraSnapshot(transport, cameras[0]);
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(transport.calls.at(-1), '/webcam/?action=snapshot');

  await assert.rejects(
    () => fetchCameraSnapshot(transport, cameras[1]),
    (error: unknown) => error instanceof PrinterCameraError && error.code === 'no-snapshot',
  );
  const failing = new FakeTransport(WEBCAMS, new MoonrakerTransportError('timeout', 'camera_snapshot'));
  await assert.rejects(
    () => fetchCameraSnapshot(failing, cameras[0]),
    (error: unknown) =>
      error instanceof PrinterCameraError &&
      error.code === 'snapshot-failed' &&
      /Nozzle did not return a frame/.test(error.message),
  );
});

await test('keeps a reported URL on the printer’s own host', () => {
  assert.equal(normalizePath('/webcam/?action=snapshot'), '/webcam/?action=snapshot');
  assert.equal(normalizePath('webcam/?action=snapshot'), '/webcam/?action=snapshot');
  // An absolute URL keeps only its path: the request goes to the printer this
  // session is connected to, never to whatever host the list named.
  assert.equal(normalizePath('http://192.168.1.50/webcam/?action=snapshot'), '/webcam/?action=snapshot');
  assert.equal(normalizePath('https://evil.example/steal?x=1'), '/steal?x=1');
  assert.equal(normalizePath('javascript:alert(1)'), undefined);
  assert.equal(normalizePath('data:image/png;base64,AAAA'), undefined);
  assert.equal(normalizePath(''), undefined);
  assert.equal(normalizePath(undefined), undefined);
});

await test('reports a printer with no camera component instead of an empty list', async () => {
  await assert.rejects(
    () => listPrinterCameras(new FakeTransport([])),
    (error: unknown) => error instanceof PrinterCameraError && error.code === 'unavailable',
  );
  await assert.rejects(
    () => listPrinterCameras(new FakeTransport({}, new MoonrakerTransportError('http_error', 'list_webcams'))),
    (error: unknown) => error instanceof PrinterCameraError && error.code === 'unavailable',
  );
  // A printer with the component but no configured cameras is not an error.
  assert.deepEqual(await listPrinterCameras(new FakeTransport({ webcams: [] })), []);
});

console.log(`\nPrinter camera: ${passed} tests passed.`);
