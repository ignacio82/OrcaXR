/**
 * "Your project is held aside" (P8.3).
 *
 * A calibration takes the editor over, and the operator's own project is
 * waiting behind it. That fact has to be visible wherever they happen to be
 * looking — not filed in an inspector they would have to think to open —
 * because the failure it prevents is someone deciding this *is* their project
 * now, and building on top of a temperature tower.
 *
 * So this is a viewport banner rather than a panel, it names both ways out, and
 * it disappears entirely when no session is open. A persistent chrome slot that
 * usually says nothing trains people to stop reading it.
 */

export interface CalibrationSessionBarState {
  readonly open: boolean;
  /** What the held project was called, so it is a thing rather than a promise. */
  readonly heldProjectName?: string;
  /** True once the calibration has been sliced and there is G-code to move. */
  readonly sliced?: boolean;
  /** Absent when no printer is configured; a reason when sending is withheld. */
  readonly sendUnavailableReason?: string;
}

export interface CalibrationSessionBarAdapter {
  getState(): CalibrationSessionBarState;
  subscribe?(listener: () => void): () => void;
  onDiscard(): void | Promise<void>;
  onKeep(): void | Promise<void>;
  /** Slice the calibration that currently owns the editor. */
  onSlice(): void | Promise<void>;
  /** Write the sliced calibration out as a file. */
  onExport(): void | Promise<void>;
  /** Send the sliced calibration to the connected printer. */
  onSend(): void | Promise<void>;
  onError?(error: unknown): void;
}

export class CalibrationSessionBar {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: CalibrationSessionBarAdapter,
  ) {}

  mount(): void {
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh()) ?? null;
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container.replaceChildren();
    this.container.hidden = true;
  }

  refresh(): void {
    const state = this.adapter.getState();
    if (!state.open) {
      this.container.replaceChildren();
      this.container.hidden = true;
      return;
    }
    const doc = this.container.ownerDocument;
    this.container.hidden = false;
    this.container.dataset.calibrationSession = 'open';
    this.container.style.cssText =
      'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 12px;' +
      'border:1px solid var(--oxr-color-border,#30363d);border-radius:8px;' +
      'background:var(--oxr-color-surface,#0d1117);';

    const message = doc.createElement('p');
    message.dataset.calibrationSessionMessage = 'true';
    // A status, not an alert: nothing is wrong, and nothing is at risk while
    // the banner is up. Crying wolf here would cost the alerts that matter.
    message.setAttribute('role', 'status');
    message.style.cssText = 'margin:0;flex:1 1 240px;';
    // Names what will be sliced and sent, because that is the question the
    // buttons beside it raise: with a session open they act on the calibration.
    const held = state.heldProjectName
      ? `“${state.heldProjectName}” is held aside and comes back exactly as it was.`
      : 'Your project is held aside and comes back exactly as it was.';
    message.textContent = `Calibrating — slicing and sending act on the calibration. ${held}`;

    const controls = doc.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    // Slice, export and send are offered *here* rather than left to the main
    // toolbar because while a session is open those actions act on the
    // calibration, not on the operator's project. Reaching them from the banner
    // that says so is what keeps "send" from being ambiguous about what is
    // about to be printed.
    const slice = this.button('calibration-slice', 'Slice calibration', () => this.adapter.onSlice());
    const exportGcode = this.button('calibration-export', 'Save G-code', () => this.adapter.onExport());
    exportGcode.disabled = state.sliced !== true;
    const send = this.button('calibration-send', 'Send to printer', () => this.adapter.onSend());
    send.disabled = state.sliced !== true || state.sendUnavailableReason !== undefined;
    if (state.sendUnavailableReason) {
      send.title = state.sendUnavailableReason;
      send.dataset.calibrationSendUnavailable = 'true';
    }
    controls.append(
      slice,
      exportGcode,
      send,
      this.button('calibration-discard', 'Discard, restore my project', () => this.adapter.onDiscard()),
      this.button('calibration-keep', 'Keep the calibration', () => this.adapter.onKeep()),
    );

    this.container.replaceChildren(message, controls);
  }

  private button(id: string, label: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = this.container.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.calibrationSessionAction = id;
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
