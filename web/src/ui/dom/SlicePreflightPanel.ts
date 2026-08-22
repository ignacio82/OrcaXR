import { troubleshootingFor } from '../../help/HelpCatalog';
import type { ObjectTreeEntityRef } from '../../project/objects';
import type { CanonicalSlicePreflightResult, SlicePreflightAction, SlicePreflightIssue } from '../../project/slicing';
import { t } from '../../l10n/t';

export type SupportedSlicePreflightAction =
  | (SlicePreflightAction & {
      readonly id: 'reveal';
      readonly entity: ObjectTreeEntityRef;
    })
  | (SlicePreflightAction & {
      readonly id: 'drop-to-bed';
      readonly entity: Extract<ObjectTreeEntityRef, { kind: 'instance' }>;
    });

export interface SlicePreflightActionRequest {
  readonly issue: SlicePreflightIssue;
  readonly action: SupportedSlicePreflightAction;
}

export interface SlicePreflightPanelAdapter {
  readonly runAction: (request: SlicePreflightActionRequest) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/**
 * The two banner tones. The card's own text is body text — the severity is
 * carried by the fill and the border, not by tinting a paragraph until it is
 * hard to read.
 */
const COLORS = {
  error: {
    background: 'var(--oxr-danger-surface)',
    border: 'var(--oxr-danger)',
    foreground: 'var(--oxr-text)',
  },
  warning: {
    background: 'var(--oxr-warn-surface)',
    border: 'var(--oxr-warn)',
    foreground: 'var(--oxr-text)',
  },
} as const;

/** Accessible structured rendering for immutable canonical preflight evidence. */
export class SlicePreflightPanel {
  /**
   * Issues the operator has hidden, by `SlicePreflightIssue.id` — which is
   * stable across repeated evaluation of the same canonical fault, so a hidden
   * issue stays hidden through the recompute that follows every edit.
   *
   * Hiding changes nothing canonical: preflight still evaluates the fault and
   * slicing still refuses on a blocking one. It only stops a standing issue from
   * burying the panel underneath it — an overlap warning on two of thirteen
   * objects should not cost the operator the object list. A fault that clears
   * and later returns is a new occurrence and shows again, because ids that are
   * no longer present get pruned below.
   */
  private readonly hidden = new Set<string>();

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SlicePreflightPanelAdapter,
  ) {}

  render(result: CanonicalSlicePreflightResult): void {
    this.container.replaceChildren();
    if (result.issues.length === 0) {
      this.hidden.clear();
      return;
    }

    const present = new Set(result.issues.map((issue) => issue.id));
    for (const id of [...this.hidden]) if (!present.has(id)) this.hidden.delete(id);

    const visible = result.issues.filter((issue) => !this.hidden.has(issue.id));
    const document = this.container.ownerDocument;
    const list = document.createElement('ol');
    list.setAttribute('aria-label', t('ui.slicePreflightPanel.slicePreflightIssues', 'Slice preflight issues'));
    list.dataset.slicePreflightIssues = '';
    list.style.cssText = 'display:grid;gap:8px;list-style:none;margin:0;padding:0;';
    for (const [index, issue] of visible.entries()) {
      list.appendChild(this.renderIssue(issue, index, () => this.hide(issue.id, result)));
    }
    this.container.appendChild(list);

    const hiddenCount = result.issues.length - visible.length;
    if (hiddenCount > 0) this.container.appendChild(this.renderHiddenSummary(hiddenCount, result));
  }

  dispose(): void {
    this.container.replaceChildren();
  }

  private hide(id: string, result: CanonicalSlicePreflightResult): void {
    this.hidden.add(id);
    this.render(result);
  }

  /**
   * Hidden issues are never silently gone: what is left is a count and the one
   * control that brings them all back.
   */
  private renderHiddenSummary(count: number, result: CanonicalSlicePreflightResult): HTMLElement {
    const document = this.container.ownerDocument;
    const bar = document.createElement('div');
    bar.dataset.preflightHiddenSummary = String(count);
    bar.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;' +
      'padding:6px 10px;border:1px dashed var(--oxr-stroke-strong);border-radius:8px;color:var(--oxr-text-muted);font-size:12px;';
    const label = document.createElement('span');
    label.textContent = t(
      'ui.slicePreflightPanel.hiddenIssues',
      '{count, plural, one {# hidden issue} other {# hidden issues}}',
      { count },
    );
    const show = document.createElement('button');
    show.type = 'button';
    show.dataset.preflightShowHidden = '';
    show.textContent = t('ui.slicePreflightPanel.show', 'Show');
    show.style.cssText =
      'min-height:28px;padding:2px 10px;border:1px solid var(--oxr-stroke-strong);background:var(--oxr-surface);color:inherit;' +
      'border-radius:6px;cursor:pointer;font:inherit;';
    show.addEventListener('click', () => {
      this.hidden.clear();
      this.render(result);
    });
    bar.append(label, show);
    return bar;
  }

