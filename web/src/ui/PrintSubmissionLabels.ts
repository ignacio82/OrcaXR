import { t } from '../l10n/t';
import type { PrintWorkflowConfirmation } from '../printer/PrintWorkflowController';

/** Both surfaces show the exact target and the metadata the operator is confirming. */
export function printOverwriteLabel(target: PrintWorkflowConfirmation['overwrite']): string {
  if (!target.allowed)
    return target.reason ?? t('ui.printSubmission.overwriteUnavailable', 'Replacing this file is unavailable.');
  if (!target.existing)
    return t('ui.printSubmission.exactNewName', 'Use exact name {filename} (new file)', { filename: target.filename });
  const date = new Date(target.existing.modified * 1000);
  return t(
    'ui.printSubmission.exactReplacement',
    'Use exact name {filename}, replacing {bytes} bytes modified {modified}',
    {
      filename: target.filename,
      bytes: target.existing.size,
      modified: Number.isFinite(date.getTime()) ? date.toISOString() : String(target.existing.modified),
    },
  );
}
