import assert from 'node:assert/strict';
import * as THREE from 'three';

import type { EntityId, IdSource } from '../../project/domain/ids';
import { SlicePreflightError, type CanonicalSlicePreflightPort } from '../../project/slicing';
import { SlicerClientCancellationError, type SlicerClientProjectSliceOptions } from '../../slicer/SlicerClient';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';
import { CanonicalWorkspaceSlicer } from '../CanonicalWorkspaceSlicer';

const NOW = '2026-07-20T14:00:00.000Z';

class SequenceIdSource implements IdSource {
  private sequence = 0;
  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    this.sequence += 1;
    return `import:workspace-slicer:${kind}-${this.sequence}` as EntityId<Kind>;
  }
}

function controller(): CanonicalWorkspaceController {
  const workspace = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [200, 200], worldUnitsPerMm: 0.00175 },
    initialProjectConfig: {
      printable_area: ['0x0', '200x0', '200x200', '0x200'],
      print_settings_id: 'fixture-process',
    },
  });
  workspace.importBufferGeometry(new THREE.TetrahedronGeometry(8), { name: 'Slice fixture' });
  return workspace;
}

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('submits canonical per-plate 3MF and publishes defensive current results', async () => {
  const workspace = controller();
  const submissions: ArrayBuffer[] = [];
  const statuses: string[] = [];
  const slicer = new CanonicalWorkspaceSlicer({
    workspace,
    client: {
      async sliceProjectWithRoute(project, _route, options) {
        submissions.push(project.slice(0));
        options?.onProgress?.({ percent: 47, message: 'canonical fixture progress' });
        return '; canonical gcode\nG1 X1 Y2\n';
      },
    },
    route: { kind: 'browser-wasm' },
    createJobId: () => 'workspace-slice-1',
    now: () => NOW,
  });
  slicer.subscribe((status) => statuses.push(`${status.phase}:${status.progressPercent ?? ''}`));

  const result = await slicer.startCurrentPlate().completion;
  assert.deepEqual(Array.from(new Uint8Array(submissions[0]).subarray(0, 2)), [0x50, 0x4b]);
  assert.ok(statuses.includes('submitting:47'));
  assert.equal(result.plates.length, 1);
  assert.equal(new TextDecoder().decode(result.plates[0].gcode), '; canonical gcode\nG1 X1 Y2\n');

  result.plates[0].gcode[0] = 0;
  assert.notEqual(slicer.getLatestResult()!.plates[0].gcode[0], 0);
  slicer.dispose();
  assert.throws(() => slicer.startCurrentPlate(), /disposed/);
  workspace.dispose();
});

await test('disposal cancels active work through the captured route', async () => {
  const workspace = controller();
  let observedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const slicer = new CanonicalWorkspaceSlicer({
    workspace,
    client: {
      sliceProjectWithRoute(_project, _route, options?: SlicerClientProjectSliceOptions) {
        observedSignal = options?.signal;
        markStarted();
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new SlicerClientCancellationError('local worker terminated', true)),
            { once: true },
          );
        });
      },
    },
    route: { kind: 'browser-wasm' },
  });
  const handle = slicer.startCurrentPlate();
  await started;
  slicer.dispose();
  await assert.rejects(handle.completion);
  assert.equal(observedSignal?.aborted, true);
  workspace.dispose();
});

await test('injects preflight before serialization and preserves structured blocking evidence', async () => {
  const workspace = controller();
  const plateId = workspace.getSummary().activePlateId;
  let preflightCalls = 0;
  let clientCalls = 0;
  const preflight: CanonicalSlicePreflightPort = {
    evaluate(snapshot, requestedPlateId) {
      preflightCalls += 1;
      assert.equal(snapshot.state.activePlateId, plateId);
      assert.equal(requestedPlateId, plateId);
      return {
        plateId,
        canSlice: false,
        blockingCount: 1,
        printableInstanceIds: [],
        usedFilamentIds: [],
        issues: [
          {
            id: 'slice-preflight:missing-profile-attestation:live-profile',
            code: 'missing-profile-attestation',
            detailCode: 'live-profile',
            severity: 'error',
            message: 'The exact live target profile is unavailable.',
            help: 'Choose a catalog-backed target before slicing.',
            entities: [{ kind: 'project' }],
            actions: [],
          },
        ],
      };
    },
  };
  const statuses: string[] = [];
  const slicer = new CanonicalWorkspaceSlicer({
    workspace,
    client: {
      async sliceProjectWithRoute() {
        clientCalls += 1;
        return '; must not run\n';
      },
    },
    route: { kind: 'browser-wasm' },
    preflight,
  });
  slicer.subscribe((status) => statuses.push(status.phase));

  const error = await slicer.startCurrentPlate().completion.catch((caught: unknown) => caught);
  assert.ok(error instanceof SlicePreflightError);
  assert.equal(error.result.issues[0].detailCode, 'live-profile');
  assert.equal(preflightCalls, 1);
  assert.equal(clientCalls, 0);
  assert.ok(statuses.includes('preflighting'));
  assert.equal(statuses.includes('serializing'), false);
  assert.ok(statuses.includes('failed'));
  slicer.dispose();
  workspace.dispose();
});

console.log(`\n${passed} canonical workspace slicer tests passed.`);
