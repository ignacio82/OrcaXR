import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import { PrinterCameraPanel } from '../PrinterCameraPanel';
import type { PrinterCamera } from '../../../printer/PrinterCamera';
const dom = new JSDOM('<main></main>');
const camera: PrinterCamera = {
  uid: 'one',
  name: 'Nozzle',
  enabled: true,
  service: 'mjpegstreamer',
  snapshotPath: '/snapshot',
  targetFps: 4,
  rotationDegrees: 0,
  flipHorizontal: false,
  flipVertical: false,
};
let visible = true;
let visibilityChanged = () => {};
let tick = () => {};
const captures: AbortSignal[] = [];
const panel = new PrinterCameraPanel(
  dom.window.document.querySelector('main'),
  {
    getCameras: () => [camera],
    getSelected: () => camera,
    getFrameUrl: () => undefined,
    getStatus: () => ({ busy: false }),
    subscribe: () => () => {},
    select: () => {},
    refresh: () => {},
    captureFrame: (...args: unknown[]) => {
      captures.push(args[0] as AbortSignal);
      return new Promise(() => {});
    },
  },
  {
    isVisible: () => visible,
    subscribeVisibility: (listener) => {
      visibilityChanged = listener;
      return () => {};
    },
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {},
  },
);
panel.mount();
assert.equal(captures.length, 1);
assert.ok(captures[0], 'a capture must carry an owned cancellation signal');
tick();
assert.equal(captures.length, 1, 'a slow frame cannot overlap another request');
visible = false;
visibilityChanged();
assert.equal(captures[0].aborted, true, 'hiding the panel cancels its pending frame');
tick();
assert.equal(captures.length, 1, 'a queued timer callback cannot capture after hiding');
visible = true;
visibilityChanged();
assert.equal(captures.length, 2);
panel.dispose();
assert.equal(captures[1].aborted, true);
tick();
assert.equal(captures.length, 2);
dom.window.close();
console.log('Camera lifecycle: no overlapping, hidden, or disposed captures; pending frames are cancelled.');
