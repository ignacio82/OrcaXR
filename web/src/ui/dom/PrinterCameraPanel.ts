/**
 * The live view of the machine (P9.6).
 *
 * Every frame here is a separate authenticated request, which makes the polling
 * policy part of the feature rather than an implementation detail. The panel
 * stops fetching whenever nobody can see it: a hidden tab, a collapsed section,
 * a disposed panel. A camera left running in a background tab is somebody's
 * bandwidth and somebody's battery, and on a Raspberry Pi it is also the
 * printer's CPU.
 *
 * A camera that cannot be shown is listed with its reason rather than omitted,
 * because "my chamber camera is missing" is a worse bug report than "OrcaXR
 * says it shows snapshots and this one only streams".
 */

import type { PrinterCamera } from '../../printer/PrinterCamera';
import {
  cameraCanShowFrames,
  cameraPollIntervalMs,
  cameraTransform,
  describeCameraService,
} from '../../printer/PrinterCamera';
import { t } from '../../l10n/t';

export interface PrinterCameraPanelPort {
  getCameras(): readonly PrinterCamera[];
  getSelected(): PrinterCamera | undefined;
  /** Object URL of the most recent frame, when one has been fetched. */
  getFrameUrl(): string | undefined;
  getStatus(): {
    readonly busy: boolean;
    readonly message?: string;
    /**
     * The last frame fetch that failed, if the last one did. Kept apart from
     * `message` because the panel shows it *in place of* the picture: a panel
     * that says "waiting for the first frame" while every request is failing is
     * telling the operator to keep waiting for something that will never come.
     */
    readonly failure?: string;
  };
  subscribe(listener: () => void): () => void;
  select(uid: string): void;
  /** Discover the printer's cameras. */
  refresh(): void | Promise<void>;
  /** Fetch exactly one frame; the panel owns the timer. */
  captureFrame(): void | Promise<void>;
}

export interface PrinterCameraPanelHost {
  /** True while the panel is on screen; polling stops when it is not. */
  isVisible(): boolean;
  /** Notify on any visibility change, so polling follows it. */
  subscribeVisibility(listener: () => void): () => void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

export class PrinterCameraPanel {
  private root?: HTMLElement;
  private select?: HTMLSelectElement;
  private image?: HTMLImageElement;
  private placeholder?: HTMLElement;
  private caption?: HTMLElement;
  private liveToggle?: HTMLButtonElement;
  private status?: HTMLElement;
  private timer?: number;
  private live = true;
  private unsubscribe?: () => void;
  private unsubscribeVisibility?: () => void;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly port: PrinterCameraPanelPort,
    private readonly host: PrinterCameraPanelHost,
  ) {}

  mount(): void {
    if (this.root) return;
    const doc = this.container.ownerDocument;
    const root = doc.createElement('section');
    root.dataset.printerCameraPanel = 'true';
    root.setAttribute('aria-label', t('ui.printerCameraPanel.printerCamera', 'Printer camera'));
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const controls = doc.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const select = doc.createElement('select');
    select.className = 'action-btn';
    select.dataset.printerCameraSelect = 'true';
    select.setAttribute('aria-label', 'Camera');
    select.style.cssText = 'flex:1;min-width:0;text-align: start;';
    select.addEventListener('change', () => this.port.select(select.value));
    controls.appendChild(select);

    const live = doc.createElement('button');
    live.type = 'button';
    live.className = 'action-btn';
    live.dataset.printerCameraLive = 'true';
    live.style.cssText = 'margin:0;';
    live.addEventListener('click', () => {
      this.live = !this.live;
      this.applyPolling();
      this.render();
    });
    controls.appendChild(live);

    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'action-btn';
    refresh.dataset.printerCameraRefresh = 'true';
    refresh.textContent = t('ui.printerCameraPanel.findCameras', 'Find cameras');
    refresh.style.cssText = 'margin:0;';
    refresh.addEventListener('click', () => void this.port.refresh());
    controls.appendChild(refresh);
    root.appendChild(controls);

    const frame = doc.createElement('div');
    frame.style.cssText =
      'position:relative;width:100%;aspect-ratio:4/3;background:#0008;border-radius:8px;overflow:hidden;' +
      'display:flex;align-items:center;justify-content:center;';
    const image = doc.createElement('img');
    image.dataset.printerCameraFrame = 'true';
    image.alt = t('ui.printerCameraPanel.liveViewFromThePrinter', 'Live view from the printer camera');
    image.hidden = true;
    image.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    frame.appendChild(image);
    const placeholder = doc.createElement('p');
    placeholder.dataset.printerCameraPlaceholder = 'true';
    placeholder.style.cssText = 'margin:0;padding:12px;font-size:12px;opacity:0.75;text-align:center;';
    frame.appendChild(placeholder);
    root.appendChild(frame);

    const caption = doc.createElement('p');
    caption.dataset.printerCameraCaption = 'true';
    caption.style.cssText = 'margin:0;font-size:11px;opacity:0.7;';
    root.appendChild(caption);

    const status = doc.createElement('p');
    status.dataset.printerCameraStatus = 'true';
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:0;font-size:12px;opacity:0.8;min-height:1em;';
    root.appendChild(status);

    this.root = root;
    this.select = select;
    this.image = image;
    this.placeholder = placeholder;
    this.caption = caption;
    this.liveToggle = live;
    this.status = status;
    this.container.appendChild(root);
    this.unsubscribe = this.port.subscribe(() => {
      this.applyPolling();
      this.render();
    });
    // Render after, not only before: stopping the timer is itself a visible
    // change — the toggle's state and the "paused while hidden" caption both
    // come from whether the timer is running.
    this.unsubscribeVisibility = this.host.subscribeVisibility(() => {
      this.applyPolling();
      this.render();
    });
    this.render();
    this.applyPolling();
  }

