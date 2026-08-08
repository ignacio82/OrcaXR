import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import type { WorkspacePreviewSurface } from '../OrcaWorkspace';

class TestAudioContext {
  readonly destination = {};
  readonly listener = {};
  readonly currentTime = 0;

  createGain() {
    return {
      gain: { value: 1, setTargetAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
}

class TestHtmlElement {}

const browserGlobals: Readonly<Record<string, unknown>> = {
  window: {
    location: { search: '' },
    AudioContext: TestAudioContext,
    addEventListener() {},
    removeEventListener() {},
  },
  document: {},
  navigator: {},
  HTMLElement: TestHtmlElement,
  customElements: { define() {}, get() {} },
  crypto: webcrypto,
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const [{ OrcaWorkspace }, { buildRegistry }] = await Promise.all([
  import('../OrcaWorkspace'),
  import('../../actions/catalog'),
]);

const GCODE = ['M83', ';LAYER_CHANGE', 'G1 X10 E1'].join('\n');

class ControlledPreviewSurface implements WorkspacePreviewSurface {
  fail = false;
  renderCount = 0;
  clearCount = 0;
  readonly visibility: boolean[] = [];

  clear(): void {
    this.clearCount += 1;
  }

  setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }

  render() {
    this.renderCount += 1;
    if (this.fail) throw new Error('G-code preview requires more than 4 rendered segments');
    return { segmentCount: 1, recordCount: 1, skippedRecordCount: 0 };
  }
}

let passed = 0;

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('open propagates a bounded renderer failure and publishes inactive actionable state', () => {
  const surface = new ControlledPreviewSurface();
  surface.fail = true;
  const workspace = new OrcaWorkspace(buildRegistry(), { previewSurfaceFactory: () => surface });
  const statuses: string[] = [];
  let notifications = 0;
  workspace.onStatusChanged = (status) => statuses.push(status);
  workspace.onPreviewStateChanged = () => {
    notifications += 1;
  };

  assert.equal(workspace.openGcodeForPreview(GCODE, 'too-large.gcode'), false);
  assert.equal(surface.renderCount, 1);
  assert.ok(surface.clearCount >= 1);
  assert.equal(surface.visibility.at(-1), false);
  assert.ok(notifications >= 1);
  assert.match(statuses.at(-1) ?? '', /segment limit.*fewer layers or move classes/i);
  const state = workspace.getPreviewState();
  assert.equal(state.active, false);
  assert.equal(state.source?.name, 'too-large.gcode');
  assert.match(state.unsupportedReason ?? '', /segment limit.*fewer layers or move classes/i);
  assert.equal(workspace.getAutomationSnapshot().workspaceMode, 'Prepare');
  workspace.dispose();
});

test('a view redraw failure clears and hides the old surface instead of leaving preview mode active', () => {
  const surface = new ControlledPreviewSurface();
  const workspace = new OrcaWorkspace(buildRegistry(), { previewSurfaceFactory: () => surface });
  assert.equal(workspace.openGcodeForPreview(GCODE, 'view.gcode'), true);
  assert.equal(workspace.getPreviewState().active, true);
  assert.equal(surface.visibility.at(-1), true);

  let notifications = 0;
  workspace.onPreviewStateChanged = () => {
    notifications += 1;
  };
  surface.fail = true;
  assert.equal(workspace.updatePreviewView({ mode: 'Feedrate' }), false);
  assert.equal(surface.renderCount, 2);
  assert.ok(surface.clearCount >= 1);
  assert.equal(surface.visibility.at(-1), false);
  assert.equal(workspace.getPreviewState().active, false);
  assert.equal(workspace.getAutomationSnapshot().workspaceMode, 'Prepare');
  assert.equal(notifications, 1);
  workspace.dispose();
});

test('toggle does not overwrite a renderer failure with a false toolpath-preview success', () => {
  const surface = new ControlledPreviewSurface();
  surface.fail = true;
  const workspace = new OrcaWorkspace(buildRegistry(), { previewSurfaceFactory: () => surface });
  Object.defineProperty(workspace, 'getLastGcode', { value: () => GCODE, configurable: true });
  const statuses: string[] = [];
  workspace.onStatusChanged = (status) => statuses.push(status);

  assert.equal(workspace.togglePreview(), false);
  assert.equal(workspace.getPreviewState().active, false);
  assert.match(statuses.at(-1) ?? '', /segment limit.*fewer layers or move classes/i);
  assert.doesNotMatch(statuses.at(-1) ?? '', /^toolpath preview$/i);
  workspace.dispose();
});

console.log(`\n${passed} G-code workspace render-boundary tests passed.`);
