/**
 * The immersive shell's entry point, and the reason it is one module.
 *
 * Everything the headset draws — the menu bar, the palette, the panel host, the
 * keypad, the Device and Project pages — is only reachable inside a WebXR
 * session, and the overwhelming majority of page loads never enter one: a maker
 * checking a plate on a phone, a laptop opening a project. Statically importing
 * it put ~28 KB of spatial UI into the first script every one of those loads
 * has to fetch and parse before anything is on screen.
 *
 * So `OrcaWorkspace` reaches it through exactly one dynamic `import()` of this
 * file, taken when a session starts (or when `?xrui=1` asks to review the
 * layout on a desktop). Rollup then emits the whole immersive shell as its own
 * chunk, the service worker precaches it like any other asset so it is still
 * available offline, and the flat shell stops paying for a headset it does not
 * have.
 *
 * Keep this list to what the workspace calls at *runtime*. Types are erased, so
 * a `import type` elsewhere costs nothing and does not pull the chunk in.
 */
export { XrImmersiveShell } from './XrImmersiveShell';
export { renderXrPreviewScrubber } from './XrPreviewScrubber';
export { renderXrDeviceWorkspace } from './XrDeviceWorkspace';
export { renderXrProjectWorkspace } from './XrProjectWorkspace';
export { renderXrPrintSubmissionDialog } from './XrPrintSubmissionDialog';
