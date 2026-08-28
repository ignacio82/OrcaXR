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
  cameraCanShowFrames,
  cameraPollIntervalMs,
  cameraTransform,
  describeCameraService,
  fetchCameraSnapshot,
  listPrinterCameras,
  cameraDirectFrameUrl,
  cameraLoadsAsImage,
  cameraMechanisms,
  normalizePath,
  resolveCameraSources,
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

await test('a camera on another port of the same machine is fetched there, not at Moonraker', async () => {
  // The stock Klipper arrangement: Moonraker on 7125, crowsnest on 8080. This
  // is the case that used to be silently rewritten to Moonraker's own port,
  // where it 404s on every poll and the panel waits forever.
  const cameras = await listPrinterCameras(
    new FakeTransport({
      webcams: [
        { name: 'Nozzle', service: 'mjpegstreamer', snapshot_url: 'http://printer.local:8080/?action=snapshot' },
      ],
    }),
    undefined,
    'http://printer.local:7125',
  );
  assert.equal(cameras[0].snapshotUrl, 'http://printer.local:8080/?action=snapshot');
  assert.equal(cameras[0].snapshotPath, undefined, 'it must not be re-pointed at the Moonraker port');
  assert.equal(cameras[0].unsupportedReason, undefined);
  assert.equal(cameraCanShowFrames(cameras[0]), true);
});

await test('a camera on a different host is refused, and says where it was pointing', async () => {
  const cameras = await listPrinterCameras(
    new FakeTransport({ webcams: [{ name: 'Elsewhere', snapshot_url: 'http://evil.example/steal?x=1' }] }),
    undefined,
    'http://printer.local:7125',
  );
  assert.equal(cameras[0].snapshotPath, undefined);
  assert.equal(cameras[0].snapshotUrl, undefined);
  assert.equal(cameraCanShowFrames(cameras[0]), false);
  assert.match(cameras[0].unsupportedReason ?? '', /evil\.example/);
  assert.match(cameras[0].unsupportedReason ?? '', /printer\.local:7125/);
});

await test('a relative path belongs to the printer\u2019s web origin, not its API port', () => {
  // Measured on a real machine: Moonraker reports `/webcam/snapshot.jpg`, nginx
  // serves it on port 80 (200 image/jpeg) and Moonraker's own 7125 answers 404.
  // Both are offered, the likely one first, so neither arrangement needs
  // anybody to configure which one they have.
  const endpoint = 'http://192.168.1.228:7125';
  assert.deepEqual(resolveCameraSources('/webcam/snapshot.jpg', endpoint), {
    snapshotUrl: 'http://192.168.1.228/webcam/snapshot.jpg',
    snapshotPath: '/webcam/snapshot.jpg',
  });
  // A bare relative path is rooted the same way.
  assert.equal(
    resolveCameraSources('webcam/?action=snapshot', endpoint).snapshotUrl,
    'http://192.168.1.228/webcam/?action=snapshot',
  );
  // With no endpoint to resolve against, the only reading left is the historic
  // one: a path on whatever the transport is pointed at.
  assert.deepEqual(resolveCameraSources('/webcam/snapshot.jpg'), { snapshotPath: '/webcam/snapshot.jpg' });
});

await test('the endpoint decides which reading an absolute URL gets', () => {
  const endpoint = 'http://printer.local:7125';
  // On Moonraker's own origin, both routes exist: the browser can load it, and
  // the transport can fetch it with the key if that fails.
  assert.deepEqual(resolveCameraSources('http://printer.local:7125/webcam/?action=snapshot', endpoint), {
    snapshotPath: '/webcam/?action=snapshot',
    snapshotUrl: 'http://printer.local:7125/webcam/?action=snapshot',
  });
  assert.deepEqual(resolveCameraSources('http://printer.local:8080/?action=snapshot', endpoint), {
    snapshotUrl: 'http://printer.local:8080/?action=snapshot',
  });
  assert.match(resolveCameraSources('http://elsewhere.local:8080/x', endpoint).unsupportedReason ?? '', /elsewhere/);
  assert.match(resolveCameraSources('javascript:alert(1)', endpoint).unsupportedReason ?? '', /not a URL/);
  assert.deepEqual(resolveCameraSources(undefined, endpoint), {});
});

