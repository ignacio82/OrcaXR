import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { GcodePreviewSession } from '../../slicer/GcodePreviewSession';
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

async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('open propagates a bounded renderer failure and publishes inactive actionable state', async () => {
  const surface = new ControlledPreviewSurface();
  surface.fail = true;
  const workspace = new OrcaWorkspace(buildRegistry(), {
    previewSurfaceFactory: () => surface,
    previewSessionFactory: async (gcode, source) => GcodePreviewSession.fromGcode(gcode, source),
  });
  const statuses: string[] = [];
  let notifications = 0;
  workspace.onStatusChanged = (status) => statuses.push(status);
  workspace.onPreviewStateChanged = () => {
    notifications += 1;
  };

  assert.equal(await workspace.openGcodeForPreview(GCODE, 'too-large.gcode'), false);
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

await test('a view redraw failure clears and hides the old surface instead of leaving preview mode active', async () => {
  const surface = new ControlledPreviewSurface();
  const workspace = new OrcaWorkspace(buildRegistry(), {
    previewSurfaceFactory: () => surface,
    previewSessionFactory: async (gcode, source) => GcodePreviewSession.fromGcode(gcode, source),
  });
  assert.equal(await workspace.openGcodeForPreview(GCODE, 'view.gcode'), true);
  assert.equal(workspace.getPreviewState().active, true);
  assert.equal(surface.visibility.at(-1), true);

  let notifications = 0;
  workspace.onPreviewStateChanged = () => {
    notifications += 1;
  };
  surface.fail = true;
  assert.equal(await workspace.updatePreviewView({ mode: 'Feedrate' }), false);
  assert.equal(surface.renderCount, 2);
  assert.ok(surface.clearCount >= 1);
  assert.equal(surface.visibility.at(-1), false);
  assert.equal(workspace.getPreviewState().active, false);
  assert.equal(workspace.getAutomationSnapshot().workspaceMode, 'Prepare');
  assert.ok(notifications >= 1);
  workspace.dispose();
});

await test('toggle does not overwrite a renderer failure with a false toolpath-preview success', async () => {
  const surface = new ControlledPreviewSurface();
  surface.fail = true;
  const workspace = new OrcaWorkspace(buildRegistry(), {
    previewSurfaceFactory: () => surface,
    previewSessionFactory: async (gcode, source) => GcodePreviewSession.fromGcode(gcode, source),
  });
  Object.defineProperty(workspace, 'getLastGcode', { value: () => GCODE, configurable: true });
  const statuses: string[] = [];
  workspace.onStatusChanged = (status) => statuses.push(status);

  assert.equal(await workspace.togglePreview(), false);
  assert.equal(workspace.getPreviewState().active, false);
  assert.match(statuses.at(-1) ?? '', /segment limit.*fewer layers or move classes/i);
  assert.doesNotMatch(statuses.at(-1) ?? '', /^toolpath preview$/i);
  workspace.dispose();
});

await test('replacement and disposal cancel old sources and reject late sessions', async () => {
  const surface = new ControlledPreviewSurface();
  const requests: { signal: AbortSignal; complete: () => void }[] = [];
  let disposedSessions = 0;
  const workspace = new OrcaWorkspace(buildRegistry(), {
    previewSurfaceFactory: () => surface,
    previewSessionFactory: (gcode, source, signal) =>
      new Promise((resolve) => {
        const session = GcodePreviewSession.fromGcode(gcode, source);
        requests.push({
          signal,
          complete: () =>
            resolve(
              Object.assign(session, {
                dispose: () => {
                  disposedSessions++;
                },
              }),
            ),
        });
      }),
  });
  const first = workspace.openGcodeForPreview(GCODE, 'obsolete.gcode');
  const second = workspace.openGcodeForPreview(GCODE, 'current.gcode');
  assert.equal(requests[0].signal.aborted, true);
  requests[1].complete();
  assert.equal(await second, true);
  requests[0].complete();
  assert.equal(await first, false);
  assert.equal(workspace.getPreviewState().source?.name, 'current.gcode');
  assert.equal(surface.renderCount, 1);
  assert.equal(disposedSessions, 1);
  const final = workspace.openGcodeForPreview(GCODE, 'closed.gcode');
  workspace.dispose();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].complete();
  assert.equal(await final, false);
  assert.equal(surface.renderCount, 1);
  assert.equal(disposedSessions, 3);
});

await test('closing a retained non-drawable preview releases it without requiring a sliced artifact', async () => {
  const surface = new ControlledPreviewSurface();
  surface.fail = true;
  let disposed = 0;
  const workspace = new OrcaWorkspace(buildRegistry(), {
    previewSurfaceFactory: () => surface,
    previewSessionFactory: async (gcode, source) =>
      Object.assign(GcodePreviewSession.fromGcode(gcode, source), {
        dispose: () => {
          disposed++;
        },
      }),
  });
  assert.equal(await workspace.openGcodeForPreview(GCODE, 'unsupported.gcode'), false);
  assert.ok(workspace.getPreviewState().view, 'the controls can still recover the retained session');
  assert.equal(await workspace.togglePreview(), true);
  assert.equal(workspace.getPreviewState().view, undefined);
  assert.equal(workspace.getPreviewState().unsupportedReason, undefined);
  assert.equal(disposed, 1);
  assert.equal(surface.renderCount, 1);
  workspace.dispose();
});

console.log(`\n${passed} G-code workspace render-boundary tests passed.`);
