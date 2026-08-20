import { t } from '../../l10n/t';
export interface ProfileSelectionStatusFeedback {
  readonly applied: boolean;
  readonly severity: 'info' | 'warning' | 'error';
  readonly messages: readonly string[];
}

export interface ProfileSelectionStatusInput {
  readonly feedback?: ProfileSelectionStatusFeedback;
  readonly unavailableReasons?: readonly string[];
}

/**
 * Render profile reconciliation feedback without retaining a second copy of
 * selection state. The owning workspace remains the sole selection source.
 */
export function renderProfileSelectionStatus(target: HTMLElement, input: ProfileSelectionStatusInput): void {
  const unavailableReasons = [...new Set(input.unavailableReasons ?? [])];
  const feedbackMessages = [...new Set(input.feedback?.messages ?? [])];
  target.setAttribute('aria-live', 'polite');

  if (input.feedback && feedbackMessages.length > 0) {
    const failed = !input.feedback.applied || input.feedback.severity === 'error';
    target.dataset.profileSelectionState = failed
      ? 'unavailable'
      : input.feedback.severity === 'warning'
        ? 'substituted'
        : 'compatible';
    target.setAttribute('role', failed ? 'alert' : 'status');
    target.textContent = feedbackMessages.join(' ');
    target.title = feedbackMessages.join('\n');
    applyStatusStyle(target, input.feedback.severity);
    return;
  }

  target.setAttribute('role', 'status');
  if (unavailableReasons.length > 0) {
    target.dataset.profileSelectionState = 'catalog-limited';
    target.textContent =
      `${unavailableReasons.length} preset combination${unavailableReasons.length === 1 ? ' is' : 's are'} ` +
      `unavailable. ${unavailableReasons[0]}`;
    target.title = unavailableReasons.join('\n');
    applyStatusStyle(target, 'warning');
    return;
  }

  target.dataset.profileSelectionState = 'compatible';
  target.textContent = t(
    'ui.profileSelectionStatus.onlyCompatibleProcessAndFilament',
    'Only compatible process and filament presets are shown.',
  );
  target.title = target.textContent;
  applyStatusStyle(target, 'info');
}

function applyStatusStyle(target: HTMLElement, severity: ProfileSelectionStatusFeedback['severity']): void {
  const colors = {
    info: 'var(--oxr-color-text-muted,#a0aab5)',
    warning: '#ffcc80',
    error: '#ffb4ab',
  } as const;
  target.style.cssText =
    `margin:0;padding:7px 8px;border-radius:7px;font-size:11.5px;line-height:1.4;color:${colors[severity]};` +
    'background:rgba(255,255,255,0.04);';
}
