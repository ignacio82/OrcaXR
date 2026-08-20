/**
 * The glanceable printer status, over the build plate (parity P9.7).
 *
 * The printer inspector is where someone goes to *manage* a machine. This is
 * for the rest of the time: it sits over the viewport on every tab and at every
 * width, appears only when there is something to know, and disappears again
 * when there is not — because obscuring preparation is exactly what a status
 * surface must not do.
 *
 * The controls are the same commands the desktop panel offers and take the same
 * confirmations, but they are reached differently: pause and resume are one
 * tap, while cancel and emergency stop must be *held*. A hold is the one
 * confirmation gesture a thumb, a mouse, and a controller ray all perform
 * identically, and unlike a modal it cannot be dismissed into by accident on a
 * phone. Releasing early runs nothing and says so.
 */

import type { PrintJobCommand } from '../../printer/PrintJobControl';
import type { GuardedPrinterAction, PrinterStatusSummary } from '../../printer/PrinterStatusSummary';
import { HoldToConfirm } from '../../printer/PrinterStatusSummary';
import { t } from '../../l10n/t';

export interface PrinterStatusBarPort {
  getSummary(): PrinterStatusSummary;
  getActions(): readonly GuardedPrinterAction[];
  subscribe(listener: () => void): () => void;
  run(command: PrintJobCommand): void | Promise<void>;
  /** Re-open the session the summary says was lost. */
  reconnect(): void | Promise<void>;
  /** Open the full printer panel for anything this surface deliberately omits. */
  openDetails(): void;
  /** Injected so the hold animation is drivable and disposable in a test. */
  now?(): number;
  scheduleFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
}

const TONE_COLOR: Readonly<Record<PrinterStatusSummary['tone'], string>> = Object.freeze({
  idle: '#8a94a0',
  active: '#4db6ac',
  attention: '#ffb74d',
  danger: '#ff8a80',
  unknown: '#8a94a0',
});

export class PrinterStatusBar {
  private root?: HTMLElement;
  private headline?: HTMLElement;
  private detail?: HTMLElement;
  private dot?: HTMLElement;
  private bar?: HTMLElement;
  private recovery?: HTMLElement;
  private controls?: HTMLElement;
  private holdNote?: HTMLElement;
  private unsubscribe?: () => void;
  private frame?: number;
  private disposed = false;
  private readonly hold: HoldToConfirm;
  private readonly holdBars = new Map<PrintJobCommand, HTMLElement>();

  constructor(
    private readonly container: HTMLElement,
    private readonly port: PrinterStatusBarPort,
  ) {
    this.hold = new HoldToConfirm({ now: () => (port.now ? port.now() : Date.now()) });
  }

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.printerStatusBar = 'true';
    root.setAttribute('aria-label', t('ui.printerStatusBar.printerStatus', 'Printer status'));
    root.hidden = true;
    root.style.cssText =
      'position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:5;box-sizing:border-box;' +
      'width:min(460px,calc(100% - 24px));display:flex;flex-direction:column;gap:6px;padding:10px 12px;' +
      'border-radius:12px;border:1px solid var(--oxr-stroke-strong,#ffffff26);' +
      'background:linear-gradient(145deg,rgba(20,28,38,.94),rgba(8,12,17,.9));backdrop-filter:blur(18px);' +
      'box-shadow:0 8px 26px rgba(0,0,0,.36);pointer-events:auto;';

    const line = doc.createElement('div');
    line.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const dot = doc.createElement('span');
    dot.dataset.printerStatusTone = 'unknown';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#8a94a0;';
    const text = doc.createElement('div');
    text.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;';
    const headline = doc.createElement('p');
    headline.dataset.printerStatusHeadline = 'true';
    headline.setAttribute('role', 'status');
    headline.setAttribute('aria-live', 'polite');
    headline.style.cssText =
      'margin:0;font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const detail = doc.createElement('p');
    detail.dataset.printerStatusDetail = 'true';
    detail.style.cssText = 'margin:0;font-size:11px;color:#a0aab5;overflow-wrap:anywhere;';
    text.append(headline, detail);
    const details = doc.createElement('button');
    details.type = 'button';
    details.className = 'action-btn';
    details.dataset.printerStatusDetails = 'true';
    details.textContent = 'Details';
    details.style.cssText = 'margin:0;flex:0 0 auto;padding:4px 8px;font-size:11px;';
    details.addEventListener('click', () => this.port.openDetails());
    line.append(dot, text, details);
    root.appendChild(line);

