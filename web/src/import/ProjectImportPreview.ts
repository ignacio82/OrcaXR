import type { ProjectImportPreview } from '../project/import/types';

interface PreviewNoticeRow {
  readonly id: string;
  readonly category: 'Repair' | 'Conflict' | 'Dropped field' | 'Diagnostic';
  readonly message: string;
  readonly detail: string;
  readonly required: boolean;
  readonly blocking: boolean;
}

export function projectImportNoticeRows(preview: ProjectImportPreview): readonly PreviewNoticeRow[] {
  const required = new Set(preview.requiredAcknowledgementIds);
  return [
    ...preview.repairs.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Repair',
      message: notice.message,
      detail: `${notice.kind} · ${notice.path}`,
      required: required.has(notice.id),
      blocking: false,
    })),
    ...preview.conflicts.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Conflict',
      message: notice.message,
      detail: [notice.kind, notice.path, notice.resolution ? `resolution: ${notice.resolution}` : 'unresolved']
        .filter(Boolean)
        .join(' · '),
      required: required.has(notice.id),
      blocking: !notice.resolution,
    })),
    ...preview.droppedFields.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Dropped field',
      message: notice.message,
      detail: `${notice.path} · ${notice.field}`,
      required: required.has(notice.id),
      blocking: false,
    })),
    ...preview.diagnostics.map((notice): PreviewNoticeRow => ({
      id: notice.id,
      category: 'Diagnostic',
      message: notice.message,
      detail: `${notice.severity} · ${notice.code} · ${notice.path}`,
      required: false,
      blocking: notice.severity === 'error',
    })),
  ];
}
