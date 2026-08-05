import assert from 'node:assert/strict';

import type { ProjectImportPreview } from '../../project/import/types';
import { projectImportNoticeRows } from '../ProjectImportPreviewDialog';

const preview: ProjectImportPreview = {
  source: { filename: 'fixture.3mf', importedAt: '2026-07-23T00:00:00.000Z' },
  mode: 'replace',
  baseRevision: 4,
  baseHash: 'base-hash',
  projectName: 'Fixture',
  counts: { plates: 2, objects: 3, assets: 4, importedAssets: 4, deduplicatedAssets: 0 },
  blocked: true,
  requiredAcknowledgementIds: ['repair:1', 'conflict:1', 'drop:1'],
  repairs: [
    {
      id: 'repair:1',
      kind: 'unit-conversion',
      path: 'plates[0].objects[0]',
      message: 'Converted inches to millimetres',
    },
  ],
  conflicts: [
    {
      id: 'conflict:1',
      kind: 'preset',
      path: 'printer.profileId',
      message: 'Kept the imported preset snapshot',
      resolution: 'keep imported',
    },
    {
      id: 'conflict:blocked',
      kind: 'entity-id',
      path: 'plates[0]',
      message: 'No safe ID resolution exists',
    },
  ],
  droppedFields: [
    {
      id: 'drop:1',
      path: 'Metadata/vendor.config',
      field: 'private_flag',
      message: 'Dropped an unsupported vendor field',
    },
  ],
  diagnostics: [
    {
      id: 'diagnostic:1',
      severity: 'error',
      code: 'invalid-transform',
      path: 'plates[1].objects[0].instances[0]',
      message: 'The transform is not invertible',
    },
  ],
};

const rows = projectImportNoticeRows(preview);
assert.deepEqual(
  rows.map((row) => row.id),
  ['repair:1', 'conflict:1', 'conflict:blocked', 'drop:1', 'diagnostic:1'],
);
assert.deepEqual(
  rows.filter((row) => row.required).map((row) => row.id),
  preview.requiredAcknowledgementIds,
);
assert.deepEqual(
  rows.filter((row) => row.blocking).map((row) => row.id),
  ['conflict:blocked', 'diagnostic:1'],
);
assert.match(rows.find((row) => row.id === 'conflict:1')?.detail ?? '', /keep imported/);

console.log('  ✓ import preview exposes every notice and exact acknowledgement/blocking state');
console.log('\nProject import preview dialog: 1 test passed.');