    const track = doc.createElement('div');
    track.dataset.printerStatusProgressTrack = 'true';
    track.style.cssText = 'height:4px;border-radius:2px;background:#ffffff1f;overflow:hidden;display:none;';
    const bar = doc.createElement('div');
    bar.dataset.printerStatusProgress = 'true';
    bar.style.cssText = 'height:100%;width:0%;background:var(--oxr-color-accent,#4fc3f7);';
    track.appendChild(bar);
    root.appendChild(track);

    const recovery = doc.createElement('div');
    recovery.dataset.printerStatusRecovery = 'true';
    recovery.style.cssText = 'display:none;align-items:center;gap:8px;font-size:11px;color:#ffb74d;';
    root.appendChild(recovery);

    const controls = doc.createElement('div');
    controls.dataset.printerStatusControls = 'true';
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    root.appendChild(controls);

    const holdNote = doc.createElement('p');
    holdNote.dataset.printerStatusHoldNote = 'true';
    holdNote.setAttribute('aria-live', 'polite');
    holdNote.style.cssText = 'margin:0;font-size:11px;color:#a0aab5;min-height:1em;';
    root.appendChild(holdNote);

    this.root = root;
    this.headline = headline;
    this.detail = detail;
    this.dot = dot;
    this.bar = bar;
    this.recovery = recovery;
    this.controls = controls;
    this.holdNote = holdNote;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const summary = this.port.getSummary();
    this.root.hidden = !summary.present;
    this.root.dataset.printerStatusPresent = summary.present ? 'true' : 'false';
    this.root.dataset.printerStatusStale = summary.stale ? 'true' : 'false';
    if (!summary.present) {
      // Nothing to watch: stop drawing, and drop any hold in progress so it
      // cannot complete against a surface the operator can no longer see. The
      // text below is still refreshed, so a hidden bar never holds a stale
      // reading that would flash on the way back in.
      this.stopFrame();
      this.hold.cancel();
    }