  private renderIssue(issue: SlicePreflightIssue, index: number, onHide: () => void): HTMLLIElement {
    const document = this.container.ownerDocument;
    const item = document.createElement('li');
    const article = document.createElement('article');
    const headingId = `slice-preflight-heading-${index}`;
    const descriptionId = `slice-preflight-description-${index}`;
    const colors = COLORS[issue.severity];

    article.dataset.preflightIssueId = issue.id;
    article.dataset.preflightCode = issue.code;
    article.dataset.severity = issue.severity;
    if (issue.detailCode) article.dataset.preflightDetailCode = issue.detailCode;
    article.setAttribute('role', issue.severity === 'error' ? 'alert' : 'status');
    article.setAttribute('aria-labelledby', headingId);
    article.setAttribute('aria-describedby', descriptionId);
    article.style.cssText =
      `background:${colors.background};border:1px solid ${colors.border};color:${colors.foreground};` +
      'border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.4;';

    // The heading row carries the dismiss control, so every issue can be put
    // away from the place the operator is already reading.
    const headingRow = document.createElement('div');
    headingRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;';
    const heading = document.createElement('h3');
    heading.id = headingId;
    heading.style.cssText = 'font:inherit;font-weight:700;margin:0 0 4px;flex:1;min-width:0;';
    const severity = document.createElement('span');
    severity.dataset.preflightSeverity = issue.severity;
    severity.textContent = issue.severity === 'error' ? 'Error' : 'Warning';
    const code = document.createElement('code');
    code.dataset.preflightStableCode = issue.code;
    code.style.cssText = 'margin-inline-start:6px;color:inherit;';
    code.textContent = issue.detailCode ? `${issue.code} / ${issue.detailCode}` : issue.code;
    heading.append(severity, ' ', code);

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.dataset.preflightHide = issue.id;
    hide.textContent = '\u00d7';
    hide.title = t('ui.slicePreflightPanel.hideThisIssue', 'Hide this issue');
    hide.setAttribute(
      'aria-label',
      `${t('ui.slicePreflightPanel.hideThisIssue', 'Hide this issue')}: ${issue.severity === 'error' ? 'Error' : 'Warning'} ${issue.code}`,
    );
    hide.style.cssText =
      'flex:0 0 auto;min-width:28px;min-height:28px;padding:0 6px;border:1px solid transparent;' +
      'background:transparent;color:inherit;border-radius:6px;cursor:pointer;font:inherit;' +
      'font-size:16px;line-height:1;opacity:.75;';
    hide.addEventListener('click', onHide);
    headingRow.append(heading, hide);

    const description = document.createElement('div');
    description.id = descriptionId;
    const message = document.createElement('p');
    message.dataset.preflightMessage = '';
    message.style.cssText = 'margin:0 0 4px;';
    message.textContent = issue.message;
    const help = document.createElement('p');
    help.dataset.preflightHelp = '';
    help.style.cssText = 'margin:0;color:inherit;opacity:.9;';
    help.textContent = issue.help;
    description.append(message, help);

    // Per-code troubleshooting, added rather than substituted: an issue may
    // carry help specific to the values that tripped it, which is stronger
    // than anything a catalog keyed only on the code could say. What the
    // catalog adds is the part the generic sentence never had — the fix.
    const troubleshooting = troubleshootingFor(issue.code);
    if (troubleshooting) {
      const fix = document.createElement('p');
      fix.dataset.preflightFix = '';
      fix.style.cssText = 'margin:4px 0 0;color:inherit;opacity:.9;';
      fix.textContent = troubleshooting.fix;
      description.append(fix);
    }

    if (issue.path) {
      const path = document.createElement('p');
      path.style.cssText = 'margin:4px 0 0;';
      path.append('Path: ');
      const pathCode = document.createElement('code');
      pathCode.dataset.preflightPath = '';
      pathCode.textContent = issue.path;
      path.appendChild(pathCode);
      description.appendChild(path);
    }

    if (issue.entities.length > 0) {
      const entities = document.createElement('ul');
      entities.setAttribute(
        'aria-label',
        t('ui.slicePreflightPanel.affectedCanonicalEntities', 'Affected canonical entities'),
      );
      entities.dataset.preflightEntities = '';
      entities.style.cssText = 'margin:5px 0 0;padding-inline-start:18px;';
      for (const entity of issue.entities) {
        const entityItem = document.createElement('li');
        entityItem.dataset.preflightEntityKind = entity.kind;
        if ('id' in entity) entityItem.dataset.preflightEntityId = entity.id;
        entityItem.textContent = 'id' in entity ? `${entity.kind}: ${entity.id}` : entity.kind;
        entities.appendChild(entityItem);
      }
      description.appendChild(entities);
    }

    const actions = issue.actions.flatMap((action) => {
      const supported = supportedAction(action);
      return supported ? [supported] : [];
    });
    if (actions.length > 0) {
      const controls = document.createElement('div');
      controls.setAttribute(
        'aria-label',
        t('ui.slicePreflightPanel.supportedPreflightActions', 'Supported preflight actions'),
      );
      controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.preflightAction = action.id;
        button.textContent = action.label;
        button.style.cssText =
          'min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid currentColor;' +
          'background:transparent;color:inherit;cursor:pointer;';
        button.addEventListener('click', () => {
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          void Promise.resolve()
            .then(() => this.adapter.runAction({ issue, action }))
            .catch((error: unknown) => this.adapter.onError?.(error))
            .finally(() => {
              if (!button.isConnected) return;
              button.disabled = false;
              button.removeAttribute('aria-busy');
            });
        });
        controls.appendChild(button);
      }
      description.appendChild(controls);
    }

    article.append(headingRow, description);
    item.appendChild(article);
    return item;
  }
}

function supportedAction(action: SlicePreflightAction): SupportedSlicePreflightAction | undefined {
  if (action.id === 'drop-to-bed' && action.entity?.kind === 'instance') {
    return action as SupportedSlicePreflightAction;
  }
  if (action.id === 'reveal' && action.entity && isObjectTreeEntity(action.entity)) {
    return action as SupportedSlicePreflightAction;
  }
  return undefined;
}

function isObjectTreeEntity(entity: NonNullable<SlicePreflightAction['entity']>): entity is ObjectTreeEntityRef {
  return (
    entity.kind === 'plate' ||
    entity.kind === 'object' ||
    entity.kind === 'volume' ||
    entity.kind === 'instance' ||
    entity.kind === 'layer-range'
  );
}
