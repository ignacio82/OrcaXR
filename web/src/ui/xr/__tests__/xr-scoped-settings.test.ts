/**
 * Traces for the XR scoped-settings rows (P6.5).
 *
 * The recurring failure in this shell is a control that is drawn but wired to
 * nothing — a panel looks complete, and the press goes nowhere. That has been
 * caught before only by driving a real browser. Drawing through the mockable UI
 * adapter makes it assertable here instead: these traces click the rendered
 * nodes and require that the press reaches the controller with the field and
 * the direction the row claims.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import { renderXrScopedSettings, xrScopedSettingsSignature } from '../XrScopedSettings';
import type { XrPanelProperties, XrTextProperties, XrUiAdapter } from '../XrUiAdapter';
import type { ScopedStepperView } from '../../../settings/editor/scopedStepper';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakePanel {
  fillColor: string;
  readonly children: (FakePanel | FakeText)[] = [];
  constructor(readonly opts: XrPanelProperties) {
    this.fillColor = String(opts.fillColor ?? '');
  }
  click(): void {
    this.opts.onClick?.();
  }
  hoverEnter(): void {
    this.opts.onHoverEnter?.(new THREE.Object3D());
  }
  /** Every text in this subtree, in draw order. */
  texts(): FakeText[] {
    return this.children.flatMap((child) => (child instanceof FakeText ? [child] : child.texts()));
  }
  /** Every clickable panel in this subtree, in draw order. */
  buttons(): FakePanel[] {
    return this.children.flatMap((child) =>
      child instanceof FakeText ? [] : [...(child.opts.onClick ? [child] : []), ...child.buttons()],
    );
  }
}
class FakeText {
  constructor(
    public text: string,
    readonly opts: XrTextProperties,
  ) {}
}

const adapter: XrUiAdapter<FakePanel, never, FakeText> = {
  createPanel: (opts) => new FakePanel(opts),
  createImage: () => {
    throw new Error('the scoped settings rows draw no icons');
  },
  createText: (text, opts) => new FakeText(text, opts),
  appendImage: () => {
    throw new Error('the scoped settings rows draw no icons');
  },
  appendChild: (panel, child) => {
    panel.children.push(child as FakePanel | FakeText);
  },
  setPanelFill: (panel, fill) => {
    panel.fillColor = String(fill);
  },
  setPanelOpacity: () => {},
  setImageColor: () => {},
  setText: (text, value) => {
    text.text = value;
  },
};

function view(overrides: Partial<ScopedStepperView> = {}): ScopedStepperView {
  return {
    status: 'ready',
    targetIndex: 1,
    targetCount: 3,
    targetLabel: 'Plate 1 › Cube',
    scope: 'object',
    unavailable: 7,
    rows: [
      {
        fieldId: 'infill:sparse_infill_density',
        key: 'sparse_infill_density',
        label: 'Sparse infill density',
        group: 'Infill',
        value: '15%',
        unit: '',
        overridden: true,
        steppable: true,
      },
      {
        fieldId: 'infill:sparse_infill_pattern',
        key: 'sparse_infill_pattern',
        label: 'Sparse infill pattern',
        group: 'Infill',
        value: 'grid',
        unit: '',
        overridden: false,
        steppable: true,
      },
      {
        fieldId: 'walls:wall_generator',
        key: 'wall_generator',
        label: 'Wall generator',
        group: 'Walls',
        value: 'arachne',
        unit: '',
        overridden: false,
        steppable: false,
        reason: 'This setting has no declared limits, so stepping it could reach a value the engine refuses.',
      },
    ],
    ...overrides,
  };
}

const noopHandlers = { onCycleTarget: () => {}, onStep: () => {} };

test('a stepper press reaches the controller with its own field and direction', () => {
  const presses: [string, number][] = [];
  const root = new FakePanel({});
  renderXrScopedSettings(adapter, root, view(), {
    onCycleTarget: () => {},
    onStep: (fieldId, direction) => presses.push([fieldId, direction]),
  });
  // The picker's two buttons come first; each steppable row adds its own pair.
  const buttons = root.buttons();
  assert.equal(buttons.length, 2 + 2 * 2, 'two picker buttons and one pair per steppable row');
  for (const button of buttons.slice(2)) button.click();
  assert.deepEqual(presses, [
    ['infill:sparse_infill_density', -1],
    ['infill:sparse_infill_density', 1],
    ['infill:sparse_infill_pattern', -1],
    ['infill:sparse_infill_pattern', 1],
  ]);
});

