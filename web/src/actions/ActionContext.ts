/**
 * ActionContext — the single surface every Action handler talks to.
 *
 * It is a thin, intent-level facade over the already-existing pieces
 * (`OrcaWorkspace`, its `FilamentPalette`, the `SlicerClient`) plus the
 * reactive `UiState`. Handlers call verbs like `slice()` / `repairSelected()`
 * / `boolean('UNION')`; the context routes each to the existing workspace
 * method or feature module. **No feature logic lives here** — this is routing,
 * so the DOM shell and the XR shell invoke identical behaviour.
 */
import type { OrcaWorkspace } from '../workspace/OrcaWorkspace';
import type { FilamentPalette } from '../workspace/FilamentPalette';
import type { UiState, WorkspaceMode } from './UiState';
import { ABOUT_HTML, SHORTCUTS_HTML, TUTORIAL_HTML, tipOfTheDayHtml } from './helpContent';

export type BooleanOp = 'UNION' | 'A_NOT_B' | 'INTERSECTION';
export type ToolName = 'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint';

export class ActionContext {
  constructor(
    readonly workspace: OrcaWorkspace,
    readonly ui: UiState,
  ) {}

  get palette(): FilamentPalette {
    return this.workspace.palette;
  }

  // ---- Scene ----------------------------------------------------------
  /** Open the file picker (wired to the DOM `<input type=file>` by the shell). */
  loadModel(): void {
    this.workspace.onRequestLoadStl?.();
  }
  importZip(): void {
    this.workspace.onRequestLoadZip?.();
  }
  addFromLibrary(): void {
    this.workspace.addFromLibrary();
  }
  deleteSelected(): void {
    this.workspace.deleteSelectedModel();
  }
  deleteAll(): void {
    this.workspace.deleteAllModels();
  }
  setCameraView(view: string): void {
    this.workspace.setCameraView(view);
  }
  autoOrient(): void {
    this.workspace.autoOrientSelectedModel();
  }
  deselectAll(): void {
    this.workspace.unselectModel();
    this.ui.update({ hasSelection: false });
  }
  repairSelected(): Promise<void> {
    return this.workspace.fixSelectedModel();
  }
  boolean(op: BooleanOp): Promise<void> {
    return this.workspace.booleanModels(op);
  }
  addPrimitive(kind: 'cube' | 'cylinder' | 'sphere'): void {
    this.workspace.addPrimitive(kind);
  }
  simplifySelected(): void {
    this.workspace.simplifySelected();
  }
  addCalibration(
    kind:
      | 'tower'
      | 'cube'
      | 'flow_pass1'
      | 'flow_pass2'
      | 'flow_yolo'
      | 'pressure_advance'
      | 'retraction'
      | 'max_flow'
      | 'vfa'
      | 'tolerance',
  ): void {
    this.workspace.addCalibration(kind);
  }
  addPlate(): void {
    this.workspace.addPlate();
  }
  deletePlate(): void {
    this.workspace.deletePlate();
  }
  newProject(): void {
    this.workspace.newProject();
    // Model/plate/selection counts are refreshed by the workspace's
    // onPlatesChanged / onSelectionChanged callbacks; clear the slice output.
    this.ui.update({ gcodeReady: false });
  }
  cloneSelected(): void {
    this.workspace.cloneSelectedModel();
  }
  copySelected(): void {
    this.workspace.copySelectedModel();
    this.ui.update({ hasClipboard: this.workspace.hasClipboard });
  }
  cutSelected(): void {
    this.workspace.cutSelectedModel();
    this.ui.update({ hasClipboard: this.workspace.hasClipboard });
  }
  paste(): void {
    this.workspace.pasteClipboard();
  }
  exportStl(): void {
    this.workspace.exportPlateStl();
  }
  export3mf(): void {
    this.workspace.exportPlate3mf();
  }
  saveProject(): void {
    this.workspace.saveProject();
  }
  openProject(): void {
    this.workspace.onRequestLoadProject?.();
  }
  exportConfig(): void {
    this.workspace.exportActiveConfig();
  }
  importConfig(): void {
    this.workspace.onRequestLoadConfig?.();
  }
  toggleWireframe(): void {
    this.workspace.toggleWireframe();
  }
  toggleLabels(): void {
    this.workspace.toggleLabels();
  }
  toggleOverhang(): void {
    this.workspace.toggleOverhang();
  }
  togglePrintableBox(): void {
    this.workspace.togglePrintableBox();
  }
  arrangePlate(): void {
    this.workspace.arrangePlate();
  }
  duplicatePlate(): void {
    this.workspace.duplicateCurrentPlate();
  }
  splitToObjects(): void {
    this.workspace.splitSelectedToObjects();
  }
  cutPlane(): void {
    this.workspace.cutSelectedByPlane();
  }

