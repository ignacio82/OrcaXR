import assert from 'node:assert/strict';

import { entityId } from '../../project/domain/ids';
import type {
  CanonicalSplitToObjectsConfirmation,
  CanonicalSplitToObjectsResult,
} from '../CanonicalWorkspaceController';
import { runCanonicalSplitToObjectsFlow } from '../CanonicalSplitToObjectsFlow';

const confirmation: CanonicalSplitToObjectsConfirmation = {
  guard: {
    expectedRevision: 4,
    sourceHash: 'source-hash',
    selectionFingerprint: 'selection-hash',
    plateId: entityId<'plate'>('import:split-flow:plate'),
    objectId: entityId<'object'>('import:split-flow:object'),
    primaryInstanceId: entityId<'instance'>('import:split-flow:instance'),
  },
  objectName: 'Assembly',
  strategy: 'existing-volumes',
  volumeCount: 2,
  triangleCount: 24,
  affectedInstanceIds: [entityId<'instance'>('import:split-flow:instance')],
};

const result: CanonicalSplitToObjectsResult = {
  sourceObjectId: confirmation.guard.objectId,
  strategy: confirmation.strategy,
  objectIds: [entityId<'object'>('import:split-flow:first'), entityId<'object'>('import:split-flow:second')],
  instanceIds: [
    entityId<'instance'>('import:split-flow:first-instance'),
    entityId<'instance'>('import:split-flow:second-instance'),
  ],
  volumeIds: [
    entityId<'volume'>('import:split-flow:first-volume'),
    entityId<'volume'>('import:split-flow:second-volume'),
  ],
  assetIds: [],
};

let passed = 0;

async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('requires explicit review and commits the exact captured guard once', async () => {
  const statuses: string[] = [];
  const guards: unknown[] = [];
  let reviewed: CanonicalSplitToObjectsConfirmation | undefined;
  const output = await runCanonicalSplitToObjectsFlow(
    {
      getSplitToObjectsConfirmation: () => confirmation,
      splitSelectedToObjects: (guard) => {
        guards.push(guard);
        return result;
      },
    },
    async (scope) => {
      reviewed = scope;
      return true;
    },
    (message) => statuses.push(message),
  );

  assert.strictEqual(reviewed, confirmation);
  assert.deepEqual(guards, [confirmation.guard]);
  assert.strictEqual(output, result);
  assert.match(statuses[0], /Split Assembly into 2 objects.*one undoable edit/);
});

await test('cancellation, missing confirmation, and commit errors never report success', async () => {
  for (const variant of ['cancel', 'missing', 'failure'] as const) {
    const statuses: string[] = [];
    let commits = 0;
    const output = await runCanonicalSplitToObjectsFlow(
      {
        getSplitToObjectsConfirmation: () => confirmation,
        splitSelectedToObjects: () => {
          commits += 1;
          if (variant === 'failure') throw new Error('stale fixture');
          return result;
        },
      },
      variant === 'missing' ? null : async () => variant !== 'cancel',
      (message) => statuses.push(message),
    );
    assert.equal(output, undefined);
    assert.equal(commits, variant === 'failure' ? 1 : 0);
    assert.match(statuses.at(-1) ?? '', /not changed|cancelled|failed/i);
  }
});

console.log(`\n${passed} canonical split-to-objects flow tests passed.`);
