/**
 * XrShell renderer tests (run: npx tsx xr-shell.test.ts). Uses fake uikit
 * constructors so we can assert the XR shell draws the SAME actions the DOM
 * shell does — click routing, icons, and active-tool restyle — with no browser.
 */
import assert from 'node:assert';
import { renderXrActionButton, refreshXrToolActive, type XrUiFactory } from '../XrShell';
import { buildRegistry } from '../../../actions/catalog';
import { xrIcon } from '../../icons';
import { tokens } from '../../tokens';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

// Fake uikit: records constructor opts, exposes fillColor/color + onClick.
class FakePanel {
  fillColor: string;
  opts: Record<string, unknown>;
  children: unknown[] = [];
  constructor(opts: Record<string, unknown>) { this.opts = opts; this.fillColor = opts.fillColor as string; }
  add(c: unknown) { this.children.push(c); }
  click() { return (this.opts.onClick as () => boolean)(); }
}
class FakeIcon {
  color: string;
  constructor(public name: string, opts: Record<string, unknown>) { this.color = opts.color as string; }
}
const factory: XrUiFactory = { Panel: FakePanel as never, Icon: FakeIcon as never };

const registry = buildRegistry();
const toolbar = registry.byDisclosure('toolbar');

test('registry exposes the expected toolbar action set (incl. paint)', () => {
  const ids = toolbar.map((a) => a.id).sort();
  assert.deepStrictEqual(ids, [
    'delete_models', 'drop_to_bed', 'tool_lay_on_face',
    'tool_move', 'tool_paint', 'tool_rotate', 'tool_scale',
  ]);
});

test('each toolbar action renders a button with its XR icon', () => {
  for (const a of toolbar) {
    const h = renderXrActionButton(a, () => {}, factory);
    assert.ok(h.iconEl instanceof FakeIcon);
    assert.strictEqual((h.iconEl as unknown as FakeIcon).name, xrIcon(a.icon),
      `${a.id} icon mismatch`);
    assert.strictEqual((h.btn as unknown as FakePanel).children.length, 1, 'button has icon child');
  }
});

test('clicking a button runs exactly that action', () => {
  const runs: string[] = [];
  const move = toolbar.find((a) => a.id === 'tool_move')!;
  const h = renderXrActionButton(move, (a) => runs.push(a.id), factory);
  const consumed = (h.btn as unknown as FakePanel).click();
  assert.strictEqual(consumed, true, 'onClick consumes the event');
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
