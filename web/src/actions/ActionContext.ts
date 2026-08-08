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
import type { FilamentId, PlateId } from '../project/domain/ids';
import type { ConfigMap } from '../project/domain/model';
import type { ObjectTreeEntityRef } from '../project/objects';
import type { PaintChannel, PaintToolKind } from '../project/painting/PaintStrokeService';
import type { GcodePreviewViewPatch } from '../slicer/GcodePreviewSession';

/** Modal tool that authors each facet channel. */
const PAINT_TOOL_FOR_CHANNEL: Readonly<Record<PaintChannel, ToolName>> = Object.freeze({
  color: 'paint',
  support: 'support_paint',
  seam: 'seam_paint',
  fuzzySkin: 'fuzzy_skin',
});
import type {
  CanonicalFilamentAssignableEntityRef,
  CanonicalSemanticLayerRangeRequest,
  CanonicalSemanticVolumeRoleRequest,
  CanonicalVirtualFilamentMutationRequest,
} from '../workspace/CanonicalWorkspaceController';
import type { ActionRegistry, ActionSurface } from './ActionRegistry';
import type { UiState, WorkspaceMode } from './UiState';
import { ABOUT_HTML, TUTORIAL_HTML, shortcutsHtml, tipOfTheDayHtml } from './helpContent';

export type BooleanOp = 'UNION' | 'A_NOT_B' | 'INTERSECTION';
export type ToolName =
  'move' | 'rotate' | 'scale' | 'lay_on_face' | 'paint' | 'support_paint' | 'seam_paint' | 'fuzzy_skin';

export class ActionContext {
  constructor(
    readonly workspace: OrcaWorkspace,
    readonly ui: UiState,
    private readonly registry: ActionRegistry,
  ) {}

  get palette(): FilamentPalette {
    return this.workspace.palette;
  }

  undo(): void {
    this.workspace.undo();
  }

