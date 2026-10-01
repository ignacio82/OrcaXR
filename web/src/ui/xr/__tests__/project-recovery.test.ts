import assert from 'node:assert/strict';
import { renderXrProjectImportDialog } from '../XrProjectImportDialog';
import { renderXrProjectWorkspace } from '../XrProjectWorkspace';
import type { ImportCommitConfirmation, ProjectImportPreview } from '../../../project/import/types';
import { createFakeXrUi, FakePanel } from './fakeXrUi';

const preview: ProjectImportPreview = {
  source: { filename: 'recovery.3mf' },
  mode: 'replace',
  baseRevision: 1,
  baseHash: 'base',
  projectName: 'Recovered part',
  counts: { plates: 1, objects: 1, assets: 1, importedAssets: 1, deduplicatedAssets: 0 },
  blocked: false,
  requiredAcknowledgementIds: ['drop:1'],
  repairs: [],
  conflicts: [],
  droppedFields: [
    { id: 'drop:1', path: 'vendor.data', field: 'unsupported', message: 'An unsupported field will be dropped.' },
  ],
  diagnostics: [],
};
const choices: (ImportCommitConfirmation | null)[] = [];
for (const blocked of [false, true]) {
  const root = new FakePanel({});
  renderXrProjectImportDialog(createFakeXrUi(), root, { ...preview, blocked }, (value) => choices.push(value));
  assert.ok(root.labels().includes('An unsupported field will be dropped.'));
  assert.ok(root.panels().some((panel) => panel.props.overflow === 'scroll'));
  const before = choices.length;
  root.findButton('Replace project')!.click();
  assert.equal(choices.length, before + (blocked ? 0 : 1));
  if (!blocked) assert.deepEqual(choices.at(-1), { confirmed: true, acknowledgedNoticeIds: ['drop:1'] });
  root.findButton('Cancel')!.click();
  assert.equal(choices.at(-1), null);
}
const root = new FakePanel({});
const operations: string[] = [];
renderXrProjectWorkspace(createFakeXrUi(), root, {
  projectName: 'Current',
  modelCount: 0,
  plateCount: 1,
  isDirty: false,
  recentProjects: [],
  recoveryStatus: 'Unavailable format',
  recoverySessions: [
    {
      id: 'future',
      projectName: 'Future project',
      savedAt: '2026-10-01T00:00:00Z',
      byteLength: 10,
      available: false,
      reason: 'Unsupported schema',
    },
  ],
  onRecoveryOperation: (operation, id) => operations.push(`${operation}:${id}`),
});
root.findButton('Recover')!.click();
root.findButton('Download recovery file')!.click();
root.findButton('Discard recovery')!.click();
assert.deepEqual(operations, ['download:future', 'discard:future']);
assert.ok(root.labels().some((label) => label.includes('Unsupported schema')));
console.log(
  'XR recovery preserves notices, blocks invalid imports, and exposes explicit future archive download/discard.',
);