test('the target picker cycles both ways', () => {
  const cycles: number[] = [];
  const root = new FakePanel({});
  renderXrScopedSettings(adapter, root, view(), {
    onCycleTarget: (direction) => cycles.push(direction),
    onStep: () => {},
  });
  const [back, forward] = root.buttons();
  back.click();
  forward.click();
  assert.deepEqual(cycles, [-1, 1]);
  const texts = root.texts().map((text) => text.text);
  assert.ok(texts.includes('Plate 1 › Cube'), 'the node being edited is named');
  assert.ok(texts.includes('2/3'), 'and its place in the list is shown, so the list feels finite');
});

test('a setting no stepper can reach keeps its value and gains no buttons', () => {
  const root = new FakePanel({});
  renderXrScopedSettings(adapter, root, view(), noopHandlers);
  const rows = root.children.filter((child): child is FakePanel => child instanceof FakePanel);
  const refused = rows.find((row) => row.texts().some((text) => text.text === 'Wall generator'));
  assert.ok(refused);
  assert.equal(refused.buttons().length, 0, 'no press is offered where no press is valid');
  assert.ok(
    refused.texts().some((text) => text.text === 'arachne'),
    'the value still reads, because knowing it is why an operator looks',
  );
});

test('an overridden row is tinted, because "where did I set that" is the question', () => {
  const root = new FakePanel({});
  renderXrScopedSettings(adapter, root, view(), noopHandlers);
  const rows = root.children.filter((child): child is FakePanel => child instanceof FakePanel);
  const overridden = rows.find((row) => row.texts().some((text) => text.text === 'Sparse infill density'));
  const inherited = rows.find((row) => row.texts().some((text) => text.text === 'Sparse infill pattern'));
  assert.ok(overridden && inherited);
  assert.notEqual(overridden.fillColor, inherited.fillColor);
});

test('group headings appear once, in the order the rows arrive', () => {
  const root = new FakePanel({});
  renderXrScopedSettings(adapter, root, view(), noopHandlers);
  const headings = root.children
    .filter((child): child is FakeText => child instanceof FakeText)
    .map((text) => text.text);
  assert.deepEqual(
    headings.filter((text) => text === 'Infill' || text === 'Walls'),
    ['Infill', 'Walls'],
  );
});

test('the settings this surface cannot offer are counted, not silently dropped', () => {
  const root = new FakePanel({});
  renderXrScopedSettings(adapter, root, view(), noopHandlers);
  assert.ok(
    root.texts().some((text) => text.text.startsWith('7 more are unavailable on every surface')),
    'a list that hid them would read as complete',
  );
});

test('a value is rewritten in place rather than by rebuilding the panel', () => {
  const root = new FakePanel({});
  const render = renderXrScopedSettings(adapter, root, view(), noopHandlers);
  const bound = render.values.get('infill:sparse_infill_density');
  assert.ok(bound);
  assert.equal(bound.node.text, '15%');
  adapter.setText(bound.node, '20%');
  assert.equal(bound.node.text, '20%');
  // And the shape did not change, so the shell has no reason to rebuild.
  assert.equal(render.signature, xrScopedSettingsSignature(view()));
});

test('a changed shape does force a rebuild', () => {
  const base = xrScopedSettingsSignature(view());
  assert.notEqual(base, xrScopedSettingsSignature(view({ targetIndex: 2 })));
  assert.notEqual(base, xrScopedSettingsSignature(view({ message: 'stale draft' })));
  assert.notEqual(base, xrScopedSettingsSignature(view({ rows: view().rows.slice(1) })));
  assert.notEqual(base, xrScopedSettingsSignature(null));
});

test('a shell that renders before the schema loads says so instead of looking empty', () => {
  const root = new FakePanel({});
  const render = renderXrScopedSettings(adapter, root, null, noopHandlers);
  assert.equal(render.values.size, 0);
  assert.ok(root.texts().some((text) => text.text === 'The settings schema is still loading.'));
  const loading = new FakePanel({});
  renderXrScopedSettings(adapter, loading, view({ status: 'loading', rows: [] }), noopHandlers);
  assert.equal(loading.buttons().length, 2, 'the picker is usable while the rows are still coming');
});

console.log(`\nXR scoped settings rows: ${passed} tests passed.`);