  redo(): void {
    this.workspace.redo();
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
  dropToBed(): void {
    this.workspace.dropSelectedToBed();
  }
  deselectAll(): void {
    this.workspace.unselectModel();
    this.ui.update({ hasSelection: false, hasInstanceSelection: false });
  }
  selectAll(): void {
    this.workspace.selectAllModels();
    this.ui.update({
      hasSelection: this.workspace.modelCount > 0,
      hasInstanceSelection: this.workspace.modelCount > 0,
    });
  }
  selectObjectsTreeEntities(refs: readonly ObjectTreeEntityRef[], primary?: ObjectTreeEntityRef): void {
    this.workspace.setObjectsTreeSelection(refs, primary);
  }
  renameObjectsTreeEntity(entity: Extract<ObjectTreeEntityRef, { kind: 'object' | 'volume' }>, name: string): void {
    this.workspace.renameObjectsTreeEntity(entity, name);
  }
  revealObjectsTreeEntity(entity: ObjectTreeEntityRef): void {
    this.workspace.revealObjectsTreeEntity(entity);
  }
  assignObjectsTreeFilament(
    entities: readonly CanonicalFilamentAssignableEntityRef[],
    filamentId: FilamentId | null,
    guard: Readonly<{ sourceRevision: number; sourceHash: string }>,
  ): void {
    this.workspace.setFilamentAssignments(entities, filamentId, guard);
  }
  convertSemanticVolumeRole(request: CanonicalSemanticVolumeRoleRequest): void {
    this.workspace.convertSemanticVolumeRole(request);
  }
  editSemanticLayerRange(request: CanonicalSemanticLayerRangeRequest): void {
    this.workspace.editSemanticLayerRange(request);
  }
  applyProjectSettings(
    inheritedConfig: Readonly<ConfigMap>,
    overrides: Readonly<ConfigMap>,
    guard: Readonly<{ sourceRevision: number; sourceHash: string }>,
  ): void {
    this.workspace.setProjectSettingsOverrides(inheritedConfig, overrides, guard);
  }
  mutateVirtualFilament(request: CanonicalVirtualFilamentMutationRequest): void {
    this.workspace.mutateVirtualFilament(request);
  }
  configureFullSpectrumAutoPairs(enabled: boolean, confirmedPhysicalCount?: number): void {
    this.workspace.configureFullSpectrumAutoPairs(
      enabled,
      confirmedPhysicalCount === undefined ? undefined : { confirmedPhysicalCount },
    );
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
  activatePlate(id: PlateId, expectedRevision?: number): void {
    this.workspace.setActivePlate(id, expectedRevision);
  }
  deletePlate(id?: PlateId, expectedRevision?: number): void {
    this.workspace.deletePlate(id, expectedRevision);
  }
  renamePlate(id: PlateId, name: string, expectedRevision: number): void {
    this.workspace.renamePlate(id, name, expectedRevision);
  }
  reorderPlates(ids: readonly PlateId[], expectedRevision: number): void {
    this.workspace.reorderPlates(ids, expectedRevision);
  }
  setPlatePrintable(id: PlateId, printable: boolean, expectedRevision: number): void {
    this.workspace.setPlatePrintable(id, printable, expectedRevision);
  }
  async newProject(): Promise<void> {
    const created = await this.workspace.newProject();
    // Model/plate/selection counts are refreshed by the workspace's
    // onPlatesChanged / onSelectionChanged callbacks; clear the slice output.
    if (created) this.ui.update({ gcodeReady: false });
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
  saveProject(): Promise<void> {
    return this.workspace.saveProject();
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
  duplicatePlate(id?: PlateId, expectedRevision?: number): void {
    this.workspace.duplicatePlate(id, expectedRevision);
  }
  async splitToObjects(): Promise<void> {
    await this.workspace.splitSelectedToObjects();
  }
  cutPlane(): void {
    this.workspace.cutSelectedByPlane();
  }

  // ---- Instances ------------------------------------------------------
  addInstance(): void {
    this.workspace.addInstanceToSelection();
  }

  fillBedWithInstances(): void {
    this.workspace.fillPlateWithSelection();
  }

  // ---- Transforms -----------------------------------------------------
  mirrorSelected(axis: 'x' | 'y' | 'z'): void {
    this.workspace.mirrorSelected(axis);
  }

  resetSelectedTransform(target: 'rotation' | 'scale' | 'both'): void {
    this.workspace.resetSelectedTransform(target);
  }

  centerOnPlate(): void {
    this.workspace.centerSelectedOnPlate();
  }

  // ---- Slicing --------------------------------------------------------
  sliceAllPlates(): void {
    void this.workspace.sliceAllPlates();
  }

  downloadAllPlateGcode(): void {
    this.workspace.downloadAllPlateGcode();
  }

  // ---- Preview --------------------------------------------------------
  /** Apply a bounded preview view change from any viewer surface. */
  updatePreviewView(patch: GcodePreviewViewPatch): void {
    this.workspace.updatePreviewView(patch);
  }

  /** Ask the shell for a standalone G-code file to inspect. */
  openGcodeFile(): void {
    this.workspace.onRequestOpenGcode?.();
  }

  // ---- Painting -------------------------------------------------------
  /** Apply a bounded paint configuration request from any surface. */
  configurePaint(request: {
    readonly channel?: PaintChannel;
    readonly channelState?: string | boolean;
    readonly filamentId?: FilamentId | null;
    readonly mode?: 'paint' | 'erase';
    readonly tool?: PaintToolKind;
    readonly radiusMm?: number;
    readonly smartFillAngleDegrees?: number;
    readonly heightRangeMm?: number;
    readonly gapAreaMm2?: number;
  }): void {
    if (request.channel) {
      // The active tool owns the channel while painting, so switching channels
      // switches tools instead of creating a second authority.
      const channelTool = PAINT_TOOL_FOR_CHANNEL[request.channel];
      const painting = Object.values(PAINT_TOOL_FOR_CHANNEL).includes(this.ui.get().activeTool as ToolName);
      if (painting) this.applyTool(channelTool);
      else this.workspace.setPaintChannel(request.channel);
    }
    if (request.channelState !== undefined) this.workspace.setPaintChannelState(request.channelState);
    if (request.filamentId !== undefined) {
      this.workspace.setPaintFilament(request.filamentId ?? undefined);
    }
    if (request.mode) this.workspace.setPaintMode(request.mode);
    if (request.tool) this.workspace.setPaintTool(request.tool);
    const settings: Record<string, number> = {};
    if (request.radiusMm !== undefined) settings.radiusMm = request.radiusMm;
    if (request.smartFillAngleDegrees !== undefined) settings.smartFillAngleDegrees = request.smartFillAngleDegrees;
    if (request.heightRangeMm !== undefined) settings.heightRangeMm = request.heightRangeMm;
    if (request.gapAreaMm2 !== undefined) settings.gapAreaMm2 = request.gapAreaMm2;
    if (Object.keys(settings).length > 0) this.workspace.setPaintSettings(settings);
  }

  eraseAllPaint(): void {
    this.workspace.eraseAllPaint();
  }

  /** Upstream `1`–`9`: select the palette row with that displayed number. */
  selectPaintFilamentSlot(slot: number): void {
    if (!this.workspace.setPaintFilamentByNumber(slot)) {
      this.reportCapabilityUnavailable(`Paint with filament ${slot}`, 'No palette row uses that number yet.');
    }
  }

  // ---- Tools / modes --------------------------------------------------
  /** Registry handler seam. Presentation callers must use setTool(). */
  applyTool(tool: ToolName): void {
    this.workspace.setTool(tool);
    this.ui.update({ activeTool: tool });
  }

  /**
   * Compatibility gateway for the legacy XR mode card. Its calls still pass
   * through the composition-root registry, including unavailable-tool guards.
   */
  setTool(tool: ToolName): void {
    const actionId = `tool_${tool}`;
    this.invokeFromXr(actionId, 'xr-toolbar');
  }
  nudge(dir: -1 | 1): void {
    this.workspace.nudgeSelected(dir);
  }
  setMode(mode: WorkspaceMode): void {
    const current = this.ui.get().mode;
    if (mode === current) return;
    // The legacy XR card follows a Preview request with togglePreview(), and
    // exits Preview before its final Prepare notification. Paint is the one
    // branch that asks for Prepare first, so close an active preview through
    // the guarded action here and let its subsequent tool request stand alone.
    if (mode === 'prepare' && current === 'preview') this.togglePreview();
  }

  // ---- Slice / preview / output --------------------------------------
  slice(): Promise<void> {
    return this.workspace.sliceNow();
  }
  /** Registry handler seam. Presentation callers must use togglePreview(). */
  applyTogglePreview(): void {
    this.workspace.togglePreview();
    const workspaceMode = this.workspace.getAutomationSnapshot().workspaceMode;
    this.ui.update({ mode: workspaceMode === 'Preview' ? 'preview' : 'prepare' });
  }
  /** Compatibility gateway for the legacy XR mode card. */
  togglePreview(): void {
    this.invokeFromXr('toggle_preview', 'xr-primary');
  }
  downloadGcode(): void {
    const gcode = this.workspace.getLastGcode();
    if (gcode && this.workspace.onDownloadGcode) this.workspace.onDownloadGcode(gcode);
  }
  getLastGcode(): string | null {
    return this.workspace.getLastGcode();
  }

  private invokeFromXr(actionId: string, surface: ActionSurface): void {
    void this.registry
      .invoke(actionId, surface, this, this.ui.get())
      .catch((error) => this.workspace.setStatus(`Action failed: ${(error as Error).message}`));
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

  testPrinterConnection(): Promise<void> {
    return this.workspace.testPrinterConnection();
  }

  inspectPrinterFilaments(): Promise<void> {
    return this.workspace.inspectPrinterFilaments();
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
    this.workspace.showModal('Keyboard Shortcuts', shortcutsHtml(this.registry.all()));
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
