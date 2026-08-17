/**
 * The calibration parameter dialog and its preview (P8.3).
 *
 * Renders whatever `project/calibration/form.ts` reports and sends edits back
 * as text. It holds no rules of its own — not a range, not a choice list, not a
 * unit — because the pinned definition and the compiler own those, and a panel
 * that re-states a limit is a panel that will eventually disagree with the
 * thing enforcing it.
 *
 * Two decisions worth naming. Issues are shown against the fields that caused
 * them, resolved by the compiler's own `$.parameters.<key>` path, so an
 * operator is told which box is wrong rather than that something is. And the
 * preview line reports what the plan contains — bands, envelope — rather than
 * "valid", because "valid" is a claim about the form and the operator is asking
 * about the print.
 */

import type { CalibrationFormField, CalibrationFormPreview } from '../../project/calibration/form';
import { calibrationInstructions, describeBandLocation } from '../../project/calibration/instructions';
import type { CalibrationJobPlan } from '../../project/calibration/types';

export interface CalibrationParametersPanelState {
  readonly workflowLabel: string;
  readonly preview: CalibrationFormPreview;
  /** Contextual link to the pinned documentation for this calibration. */
  readonly docHref: string;
  /** Human summary of the compiled plan; absent when nothing compiled. */
  readonly planSummary?: string;
  /**
   * Why building is unavailable even when the form compiles. Present while
   * canonical materialisation of a compiled plan is still P8.2 work: the
   * control stays visible and says why, rather than disappearing or —
   * far worse — appearing to work and producing something else.
   */
  readonly generateUnavailableReason?: string;
}

export interface CalibrationParametersPanelAdapter {
  getState(): CalibrationParametersPanelState;
  subscribe?(listener: () => void): () => void;
  /** One field changed; the caller re-builds the form and the preview. */
  onEdit(key: string, text: string): void | Promise<void>;
  /** Put the definition's own defaults back. */
  onReset(): void | Promise<void>;
  /** Build the previewed plan into the project. */
  onGenerate(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSequence = 0;

export class CalibrationParametersPanel {
  private readonly instanceId = (panelSequence += 1);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: CalibrationParametersPanelAdapter,
  ) {}

  mount(): void {
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh()) ?? null;
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container.replaceChildren();
  }

  refresh(): void {
    const state = this.adapter.getState();
    const doc = this.container.ownerDocument;
    const issuesByKey = new Map<string, string[]>();
    const general: string[] = [];
    for (const issue of state.preview.issues) {
      const match = /^\$\.parameters\.(.+)$/.exec(issue.path);
      if (match) {
        const list = issuesByKey.get(match[1]) ?? [];
        list.push(issue.message);
        issuesByKey.set(match[1], list);
      } else general.push(issue.message);
    }

    const heading = doc.createElement('h3');
    heading.textContent = state.workflowLabel;
    heading.style.cssText = 'margin:0;font-size:0.95rem;';

    const help = doc.createElement('a');
    help.dataset.calibrationDoc = 'true';
    help.href = state.docHref;
    help.target = '_blank';
    // Opening a new tab hands the opener over unless this is said; the target
    // is a documentation host, but the project's own rule is that untrusted
    // navigation never gets a handle back.
    help.rel = 'noopener noreferrer';
    help.textContent = 'How this calibration works';
    help.style.cssText = 'font-size:0.85rem;';

    const fields = doc.createElement('div');
    fields.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    for (const field of state.preview.fields) {
      fields.appendChild(this.field(field, issuesByKey.get(field.key) ?? []));
    }

    const controls = doc.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const generate = this.button('calibration-generate', 'Add to project', () => this.adapter.onGenerate());
    // Nothing is built while the form does not compile: an operator pressing
    // this with a bad value must not get a plan made from a substituted one.
    generate.disabled = state.preview.plan === null || state.generateUnavailableReason !== undefined;
    if (state.generateUnavailableReason) {
      generate.title = state.generateUnavailableReason;
      generate.dataset.calibrationUnavailable = 'true';
    }
    const reset = this.button('calibration-reset', 'Reset to defaults', () => this.adapter.onReset());
    reset.disabled = !state.preview.fields.some((field) => field.changed);
    controls.append(generate, reset);

    const summary = doc.createElement('p');
    summary.dataset.calibrationPreview = 'true';
    summary.setAttribute('role', 'status');
    summary.style.cssText = 'margin:0;opacity:0.75;';
    // The plan summary is reported even when building is withheld: knowing what
    // the settings would produce is the whole value of a preview, and it does
    // not depend on being able to act on it yet.
    summary.textContent = state.preview.plan
      ? [state.planSummary ?? 'Ready to add.', state.generateUnavailableReason].filter(Boolean).join(' ')
      : general.length > 0
        ? general.join(' ')
        : 'Fix the fields marked below to see what this will build.';

    const children: HTMLElement[] = [heading, help, fields, summary, controls];
    if (state.preview.plan) children.push(this.instructions(state.preview.plan));
    this.container.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    this.container.replaceChildren(...children);
  }