  // ---- Tools / modes --------------------------------------------------
  setTool(tool: ToolName): void {
    this.workspace.setTool(tool);
    this.ui.update({ activeTool: tool });
  }
  nudge(dir: -1 | 1): void {
    this.workspace.nudgeSelected(dir);
  }
  setMode(mode: WorkspaceMode): void {
    this.ui.update({ mode });
    // Prepare maps onto the existing modal-tool machinery; Preview is a
    // true mode switch in the renderer.
    if (mode === 'prepare') this.workspace.setTool('move');
  }

  // ---- Slice / preview / output --------------------------------------
  slice(): Promise<void> {
    return this.workspace.sliceNow();
  }
  togglePreview(): void {
    this.workspace.togglePreview();
  }
  downloadGcode(): void {
    const gcode = this.workspace.getLastGcode();
    if (gcode && this.workspace.onDownloadGcode) this.workspace.onDownloadGcode(gcode);
  }
  getLastGcode(): string | null {
    return this.workspace.getLastGcode();
  }

  // ---- Profile --------------------------------------------------------
  getProfileOptions() {
    return this.workspace.getProfileOptions();
  }
  setProfileByNames(machine: string, process: string, filament: string): void {
    this.workspace.setProfileByNames(machine, process, filament);
  }

  // ---- Filament / paint ----------------------------------------------
  addFilament(): void {
    this.workspace.addFilamentSlot();
  }

  // ---- Advanced Features ----------------------------------------------
  autoPlaceWipeTower(): void {
    this.workspace.setWipeTowerAuto(!this.workspace.wipeTowerAuto);
    this.workspace.setStatus('Auto-place Wipe Tower toggled: ' + this.workspace.wipeTowerAuto);
  }
  smartPaint(): void {
    void this.workspace.smartPaint();
  }

  smartPaintImage(): void {
    void this.workspace.smartPaintImage();
  }

  recreateModelColorsWithFullSpectrum(): ReturnType<OrcaWorkspace['recreateModelColorsWithFullSpectrum']> {
    return this.workspace.recreateModelColorsWithFullSpectrum();
  }

  /** Report a registry-controlled disabled reason without invoking a feature handler. */
  reportCapabilityUnavailable(label: string, reason: string): void {
    this.workspace.setStatus(`${label}: ${reason}`);
  }

  /** Check the PWA service worker for a newer OrcaXR build (Help → Check for Update). */
  async checkForUpdates(): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      this.workspace.setStatus('Update check is unavailable in this browser.');
      return;
    }
    this.workspace.setStatus('Checking for updates…');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        this.workspace.setStatus('OrcaXR is running the latest version (no update channel).');
        return;
      }
      await reg.update();
      this.workspace.setStatus(
        reg.waiting ? 'A new OrcaXR version is ready — reload to update.' : 'OrcaXR is up to date.',
      );
    } catch (e) {
      this.workspace.setStatus(`Update check failed: ${(e as Error).message}`);
    }
  }

  // ---- Help modals (informational) -----------------------------------
  showAbout(): void {
    this.workspace.showModal('About OrcaXR', ABOUT_HTML);
  }
  showShortcuts(): void {
    this.workspace.showModal('Keyboard Shortcuts', SHORTCUTS_HTML);
  }
  showTutorial(): void {
    this.workspace.showModal('Getting Started', TUTORIAL_HTML);
  }
  showTip(): void {
    this.workspace.showModal('Tip of the Day', tipOfTheDayHtml());
  }
  /** Interactive printer / filament setup wizard (built by the DOM shell). */
  setupWizard(): void {
    if (this.workspace.onShowSetupWizard) this.workspace.onShowSetupWizard();
    else this.workspace.setStatus('Setup wizard is unavailable in this shell.');
  }

  /** Open an external URL in a new tab (Help → report bug / docs). */
  openUrl(url: string): void {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    else this.workspace.setStatus(`Open ${url}`);
  }
}
