import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom has no bundled declaration file.
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { UIPanel, UICard } from 'xrblocks/addons/uiblocks/src/index.js';
import type { XrSurfaceId } from '../../ui/xr/XrLayout';
import type { XrImmersiveShell } from '../../ui/xr/XrImmersiveShell';

// Use the installed UIBlocks components and XRBlocks select dispatch. Calling
// fake button callbacks alone misses detached anchors and concurrent pointers.
const dom = new JSDOM('', { url: 'http://localhost/' });
class TestAudioContext {
  readonly destination = {};
  readonly listener = {};
  readonly currentTime = 0;
  createGain() {
    return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} };
  }
}
Object.defineProperty(dom.window, 'AudioContext', { value: TestAudioContext });
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const [xb, { OrcaWorkspace }, { buildRegistry }, { ActionContext }, { UiState }] = await Promise.all([
  import('xrblocks'),
  import('../OrcaWorkspace'),
  import('../../actions/catalog'),
  import('../../actions/ActionContext'),
  import('../../actions/UiState'),
]);

const registry = buildRegistry();
const workspace = new OrcaWorkspace(registry);
workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
const camera = new THREE.PerspectiveCamera();
camera.position.set(2, 1.6, 4);
camera.lookAt(1, 1.6, 3);
xb.core.camera = camera;
const internals = workspace as unknown as {
  xrShell: Pick<XrImmersiveShell<UIPanel, unknown, unknown>, 'draw' | 'state' | 'hide' | 'show'> & {
    menuBar: { sectionAnchors: Map<string, UIPanel> };
  };
  xrCardObjects: Map<XrSurfaceId, UICard>;
  xrCards: Record<XrSurfaceId, { content: UIPanel }>;
  recenterInFrontOfUser(): void;
};
await workspace.loadImmersiveShell();
internals.recenterInFrontOfUser();
const shell = internals.xrShell;
assert.ok(shell, 'the production shell must load');
shell.show();
internals.recenterInFrontOfUser();
const user = xb.core.user;
user.init({ input: xb.core.input, scene: xb.core.scene });

function pointer(id: number) {
  const controller = new THREE.Group();
  controller.userData = { id, connected: true, selected: false };
  return controller;
}
const left = pointer(0);
const right = pointer(1);
function press(controller: THREE.Group, button: UIPanel) {
  // UIBlocks hits a shader layer beneath the button, rather than the root.
  const hit = { object: button.children[0], point: button.getWorldPosition(new THREE.Vector3()), distance: 1 };
  xb.core.input.intersectionsForController.set(controller, [hit]);
  user.onSelectStart({ target: controller });
}
function release(controller: THREE.Group) {
  user.onSelectEnd({ target: controller });
}

const file = shell.menuBar.sectionAnchors.get('file')!;
const originalAnchor = file.getWorldPosition(new THREE.Vector3());
press(left, file);
release(left);
assert.equal(shell.state.overlay.kind, 'menu');
const menu = internals.xrCardObjects.get('menu')!;
const forward = camera.getWorldDirection(new THREE.Vector3());
assert.ok(
  menu.position.clone().sub(camera.position).dot(forward) > 0,
  'File must open in front of the operator, using its still-mounted title anchor',
);
assert.ok(file.getWorldPosition(new THREE.Vector3()).distanceTo(originalAnchor) < 1e-9);
assert.equal(shell.menuBar.sectionAnchors.get('file'), file, 'opening a menu must retain its trigger');

// A second pointer may already be held while the first opens/closes a menu.
const edit = shell.menuBar.sectionAnchors.get('edit')!;
press(right, edit);
press(left, file);
release(left);
release(right);
assert.deepEqual(shell.state.overlay, { kind: 'menu', sectionId: 'edit' });

const cockpit = ['menubar', 'tools', 'inspector', 'desk'] as const;
const retained = cockpit.map((id) => internals.xrCards[id].content.children[0]);
for (let i = 0; i < 12; i += 1) {
  press(left, file);
  release(left);
}
assert.deepEqual(
  cockpit.map((id) => internals.xrCards[id].content.children[0]),
  retained,
  'menu-only transitions must not rebuild the cockpit and its shader/text resources',
);

// Canonical refreshes must also place open menus from their live title.
shell.draw();
assert.ok(menu.position.clone().sub(camera.position).dot(forward) > 0);
shell.state.closeOverlay();
assert.equal(menu.visible, false);
let hiddenRaycasts = 0;
const content = internals.xrCards.menu.content;
const raycast = content.raycast;
content.raycast = () => {
  hiddenRaycasts += 1;
};
xb.core.input.raycaster.intersectObject(menu, true);
content.raycast = raycast;
assert.equal(hiddenRaycasts, 0, 'a closed menu must prune its subtree from XR raycasts');
press(right, file);
release(right);
assert.equal(menu.visible, true, 'the same menu can be reopened after hiding');
shell.hide();
for (const card of internals.xrCardObjects.values()) assert.equal(card.visible, false);
shell.show();
for (const id of cockpit) assert.equal(internals.xrCardObjects.get(id)!.visible, true);
shell.state.closeOverlay();
dom.window.close();
console.log('XR menu input: live anchors, two-pointer release, and retained cockpit pass.');
