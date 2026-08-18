/**
 * XrShell renderer tests (run: npx tsx xr-shell.test.ts). Uses fake uikit
 * constructors so we can assert the XR shell draws the SAME actions the DOM
 * shell does — click routing, icons, and active-tool restyle — with no browser.
 */
import assert from 'node:assert';
import * as THREE from 'three';
import { renderXrActionButton, refreshXrToolActive, xrToolRailActions } from '../XrShell';
import type { XrImageColor, XrImageProperties, XrPanelFill, XrPanelProperties, XrUiAdapter } from '../XrUiAdapter';
import { buildRegistry } from '../../../actions/catalog';
import { xrIcon } from '../../icons';
import { tokens } from '../../tokens';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// Fake adapter nodes: property shapes still come from the pinned UIBlocks types.
class FakePanel {
  fillColor: XrPanelFill;
  opacity: number;
  readonly opts: XrPanelProperties;
  readonly children: FakeIcon[] = [];
  readonly nodes: (FakePanel | FakeText)[] = [];
  constructor(opts: XrPanelProperties) {
    this.opts = opts;
    this.fillColor = opts.fillColor ?? '#000000';
    this.opacity = typeof opts.opacity === 'number' ? opts.opacity : 1;
  }
  click(): void {
    this.opts.onClick?.();
  }
  hoverEnter(): void {
    this.opts.onHoverEnter?.(new THREE.Object3D());
  }
  hoverExit(): void {
    this.opts.onHoverExit?.(new THREE.Object3D());
  }
}
class FakeText {
  text: string;
  readonly opts: unknown;
  constructor(text: string, opts: unknown) {
    this.text = text;
    this.opts = opts;
  }
}
class FakeIcon {
  color: XrImageColor;
  readonly name: string;
  constructor(name: string, opts: XrImageProperties) {
    this.name = name;
    const color = opts.color;
    this.color =
      typeof color === 'string' || typeof color === 'number' || color instanceof THREE.Color ? color : '#ffffff';
  }
}
const adapter: XrUiAdapter<FakePanel, FakeIcon, FakeText> = {
  createPanel: (opts) => new FakePanel(opts),
  createImage: (name, opts) => new FakeIcon(name, opts),
  createText: (text, opts) => new FakeText(text, opts),
  appendImage: (panel, icon) => panel.children.push(icon),
  appendChild: (panel, child) => panel.nodes.push(child),
  setText: (text, value) => {
    text.text = value;
  },
  setPanelFill: (panel, fill) => {
    panel.fillColor = fill;
  },
  setPanelOpacity: (panel, opacity) => {
    panel.opacity = opacity;
  },
  setImageColor: (icon, color) => {
    icon.color = color;
  },
};

const registry = buildRegistry();
const toolbar = xrToolRailActions(registry.byDisclosure('toolbar'));

test('registry exposes the expected toolbar action set (incl. paint)', () => {
  const ids = toolbar.map((a) => a.id).sort();
  assert.deepStrictEqual(ids, [
    'delete_models',
    'drop_to_bed',
    'tool_lay_on_face',
    'tool_move',
    'tool_paint',
    'tool_rotate',
    'tool_scale',
  ]);
});

test('each toolbar action renders a button with its XR icon', () => {
  for (const a of toolbar) {
    const h = renderXrActionButton(a, () => {}, adapter);
    assert.ok(h.iconEl instanceof FakeIcon);
    assert.strictEqual(h.iconEl.name, xrIcon(a.icon), `${a.id} icon mismatch`);
    assert.strictEqual(h.btn.children.length, 1, 'button has icon child');
  }
});

test('XR icons resolve only to app-owned offline assets', () => {
  for (const action of registry.all()) {
    const url = xrIcon(action.icon);
    assert.match(url, /icons\/material\/[a-z0-9_]+\.svg$/);
    assert.ok(!/^https?:/i.test(url), `${action.id} must not fetch an icon at runtime`);
  }
});

test('clicking a button runs exactly that action', () => {
  const runs: string[] = [];
  const move = toolbar.find((a) => a.id === 'tool_move')!;
  const h = renderXrActionButton(move, (a) => runs.push(a.id), adapter);
  const callbackResult = h.btn.click();
  assert.strictEqual(callbackResult, undefined, 'UIBlocks callbacks do not control bubbling');
  assert.deepStrictEqual(runs, ['tool_move']);
});

test('active-tool restyle highlights only the matching tool, not op actions', () => {
  const handles = toolbar.map((a) => renderXrActionButton(a, () => {}, adapter));
  refreshXrToolActive(handles, 'rotate');
  const rot = handles.find((h) => h.action.id === 'tool_rotate')!;
  const mov = handles.find((h) => h.action.id === 'tool_move')!;
  const del = handles.find((h) => h.action.id === 'delete_models')!;
  assert.strictEqual(rot.btn.fillColor, tokens.color.surfaceActive, 'active tool highlighted');
  assert.strictEqual(mov.btn.fillColor, tokens.color.surface, 'inactive tool not highlighted');
  // delete_models has no `tool` → untouched (keeps its danger stroke button, idle fill).
  assert.strictEqual(del.btn.fillColor, tokens.color.surface);
});

test('danger button (delete) uses the danger icon colour', () => {
  const del = toolbar.find((a) => a.id === 'delete_models')!;
  const h = renderXrActionButton(del, () => {}, adapter, { danger: true });
  assert.strictEqual(h.iconEl.color, tokens.color.danger);
});

test('disabled and busy guards suppress callbacks until the live state permits them', () => {
  const runs: string[] = [];
  const move = toolbar.find((a) => a.id === 'tool_move')!;
  const h = renderXrActionButton(move, (a) => runs.push(a.id), adapter, { enabled: false });
  h.btn.click();
  assert.deepStrictEqual(runs, []);
  assert.strictEqual(h.btn.opacity, 0.45);

  h.setEnabled(true);
  h.setBusy(true);
  h.btn.click();
  assert.deepStrictEqual(runs, []);

  h.setBusy(false);
  h.btn.click();
  assert.deepStrictEqual(runs, ['tool_move']);
});

test('button disposal is idempotent and leaves no stale actionable callback', () => {
  const runs: string[] = [];
  const rotate = toolbar.find((a) => a.id === 'tool_rotate')!;
  const h = renderXrActionButton(rotate, (a) => runs.push(a.id), adapter);
  h.dispose();
  h.dispose();
  h.btn.hoverEnter();
  h.btn.click();
  assert.strictEqual(h.disposed, true);
  assert.strictEqual(h.btn.opacity, 0.45);
  assert.deepStrictEqual(runs, []);
});

console.log(`\nXrShell: ${passed} tests passed. (${toolbar.length} toolbar actions)`);