await test('an image is preferred, and a fetch is only tried where an image cannot go', () => {
  const camera = {
    uid: 'c',
    name: 'case',
    service: 'webrtc-camerastreamer' as const,
    enabled: true,
    snapshotUrl: 'http://192.168.1.228/webcam/snapshot.jpg',
    snapshotPath: '/webcam/snapshot.jpg',
    targetFps: 15,
    rotationDegrees: 0 as const,
    flipHorizontal: false,
    flipVertical: false,
  };
  // On a plain-HTTP page the browser can display it, which needs no CORS — the
  // only thing that works against a service sending no `access-control-*`.
  assert.equal(cameraLoadsAsImage(camera, 'http:'), true);
  assert.deepEqual([...cameraMechanisms(camera, 'http:')], ['image', 'transport']);
  // On an HTTPS page it is mixed content, so the bytes are the only route and
  // the camera has to allow the read itself.
  assert.equal(cameraLoadsAsImage(camera, 'https:'), false);
  assert.deepEqual([...cameraMechanisms(camera, 'https:')], ['direct', 'transport']);
  // A camera with nowhere to fall back to offers exactly one route.
  const { snapshotPath: _dropped, ...directOnly } = camera;
  assert.deepEqual([...cameraMechanisms(directOnly, 'http:')], ['image']);

  // The frame URL is made unique, or the browser shows the frame it already has.
  const first = cameraDirectFrameUrl(camera, 1);
  assert.match(first ?? '', /^http:\/\/192\.168\.1\.228\/webcam\/snapshot\.jpg\?orcaxr_frame=1$/);
  assert.notEqual(first, cameraDirectFrameUrl(camera, 2));
});

await test('a same-host camera is fetched directly and without the printer key', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push({ url: request.url, ...(init ? { init } : {}) });
    assert.equal(request.headers.get('x-api-key'), null, 'one service\u2019s key is not handed to another');
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;
  try {
    const transport = new FakeTransport(WEBCAMS);
    const camera = {
      uid: 'c',
      name: 'Nozzle',
      service: 'mjpegstreamer' as const,
      enabled: true,
      snapshotUrl: 'http://printer.local:8080/?action=snapshot',
      targetFps: 2,
      rotationDegrees: 0 as const,
      flipHorizontal: false,
      flipVertical: false,
    };
    assert.deepEqual([...(await fetchCameraSnapshot(transport, camera, undefined, 'direct'))], [1, 2, 3]);
    assert.equal(seen[0]?.url, 'http://printer.local:8080/?action=snapshot');
    assert.deepEqual(transport.calls, [], 'the Moonraker transport is not involved at all');

    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await assert.rejects(
      () => fetchCameraSnapshot(transport, camera, undefined, 'direct'),
      (error: unknown) =>
        error instanceof PrinterCameraError &&
        error.code === 'snapshot-failed' &&
        /answered 404 at http:\/\/printer\.local:8080/.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

await test('the reported Snapmaker payload resolves to the port that actually serves it', async () => {
  // Verbatim from `http://192.168.1.228:7125/server/webcams/list` on a Snapmaker
  // running camera-streamer behind nginx: the snapshot is relative, port 80
  // answers it with `200 image/jpeg`, and Moonraker's own 7125 answers 404.
  const cameras = await listPrinterCameras(
    new FakeTransport({
      webcams: [
        {
          name: 'case',
          enabled: true,
          target_fps: 15,
          service: 'webrtc-camerastreamer',
          stream_url: '/webcam/webrtc',
          snapshot_url: '/webcam/snapshot.jpg',
          uid: 'b46ed60e-478f-52e1-aa7f-ef77195d7e5f',
        },
      ],
    }),
    undefined,
    'http://192.168.1.228:7125',
  );
  const [camera] = cameras;
  assert.equal(camera.snapshotUrl, 'http://192.168.1.228/webcam/snapshot.jpg');
  assert.equal(camera.unsupportedReason, undefined, 'a camera with a snapshot is not stream-only');
  assert.equal(cameraCanShowFrames(camera), true);
  // On a plain-HTTP page it is simply displayed, which is what works against a
  // service that sends no cross-origin headers.
  assert.deepEqual([...cameraMechanisms(camera, 'http:')], ['image', 'transport']);
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