  /**
   * What to look at once it is printed.
   *
   * Collapsed, because it is for after the print rather than before it, and an
   * expanded list of three hundred bands would bury the controls above it. Open
   * it and every band is there — a truncated key would be worse than none,
   * since the band an operator wants is exactly the one they cannot see.
   */
  private instructions(plan: CalibrationJobPlan): HTMLElement {
    const doc = this.container.ownerDocument;
    const sheet = calibrationInstructions(plan);
    const details = doc.createElement('details');
    details.dataset.calibrationInstructions = 'true';
    const summary = doc.createElement('summary');
    summary.textContent = `How to read this print (${sheet.bands.length} to compare)`;
    summary.style.cssText = 'cursor:pointer;';
    details.appendChild(summary);

    const list = doc.createElement('ol');
    list.style.cssText = 'margin:6px 0;padding-left:20px;display:flex;flex-direction:column;gap:2px;';
    for (const band of sheet.bands) {
      const item = doc.createElement('li');
      item.dataset.calibrationBand = `${band.ordinal}`;
      const unit = band.unit ? ` ${band.unit}` : '';
      item.textContent = `${band.label} — ${band.value}${unit}, ${describeBandLocation(band, sheet.layout)}`;
      list.appendChild(item);
    }
    details.appendChild(list);

    const measure = doc.createElement('p');
    measure.dataset.calibrationMeasurements = 'true';
    measure.style.cssText = 'margin:0;opacity:0.75;';
    measure.textContent =
      `Measure: ${sheet.measurements.map((field) => field.label).join(', ')}. ` +
      `A recorded result writes to ${sheet.writesTo.join(', ')}.`;
    details.appendChild(measure);
    return details;
  }

  private field(field: CalibrationFormField, issues: readonly string[]): HTMLElement {
    const doc = this.container.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.dataset.calibrationField = field.key;
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const inputId = `orcaxr-calib-${field.key}-${this.instanceId}`;
    const label = doc.createElement('label');
    label.htmlFor = inputId;
    label.textContent = field.unit ? `${field.label} (${field.unit})` : field.label;
    label.style.cssText = 'opacity:0.75;';

    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === 'choice' && field.choices.length > 0) {
      const select = doc.createElement('select');
      for (const choice of field.choices) {
        const option = doc.createElement('option');
        option.value = choice;
        option.textContent = choice;
        option.selected = choice === field.text;
        select.appendChild(option);
      }
      input = select;
    } else if (field.kind === 'boolean') {
      const select = doc.createElement('select');
      for (const choice of ['true', 'false']) {
        const option = doc.createElement('option');
        option.value = choice;
        option.textContent = choice;
        option.selected = choice === field.text;
        select.appendChild(option);
      }
      input = select;
    } else {
      const text = doc.createElement('input');
      // A number-list is typed as text: it is a comma-separated list, and a
      // number input would refuse the commas that make it one.
      text.type = field.kind === 'number' ? 'number' : 'text';
      if (field.kind === 'number' && field.range) {
        text.min = `${field.range.min}`;
        text.max = `${field.range.max}`;
        if (field.range.step) text.step = `${field.range.step}`;
      }
      text.value = field.text;
      input = text;
    }
    input.id = inputId;
    input.dataset.calibrationInput = field.key;
    input.disabled = !field.editable;
    input.style.cssText =
      'padding:6px;border-radius:6px;border:1px solid var(--oxr-color-border,#30363d);' +
      'background:var(--oxr-color-surface,#0d1117);color:inherit;font:inherit;';
    if (issues.length > 0) {
      input.setAttribute('aria-invalid', 'true');
      input.style.cssText += 'border-color:var(--oxr-color-danger,#ff4d4d);';
    }
    input.addEventListener('change', () => {
      void this.run(() => this.adapter.onEdit(field.key, (input as HTMLInputElement).value));
    });

    wrapper.append(label, input);
    if (issues.length > 0) {
      const message = doc.createElement('p');
      message.dataset.calibrationFieldIssue = field.key;
      message.setAttribute('role', 'alert');
      message.style.cssText = 'margin:0;color:var(--oxr-color-danger,#ff4d4d);font-size:0.85rem;';
      message.textContent = issues.join(' ');
      const describedBy = `${inputId}-issue`;
      message.id = describedBy;
      input.setAttribute('aria-describedby', describedBy);
      wrapper.appendChild(message);
    }
    return wrapper;
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.calibrationAction = id;
    button.textContent = label;
    button.style.cssText =
      'min-height:36px;padding:6px 10px;border-radius:6px;border:1px solid currentColor;' +
      'background:transparent;color:inherit;cursor:pointer;';
    button.addEventListener('click', () => void this.run(run));
    return button;
  }

  private async run(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.adapter.onError?.(error);
    } finally {
      this.refresh();
    }
  }
}