  /**
   * Start or stop the frame timer.
   *
   * Called on every state change rather than only on toggle, because the reason
   * to stop can arrive from anywhere: the tab hid, the section collapsed, the
   * selected camera turned out to be stream-only.
   */
  private applyPolling(): void {
    const camera = this.port.getSelected();
    const shouldPoll =
      !this.disposed && this.live && this.host.isVisible() && camera !== undefined && cameraCanShowFrames(camera);
    if (!shouldPoll) {
      if (this.timer !== undefined) {
        this.host.clearInterval(this.timer);
        this.timer = undefined;
      }
      return;
    }
    if (this.timer !== undefined) return;
    void this.port.captureFrame();
    this.timer = this.host.setInterval(() => void this.port.captureFrame(), cameraPollIntervalMs(camera));
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const cameras = this.port.getCameras();
    const selected = this.port.getSelected();
    const state = this.port.getStatus();

    if (this.select) {
      const wanted = cameras.map((camera) => `${camera.uid}:${camera.name}`).join('|');
      if (this.select.dataset.printerCameraOptions !== wanted) {
        this.select.dataset.printerCameraOptions = wanted;
        this.select.textContent = '';
        const doc = this.select.ownerDocument;
        for (const camera of cameras) {
          const option = doc.createElement('option');
          option.value = camera.uid;
          option.textContent = camera.unsupportedReason
            ? `${camera.name} (snapshots unavailable)`
            : camera.enabled
              ? camera.name
              : `${camera.name} (disabled)`;
          this.select.appendChild(option);
        }
      }
      if (selected) this.select.value = selected.uid;
      this.select.disabled = cameras.length === 0;
    }

    if (this.liveToggle) {
      const polling = this.timer !== undefined;
      this.liveToggle.textContent = this.live ? 'Pause' : 'Resume';
      this.liveToggle.dataset.printerCameraPolling = String(polling);
      this.liveToggle.disabled = !selected || !cameraCanShowFrames(selected);
    }

    const frameUrl = this.port.getFrameUrl();
    if (this.image && this.placeholder) {
      if (frameUrl && selected && cameraCanShowFrames(selected)) {
        this.image.src = frameUrl;
        this.image.hidden = false;
        this.image.style.transform = cameraTransform(selected);
        this.placeholder.hidden = true;
      } else {
        this.image.hidden = true;
        this.placeholder.hidden = false;
        this.placeholder.textContent = !selected
          ? cameras.length === 0
            ? 'No cameras found on this printer yet.'
            : 'Select a camera.'
          : // Whatever actually went wrong outranks the optimistic caption: the
            // camera cannot be shown, the fetch failed, or nothing has come back
            // yet — in that order, because only the last one is worth waiting on.
            (selected.unsupportedReason ?? state.failure ?? 'Waiting for the first frame…');
      }
    }

    if (this.caption) {
      this.caption.textContent = selected
        ? `${selected.name} — ${describeCameraService(selected)}${
            this.host.isVisible() ? '' : ' — paused while hidden'
          }`
        : '';
    }
    if (this.status) this.status.textContent = state.message ?? '';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.host.clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribeVisibility?.();
    this.unsubscribe = undefined;
    this.unsubscribeVisibility = undefined;
    this.root?.remove();
    this.root = undefined;
  }
}
