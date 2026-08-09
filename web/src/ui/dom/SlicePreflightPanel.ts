import type { ObjectTreeEntityRef } from '../../project/objects';
import type { CanonicalSlicePreflightResult, SlicePreflightAction, SlicePreflightIssue } from '../../project/slicing';

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

const COLORS = {
  error: { background: '#3a1e1e', border: '#f4433699', foreground: '#ff8a80' },
  warning: { background: '#3a331e', border: '#ffb74d99', foreground: '#ffcc80' },
} as const;

/** Accessible structured rendering for immutable canonical preflight evidence. */
export class SlicePreflightPanel {
  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: SlicePreflightPanelAdapter,
  ) {}

  render(result: CanonicalSlicePreflightResult): void {
    this.container.replaceChildren();
    if (result.issues.length === 0) return;

    const list = this.container.ownerDocument.createElement('ol');
    list.setAttribute('aria-label', 'Slice preflight issues');
    list.dataset.slicePreflightIssues = '';
    list.style.cssText = 'display:grid;gap:8px;list-style:none;margin:0;padding:0;';
    for (const [index, issue] of result.issues.entries()) {
      list.appendChild(this.renderIssue(issue, index));
    }
    this.container.appendChild(list);
  }

  dispose(): void {
    this.container.replaceChildren();
  }

  private renderIssue(issue: SlicePreflightIssue, index: number): HTMLLIElement {
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

    const heading = document.createElement('h3');
    heading.id = headingId;
    heading.style.cssText = 'font:inherit;font-weight:700;margin:0 0 4px;';
    const severity = document.createElement('span');
    severity.dataset.preflightSeverity = issue.severity;
    severity.textContent = issue.severity === 'error' ? 'Error' : 'Warning';
    const code = document.createElement('code');
    code.dataset.preflightStableCode = issue.code;
    code.style.cssText = 'margin-left:6px;color:inherit;';
    code.textContent = issue.detailCode ? `${issue.code} / ${issue.detailCode}` : issue.code;
    heading.append(severity, ' ', code);

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
      entities.setAttribute('aria-label', 'Affected canonical entities');
      entities.dataset.preflightEntities = '';
      entities.style.cssText = 'margin:5px 0 0;padding-left:18px;';
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
      controls.setAttribute('aria-label', 'Supported preflight actions');
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

    article.append(heading, description);
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
