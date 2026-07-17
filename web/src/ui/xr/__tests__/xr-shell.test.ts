/**
 * XrShell renderer tests (run: npx tsx xr-shell.test.ts). Uses fake uikit
 * constructors so we can assert the XR shell draws the SAME actions the DOM
 * shell does — click routing, icons, and active-tool restyle — with no browser.
 */
import assert from 'node:assert';
import { renderXrActionButton, refreshXrToolActive, xrToolRailActions, type XrUiFactory } from '../XrShell';
import { buildRegistry } from '../../../actions/catalog';
import { xrIcon } from '../../icons';
import { tokens } from '../../tokens';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// Fake uikit: records constructor opts, exposes fillColor/color + onClick.
class FakePanel {
  fillColor: string;
  opts: Record<string, unknown>;
  children: unknown[] = [];
  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    this.fillColor = opts.fillColor as string;
  }
  add(c: unknown) {
    this.children.push(c);
  }
  setFillColor(color: string) {
    this.fillColor = color;
  }
  setProperties(props: { opacity?: number }) {
    Object.assign(this.opts, props);
  }
  click() {
    return (this.opts.onClick as () => boolean)();
  }
}
class FakeIcon {
  color: string;
  name: string;
  constructor(name: string, opts: Record<string, unknown>) {
    this.name = name;
    this.color = opts.color as string;
  }
  setColor(color: string) {
    this.color = color;
  }
}
const factory: XrUiFactory<FakePanel, FakeIcon> = {
  createPanel: (opts) => new FakePanel(opts),
  createIcon: (name, opts) => new FakeIcon(name, opts),
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
    const h = renderXrActionButton(a, () => {}, factory);
    assert.ok(h.iconEl instanceof FakeIcon);
    assert.strictEqual((h.iconEl as unknown as FakeIcon).name, xrIcon(a.icon), `${a.id} icon mismatch`);
    assert.strictEqual((h.btn as unknown as FakePanel).children.length, 1, 'button has icon child');
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
  const h = renderXrActionButton(move, (a) => runs.push(a.id), factory);
  const callbackResult = (h.btn as unknown as FakePanel).click();
  assert.strictEqual(callbackResult, undefined, 'UIBlocks callbacks do not control bubbling');
  assert.deepStrictEqual(runs, ['tool_move']);
});

test('active-tool restyle highlights only the matching tool, not op actions', () => {
  const handles = toolbar.map((a) => renderXrActionButton(a, () => {}, factory));
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
  const h = renderXrActionButton(del, () => {}, factory, { danger: true });
  assert.strictEqual((h.iconEl as unknown as FakeIcon).color, tokens.color.danger);
});

console.log(`\nXrShell: ${passed} tests passed. (${toolbar.length} toolbar actions)`);