    if (this.dot) {
      this.dot.dataset.printerStatusTone = summary.tone;
      this.dot.style.background = TONE_COLOR[summary.tone];
    }
    if (this.headline) this.headline.textContent = summary.headline;
    if (this.detail) this.detail.textContent = summary.detail;
    if (this.bar?.parentElement) {
      const track = this.bar.parentElement;
      track.style.display = summary.progress === undefined ? 'none' : 'block';
      this.bar.style.width = `${Math.round((summary.progress ?? 0) * 100)}%`;
      this.bar.style.opacity = summary.stale ? '0.45' : '1';
    }
    this.renderRecovery(summary);
    this.renderControls();
  }

  private renderRecovery(summary: PrinterStatusSummary): void {
    const host = this.recovery;
    if (!host) return;
    host.textContent = '';
    if (!summary.recovery) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'flex';
    const doc = host.ownerDocument;
    const message = doc.createElement('span');
    message.dataset.printerStatusRecoveryMessage = 'true';
    message.style.cssText = 'flex:1;';
    message.textContent =
      summary.recovery.retryInS === undefined
        ? summary.recovery.message
        : `${summary.recovery.message} Next try in ${summary.recovery.retryInS} s.`;
    const action = doc.createElement('button');
    action.type = 'button';
    action.className = 'action-btn';
    action.dataset.printerStatusReconnect = 'true';
    action.textContent = summary.recovery.actionLabel;
    action.style.cssText = 'margin:0;flex:0 0 auto;padding:4px 8px;font-size:11px;';
    // "Connecting…" describes something already happening; there is nothing to
    // press, and a button that does nothing is worse than no button.
    action.disabled = summary.recovery.actionLabel.endsWith('…');
    action.addEventListener('click', () => void this.port.reconnect());
    host.append(message, action);
  }

  private renderControls(): void {
    const host = this.controls;
    if (!host) return;
    host.textContent = '';
    this.holdBars.clear();
    const doc = host.ownerDocument;
    for (const action of this.port.getActions()) {
      if (action.command === 'firmware-restart') continue;
      host.appendChild(this.buildControl(doc, action));
    }
  }

  private buildControl(doc: Document, action: GuardedPrinterAction): HTMLElement {
    const wrap = doc.createElement('div');
    wrap.style.cssText = 'position:relative;flex:1 1 0;min-width:76px;overflow:hidden;border-radius:8px;';

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'action-btn';
    button.dataset.printerStatusCommand = action.command;
    button.dataset.printerStatusHoldMs = String(action.holdMs);
    button.textContent = action.holdMs > 0 ? `Hold to ${action.label.toLowerCase()}` : action.label;
    button.disabled = !action.enabled;
    button.style.cssText = 'margin:0;width:100%;padding:6px 8px;font-size:11px;position:relative;z-index:1;';
    if (action.reason) button.title = action.reason;
    if (action.destructive) button.style.color = '#ff8a80';

    const fill = doc.createElement('span');
    fill.dataset.printerStatusHoldFill = action.command;
    fill.setAttribute('aria-hidden', 'true');
    fill.style.cssText =
      'position:absolute;inset-inline-start:0;top:0;bottom:0;width:0%;background:#ff525233;' +
      'pointer-events:none;z-index:0;';
    this.holdBars.set(action.command, fill);

    if (action.holdMs > 0) {
      // A held control has to say what completing it does *before* it completes,
      // so the confirmation is in the label, the title, and the live note.
      button.setAttribute('aria-description', action.confirmation ?? action.label);
    }

    const begin = (event: Event) => {
      if (!action.enabled) return;
      event.preventDefault();
      this.hold.press(action);
      if (action.holdMs > 0) {
        this.setHoldNote(action.confirmation ?? `Keep holding to ${action.label.toLowerCase()}.`);
        this.startFrame();
      }
    };
    const end = () => {
      const released = this.hold.release();
      this.stopFrame();
      this.paintHold(undefined, 0);
      if (released.command) {
        this.setHoldNote('');
        void this.port.run(released.command);
      } else if (action.holdMs > 0) {
        this.setHoldNote(`${action.label} needs a longer hold — nothing was sent.`);
      }
    };
    const abandon = () => {
      if (this.hold.poll().phase !== 'holding') return;
      this.hold.cancel();
      this.stopFrame();
      this.paintHold(undefined, 0);
      this.setHoldNote(action.holdMs > 0 ? `${action.label} cancelled — nothing was sent.` : '');
    };

    button.addEventListener('pointerdown', begin);
    button.addEventListener('pointerup', end);
    button.addEventListener('pointerleave', abandon);
    button.addEventListener('pointercancel', abandon);
    // Keyboard reaches the same command through the same guard: Space/Enter on a
    // held control is a keydown-repeat, so the clock still decides.
    button.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      if (this.hold.poll().phase === 'holding') return;
      begin(event);
    });
    button.addEventListener('keyup', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      end();
    });
    button.addEventListener('blur', abandon);

    wrap.append(fill, button);
    return wrap;
  }

  private setHoldNote(text: string): void {
    if (this.holdNote) this.holdNote.textContent = text;
  }

  private paintHold(command: PrintJobCommand | undefined, progress: number): void {
    for (const [key, fill] of this.holdBars) {
      fill.style.width = key === command ? `${Math.round(progress * 100)}%` : '0%';
    }
  }

  private startFrame(): void {
    if (this.frame !== undefined) return;
    const schedule = this.port.scheduleFrame ?? ((callback: () => void) => globalThis.requestAnimationFrame(callback));
    const step = () => {
      this.frame = undefined;
      const state = this.hold.poll();
      if (state.phase !== 'holding') {
        this.paintHold(undefined, 0);
        return;
      }
      this.paintHold(state.command, state.progress);
      this.frame = schedule(step);
    };
    this.frame = schedule(step);
  }

  private stopFrame(): void {
    if (this.frame === undefined) return;
    const cancel = this.port.cancelFrame ?? ((handle: number) => globalThis.cancelAnimationFrame(handle));
    cancel(this.frame);
    this.frame = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrame();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }
}
