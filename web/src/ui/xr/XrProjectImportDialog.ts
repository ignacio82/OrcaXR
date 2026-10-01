import { t } from '../../l10n/t';
import { projectImportNoticeRows } from '../../import/ProjectImportPreview';
import type { ImportCommitConfirmation, ProjectImportPreview } from '../../project/import/types';
import type { XrUiAdapter } from './XrUiAdapter';
import { createXrButton, createXrSectionHeading } from './XrComponents';

/** The same validated import notices and explicit decision remain in the headset. */
export function renderXrProjectImportDialog<P, I, T>(
  ui: XrUiAdapter<P, I, T>,
  root: P,
  preview: ProjectImportPreview,
  choose: (decision: ImportCommitConfirmation | null) => void,
): void {
  const panel = ui.createPanel({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 16,
    gap: 12,
    overflow: 'scroll',
  });
  ui.appendChild(root, panel);
  ui.appendChild(panel, createXrSectionHeading(ui, t('persistence.reviewRecovery', 'Review project recovery')));
  ui.appendChild(panel, ui.createText(preview.projectName, { fontSize: 18 }));
  for (const notice of projectImportNoticeRows(preview)) {
    ui.appendChild(panel, ui.createText(notice.message, { fontSize: 14 }));
    ui.appendChild(panel, ui.createText(notice.detail, { fontSize: 12 }));
  }
  ui.appendChild(
    panel,
    createXrButton(ui, {
      label: t('import.projectImportPreviewDialog.replaceProject', 'Replace project'),
      enabled: !preview.blocked,
      onClick: () => choose({ confirmed: true, acknowledgedNoticeIds: [...preview.requiredAcknowledgementIds] }),
    }).root,
  );
  ui.appendChild(
    panel,
    createXrButton(ui, { label: t('persistence.cancel', 'Cancel'), onClick: () => choose(null) }).root,
  );
}
