import assert from 'node:assert/strict';
import * as THREE from 'three';

import type { EntityId, IdSource } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { ImportConfirmationError, type ProjectImportParserPort } from '../../project/import/types';
import { UnhealthyProjectProjectionError } from '../../project/session';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';
import { CanonicalWorkspaceSlicer } from '../CanonicalWorkspaceSlicer';

const NOW = '2026-07-23T12:00:00.000Z';
const MAPPING = { bedSizeMm: [200, 200] as const, worldUnitsPerMm: 0.00175 };

class SequenceIdSource implements IdSource {
  private sequence = 0;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    this.sequence += 1;
    return `import:live-boundary:${kind}-${this.sequence}` as EntityId<Kind>;
  }
}

function createController(projectImportParser?: ProjectImportParserPort): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectName: 'Live boundary fixture',
    initialProjectConfig: {
      printable_area: ['0x0', '200x0', '200x200', '0x200'],
      print_settings_id: 'live-boundary-process',
    },
    projectImportParser,
  });
}

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('requires an acknowledged preview before the live controller replaces a worker proposal', async () => {
  const source = createController();
  const geometry = new THREE.TetrahedronGeometry(7);
  source.importBufferGeometry(geometry, { name: 'Preview source' });
  const archive = await source.saveCanonical3mf();

  const delegate = new BbsProjectImportParser();
  let parseCalls = 0;
  const parser: ProjectImportParserPort = {
    async parse(request) {
      parseCalls += 1;
      const parsed = await delegate.parse(request);
      return {
        ...parsed,
        repairs: [
          {
            id: 'live-preview-repair',
            kind: 'other',
            path: '$.metadata',
            message: 'Synthetic repair proving the live acknowledgement boundary',
            before: 'source',
            after: 'normalized',
          },
        ],
      };
    },
  };
  const target = createController(parser);
  const before = target.getSummary();
  const prepared = await target.prepareCanonical3mfImport(archive.bytes, {
    filename: 'preview-source.3mf',
    mediaType: archive.mediaType,
  });

  assert.equal(parseCalls, 1);
  assert.deepEqual(target.getSummary(), before, 'worker preparation must not mutate live state');
  assert.deepEqual(prepared.preview.requiredAcknowledgementIds, ['live-preview-repair']);
  assert.throws(
    () => prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] }),
    (error: unknown) => {
      assert.ok(error instanceof ImportConfirmationError);
      assert.deepEqual(error.missingAcknowledgementIds, ['live-preview-repair']);
      return true;
    },
  );
  assert.deepEqual(target.getSummary(), before, 'rejected confirmation must not mutate live state');

  prepared.confirm({
    confirmed: true,
    acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds,
  });
  assert.equal(target.getSummary().objectCount, 1);
  assert.equal(target.getSummary().history.undoCount, 1);
  assert.equal(target.undo(), true);
  assert.deepEqual(target.getSummary().projectId, before.projectId);
  assert.equal(target.getSummary().objectCount, 0);

  geometry.dispose();
  source.dispose();
  target.dispose();
});

await test('blocks canonical save and slice before serialization when the live projection is unhealthy', async () => {
  const workspace = createController();
  const geometry = new THREE.BoxGeometry(5, 6, 7);
  workspace.importBufferGeometry(geometry, { name: 'Projection guard source' });

  workspace.surface.dispose();
  workspace.addPlate('Projection failure trigger', { activate: false });
  assert.equal(workspace.getSummary().projectionHealth.healthy, false);
  await assert.rejects(workspace.saveCanonical3mf(), (error: unknown) => {
    assert.ok(error instanceof UnhealthyProjectProjectionError);
    assert.equal(error.operation, 'save');
    return true;
  });

  let routeCalls = 0;
  const slicer = new CanonicalWorkspaceSlicer({
    workspace,
    client: {
      async sliceProjectWithRoute() {
        routeCalls += 1;
        return '; this route must not be reached\n';
      },
    },
    route: { kind: 'browser-wasm' },
  });
  assert.throws(
    () => slicer.startCurrentPlate(),
    (error: unknown) => {
      assert.ok(error instanceof UnhealthyProjectProjectionError);
      assert.equal(error.operation, 'slice');
      return true;
    },
  );
  assert.equal(routeCalls, 0);

  slicer.dispose();
  geometry.dispose();
  workspace.dispose();
});

console.log(`\n${passed} canonical live-boundary tests passed.`);
