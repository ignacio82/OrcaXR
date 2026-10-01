import { t } from '../l10n/t';

export type UnsavedProjectDecision = 'save' | 'discard' | 'cancel';
export function unsavedProjectLabels(projectName: string) {
  return {
    title: t('persistence.unsavedTitle', 'Unsaved project'),
    detail: t('persistence.unsavedDetail', 'Save changes to {name} before continuing?', { name: projectName }),
    handoff: t('persistence.downloadHandoff', 'A browser download confirms handoff, not completion of a disk write.'),
    choices: [
      { id: 'save', label: t('persistence.saveAndContinue', 'Save and continue') },
      { id: 'discard', label: t('persistence.discardAndContinue', 'Discard and continue') },
      { id: 'cancel', label: t('persistence.cancel', 'Cancel') },
    ] as const,
  };
}
