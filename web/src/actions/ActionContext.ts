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
import type { PrimitiveKind } from '../project/objects/primitives';
import type { EmbossRecipePatch } from '../workspace/OrcaWorkspace';
import type { AssemblyAlignmentKind } from '../project/objects/assembly';
import type { SimplifyConfiguration } from '../project/objects/simplify';
import type { ActionInvocation, ActionResult, TransformEditRequest } from './ActionRegistry';
import type { OrcaWorkspace } from '../workspace/OrcaWorkspace';
import type { FilamentPalette } from '../workspace/FilamentPalette';
import type { FilamentId, InstanceId, PlateId } from '../project/domain/ids';
import type { ConfigMap } from '../project/domain/model';
import type { ObjectTreeEntityRef } from '../project/objects';
import type { PaintChannel, PaintToolKind } from '../project/painting/PaintStrokeService';
import type { ScopedOverrideTarget } from '../project/scopedOverrides';
import type { PrintJobCommand } from '../printer/PrintJobControl';
import type { PrintJobConfirmation } from '../printer/PrinterSessionController';
import type { PrinterConsoleOperation } from '../printer/PrinterConsole';
import type { DiscoveryOutcome } from '../printer/PrinterDirectory';
import type { PrinterStorageOperation } from '../printer/PrinterStorage';
import type { PresetLibraryOperation } from '../settings/presets/PresetLibrary';
import type { CalibrationHistoryOperation } from '../project/calibration/history';
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
  CanonicalLayerEventMutationRequest,
  CanonicalSemanticLayerRangeRequest,
  CanonicalSemanticVolumeRoleRequest,
  CanonicalVirtualFilamentMutationRequest,
} from '../workspace/CanonicalWorkspaceController';
import type { RecreateModelColorsOptions } from '../project/filaments/recreateModelColors';
import type { ActionRegistry, ActionSurface } from './ActionRegistry';
import type { UiState, WorkspaceMode } from './UiState';
import { ABOUT_HTML, TUTORIAL_HTML, shortcutsHtml, tipOfTheDayHtml } from './helpContent';
import { t } from '../l10n/t';

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

  async undo(): Promise<void> {
    await this.workspace.undo();
  }

  async redo(): Promise<void> {
    await this.workspace.redo();
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
  async deleteSelected(): Promise<void> {
    await this.workspace.deleteSelectedModel();
  }
  async deleteAll(): Promise<void> {
    await this.workspace.deleteAllModels();
  }
  setCameraView(view: string): void {
    this.workspace.setCameraView(view);
  }
  autoOrient(): void {
    this.workspace.autoOrientSelectedModel();
  }
  async dropToBed(): Promise<void> {
    await this.workspace.dropSelectedToBed();
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
  async renameObjectsTreeEntity(
    entity: Extract<ObjectTreeEntityRef, { kind: 'object' | 'volume' }>,
    name: string,
  ): Promise<void> {
    await this.workspace.renameObjectsTreeEntity(entity, name);
  }
  async revealObjectsTreeEntity(entity: ObjectTreeEntityRef): Promise<void> {
    await this.workspace.revealObjectsTreeEntity(entity);
  }
  assignObjectsTreeFilament(
    entities: readonly CanonicalFilamentAssignableEntityRef[],
    filamentId: FilamentId | null,
    guard: Readonly<{ sourceRevision: number; sourceHash: string }>,
  ): void {
    this.workspace.setFilamentAssignments(entities, filamentId, guard);
  }
  mutateLayerEvent(request: CanonicalLayerEventMutationRequest): void {
    this.workspace.mutateLayerEvent(request);
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
  applyScopedSettings(
    target: ScopedOverrideTarget,
    overrides: Readonly<ConfigMap>,
    guard: Readonly<{ sourceRevision: number; sourceHash: string }>,
  ): void {
    this.workspace.setScopedOverrides(target, overrides, guard);
  }
  autoPlaceBrimEars(): void {
    this.workspace.autoPlaceBrimEars();
  }
  toggleSelectionOutline(): void {
    this.workspace.toggleSelectionOutline();
  }
  toggleNavigator(): void {
    this.workspace.toggleNavigator();
  }
  togglePrinterStatusBar(): void {
    this.workspace.togglePrinterStatusBar();
  }
  operateCalibrationHistory(operation: CalibrationHistoryOperation): Promise<void> {
    return this.workspace.operateCalibrationHistory(operation);
  }
  operatePresetLibrary(operation: PresetLibraryOperation): Promise<void> {
    return this.workspace.operatePresetLibrary(operation);
  }
  operatePrinterStorage(operation: PrinterStorageOperation): Promise<void> {
    return this.workspace.operatePrinterStorage(operation);
  }
  operatePrinterConsole(operation: PrinterConsoleOperation): Promise<void> {
    return this.workspace.operatePrinterConsole(operation);
  }
  loadPrintHistory(start: number): Promise<void> {
    return this.workspace.loadPrintHistory(start);
  }
  viewPrinterCamera(uid?: string): Promise<void> {
    return this.workspace.viewPrinterCamera(uid);
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
  recreateModelColors(options?: RecreateModelColorsOptions): Promise<boolean> {
    return this.workspace.recreateModelColors(options);
  }
  repairSelected(): Promise<void> {
    return this.workspace.fixSelectedModel();
  }
  boolean(op: BooleanOp): Promise<void> {
    return this.workspace.booleanModels(op);
  }
  async togglePrintable(): Promise<void> {
    await this.workspace.toggleSelectedPrintable();
  }
  async scaleToFitPrintVolume(): Promise<void> {
    await this.workspace.scaleSelectionToFitPrintVolume();
  }
  addPrimitive(kind: PrimitiveKind): void {
    this.workspace.addPrimitive(kind);
  }
  setExplosionFactor(factor: number): boolean {
    return this.workspace.setExplosionFactor(factor);
  }

  getExplosionFactor(): number {
    return this.workspace.getExplosionFactor();
  }

  placeCalibrationGeometry(): Promise<{ placed: number } | { reason: string }> {
    return this.workspace.placeCalibrationGeometry();
  }

  buildCalibrationSweepProgram(): { gcode: string; filename: string } | { reason: string } {
    return this.workspace.buildCalibrationSweepProgram();
  }

  setCalibrationWorkflow(id: string): boolean {
    return this.workspace.setCalibrationWorkflow(id);
  }

  setCalibrationParameter(key: string, text: string): boolean {
    return this.workspace.setCalibrationParameter(key, text);
  }

  resetCalibrationParameters(): boolean {
    return this.workspace.resetCalibrationParameters();
  }

  discardCalibrationSession(): boolean {
    return this.workspace.discardCalibrationSession();
  }

  keepCalibrationSession(): boolean {
    return this.workspace.keepCalibrationSession();
  }

  previewSimplify(configuration: SimplifyConfiguration): boolean {
    return this.workspace.previewSimplify(configuration);
  }

  applySimplifyPreview(): boolean {
    return this.workspace.applySimplifyPreview();
  }

  cancelSimplifyPreview(): boolean {
    return this.workspace.cancelSimplifyPreview();
  }

  simplifySelected(decimateRatio?: number): void {
    this.workspace.simplifySelected(decimateRatio);
  }
  addCalibration(
    kind:
      | 'tower'
      | 'cube'
      | 'flow_pass1'
      | 'flow_pass2'
      | 'flow_yolo'
      | 'flow_yolo_perfectionist'
      | 'pressure_advance'
      | 'retraction'
      | 'max_flow'
      | 'vfa'
      | 'tolerance'
      | 'input_shaping_frequency'
      | 'input_shaping_damping'
      | 'junction_deviation',
  ): void {
    this.workspace.addCalibration(kind);
  }
  async addPlate(): Promise<void> {
    await this.workspace.addPlate();
  }
  async activatePlate(id: PlateId, expectedRevision?: number): Promise<void> {
    await this.workspace.setActivePlate(id, expectedRevision);
  }
  async deletePlate(id?: PlateId, expectedRevision?: number): Promise<void> {
    await this.workspace.deletePlate(id, expectedRevision);
  }
  async renamePlate(id: PlateId, name: string, expectedRevision: number): Promise<void> {
    await this.workspace.renamePlate(id, name, expectedRevision);
  }
  async reorderPlates(ids: readonly PlateId[], expectedRevision: number): Promise<void> {
    await this.workspace.reorderPlates(ids, expectedRevision);
  }
  async setPlatePrintable(id: PlateId, printable: boolean, expectedRevision: number): Promise<void> {
    await this.workspace.setPlatePrintable(id, printable, expectedRevision);
  }
  async newProject(): Promise<void> {
    const created = await this.workspace.newProject();
    // Model/plate/selection counts are refreshed by the workspace's
    // onPlatesChanged / onSelectionChanged callbacks; clear the slice output.
    if (created) this.ui.update({ gcodeReady: false });
  }
  async cloneSelected(): Promise<void> {
    await this.workspace.cloneSelectedModel();
  }
  copySelected(): void {
    this.workspace.copySelectedModel();
    this.ui.update({ hasClipboard: this.workspace.hasClipboard });
  }
  async cutSelected(): Promise<void> {
    const pending = this.workspace.cutSelectedModel();
    // The synchronous copy phase is already complete; deletion still awaits
    // its receipt. Do not publish stale UI state after a newer copy or disposal.
    try {
      this.ui.update({ hasClipboard: this.workspace.hasClipboard });
    } finally {
      // A broken clipboard projection must not abandon an in-flight deletion.
      await pending;
    }
  }
  async paste(): Promise<void> {
    await this.workspace.pasteClipboard();
  }
  exportStl(): void {
    this.workspace.exportPlateStl();
  }
  exportAllObjectsAsStls(): void {
    this.workspace.exportAllObjectsAsStls();
  }
  export3mf(): Promise<void> {
    return this.workspace.exportPlate3mf();
  }
  exportAllPlates(): Promise<number> {
    return this.workspace.exportAllPlates();
  }
  exportToolpathsAsObj(): void {
    this.workspace.exportToolpathsAsObj();
  }
  saveProject(): Promise<void> {
    return this.workspace.saveProject();
  }
  projectRecovery(operation: 'recover' | 'download' | 'discard', id?: string): Promise<void> {
    if (id !== undefined && (typeof id !== 'string' || id.length > 1024))
      throw new Error('Invalid recovery selection.');
    return this.workspace.projectRecovery(operation, id);
  }
  openProject(): void {
    this.workspace.onRequestLoadProject?.();
  }
  openRecentProject(id?: string): void {
    this.workspace.openRecentProject(id);
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
  async arrangePlate(): Promise<void> {
    await this.workspace.arrangePlate();
  }
  async duplicatePlate(id?: PlateId, expectedRevision?: number): Promise<void> {
    await this.workspace.duplicatePlate(id, expectedRevision);
  }
  async splitToObjects(): Promise<void> {
    await this.workspace.splitSelectedToObjects();
  }
  async splitToParts(): Promise<void> {
    await this.workspace.splitSelectedToParts();
  }
  addModifier(): void {
    this.workspace.addModifier();
  }
  addSupportEnforcer(): void {
    this.workspace.addSupportEnforcer();
  }
  addSupportBlocker(): void {
    this.workspace.addSupportBlocker();
  }
  setNegativePart(): void {
    this.workspace.setNegativePart();
  }
  addHeightRange(): void {
    this.workspace.addHeightRange();
  }
  variableLayerHeight(): void {
    this.workspace.variableLayerHeight();
  }
  addMagnetHole(spec?: Parameters<OrcaWorkspace['addMagnetHole']>[0]): void {
    this.workspace.addMagnetHole(spec);
  }
  cutPlane(): void {
    this.workspace.cutSelectedByPlane();
  }

  // ---- Instances ------------------------------------------------------
  async addInstance(): Promise<void> {
    await this.workspace.addInstanceToSelection();
  }

  async convertInstanceToIndependentObject(instanceId?: InstanceId): Promise<void> {
    await this.workspace.convertInstanceToIndependentObject(instanceId);
  }

  async fillBedWithInstances(): Promise<void> {
    await this.workspace.fillPlateWithSelection();
  }

  // ---- Filaments ------------------------------------------------------
  remapFilaments(sourceIds: readonly FilamentId[], destinationId: FilamentId): void {
    this.workspace.remapFilaments(sourceIds, destinationId);
  }

  // ---- Transforms -----------------------------------------------------
  async mirrorSelected(axis: 'x' | 'y' | 'z'): Promise<void> {
    await this.workspace.mirrorSelected(axis);
  }

  async resetSelectedTransform(target: 'rotation' | 'scale' | 'both'): Promise<void> {
    await this.workspace.resetSelectedTransform(target);
  }

  async centerOnPlate(): Promise<void> {
    await this.workspace.centerSelectedOnPlate();
  }

  // ---- Slicing --------------------------------------------------------
  cancelSlice(): void {
    this.workspace.cancelSlice();
  }

  sliceAllPlates(): void {
    void this.workspace.sliceAllPlates();
  }

  downloadAllPlateGcode(): void {
    this.workspace.downloadAllPlateGcode();
  }

  // ---- Preview --------------------------------------------------------
  /** Apply a bounded preview view change from any viewer surface. */
  async updatePreviewView(patch: GcodePreviewViewPatch): Promise<void> {
    await this.workspace.updatePreviewView(patch);
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

  /** Registry handler seams; presentation code invokes the tool action. */
  async applyTransformEdit(request: TransformEditRequest): Promise<ActionResult> {
    const acknowledgement = await this.workspace.applyTransformEdit(request);
    return Object.freeze({ kind: 'project-edit', acknowledgement });
  }

  async applyLayOnFace(request: NonNullable<ActionInvocation['layOnFace']>): Promise<void> {
    await this.workspace.applyLayOnFace(request);
  }

  /**
   * Compatibility gateway for the legacy XR mode card. Its calls still pass
   * through the composition-root registry, including unavailable-tool guards.
   */
  setTool(tool: ToolName): void {
    const actionId = `tool_${tool}`;
    this.invokeFromXr(actionId, 'xr-toolbar');
  }
  async nudge(dir: -1 | 1): Promise<void> {
    await this.workspace.nudgeSelected(dir);
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
  async applyTogglePreview(): Promise<void> {
    await this.workspace.togglePreview();
    const preview = this.workspace.getPreviewState();
    this.ui.update({ mode: preview.loading || preview.view ? 'preview' : 'prepare' });
  }
  /** Compatibility gateway for the legacy XR mode card. */
  togglePreview(): void {
    this.invokeFromXr('toggle_preview', 'xr-primary');
  }
  downloadGcode(): void {
    const gcode = this.workspace.getLastGcode();
    if (gcode && this.workspace.onDownloadGcode) this.workspace.onDownloadGcode(gcode);
  }

  /**
   * Hand a generated program to the same download path a sliced one uses.
   *
   * Deliberately the download path and not the send path. Saving a file an
   * operator can open and read is the safe half of P8.3's export/send; putting
   * a generated program straight onto a machine is the half no supervised
   * print has cleared yet.
   */
  saveTextToDownloads(_filename: string, contents: string): void {
    if (this.workspace.onDownloadGcode) this.workspace.onDownloadGcode(contents);
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

  scanNetwork(): DiscoveryOutcome {
    return this.workspace.scanNetwork();
  }

  inspectPrinterFilaments(): Promise<void> {
    return this.workspace.inspectPrinterFilaments();
  }

  sendToPrinter(): Promise<void> {
    return this.workspace.sendToPrinter();
  }

  controlPrintJob(command: PrintJobCommand, options?: { readonly confirmation?: PrintJobConfirmation }): Promise<void> {
    return this.workspace.controlPrintJob(command, options);
  }

  // ---- Advanced Features ----------------------------------------------
  autoPlaceWipeTower(options?: { readonly enabled?: boolean; readonly plateId?: PlateId }): void {
    if (options?.enabled !== undefined) {
      this.workspace.setWipeTowerAuto(options.enabled);
    } else {
      this.workspace.autoPlaceWipeTower(options?.plateId);
    }
  }
  measureTool(): void {
    this.workspace.measureTool();
  }

  clearMeasureSelection(): void {
    this.workspace.clearMeasureSelection();
  }

  brimEars(): void {
    this.workspace.brimEarsTool();
  }

  emboss(): void {
    this.workspace.embossTool();
  }

  svgPart(): void {
    this.workspace.svgPartTool();
  }

  exportDiagnostics(): void {
    this.workspace.exportDiagnostics();
  }

  loadSvgDrawing(name: string, source: string): void {
    this.workspace.loadSvgDrawing(name, source);
  }

  setSvgPartSize(patch: { depthMm?: number; widthMm?: number }): void {
    this.workspace.setSvgPartSize(patch);
  }

  applySvgPart(): void {
    this.workspace.applySvgPart();
  }

  loadEmbossFont(name: string, bytes: Uint8Array): void {
    this.workspace.loadEmbossFont(name, bytes);
  }

  setEmbossRecipe(patch: EmbossRecipePatch): void {
    this.workspace.setEmbossRecipe(patch);
  }

  applyEmboss(): void {
    this.workspace.applyEmboss();
  }

  setBrimEarRadius(radiusMm: number): void {
    this.workspace.setBrimEarRadius(radiusMm);
  }

  removeBrimEar(index: number): void {
    this.workspace.removeBrimEar(index);
  }

  clearBrimEars(): void {
    this.workspace.clearBrimEars();
  }

  assemblyView(): void {
    this.workspace.measureTool();
    this.workspace.setStatus(
      t('actions.actionContext.assemblyPickAFaceOn', 'Assembly: pick a face on each model, then choose an alignment.'),
    );
  }

  async applyAssemblyAlignment(kind: AssemblyAlignmentKind, parameter?: number): Promise<void> {
    await this.workspace.applyAssemblyAlignment(kind, parameter);
  }

  smartPaint(): void {
    void this.workspace.smartPaint();
  }

  smartPaintImage(): void {
    void this.workspace.smartPaintImage();
  }

  /** Consent, prompt, attached image, and per-region destinations. */
  configureSmartPaint(request: NonNullable<ActionInvocation['smartPaint']>): void {
    if (request.consent) this.workspace.setSmartPaintConsent(request.consent);
    if (request.prompt !== undefined) this.workspace.setSmartPaintPrompt(request.prompt);
    if (request.imageBase64 !== undefined) this.workspace.attachSmartPaintImage(request.imageBase64);
    if (request.region) this.workspace.assignSmartPaintRegion(request.region.id, request.region.value);
  }

  requestSmartPaint(): void {
    void this.workspace.requestSmartPaint();
  }

  applySmartPaint(): void {
    this.workspace.applySmartPaint();
  }

  cancelSmartPaint(): void {
    this.workspace.cancelSmartPaint();
  }

  /** Report a registry-controlled disabled reason without invoking a feature handler. */
  reportCapabilityUnavailable(label: string, reason: string): void {
    this.workspace.setStatus(`${label}: ${reason}`);
  }

  /** Check the PWA service worker for a newer OrcaXR build (Help → Check for Update). */
  async checkForUpdates(): Promise<void> {
    if (this.workspace.onRequestApplicationUpdate) await this.workspace.onRequestApplicationUpdate();
    else
      this.workspace.setStatus(
        t('actions.actionContext.updateCheckIsUnavailableIn', 'Update check is unavailable in this browser.'),
      );
  }

  // ---- Help modals (informational) -----------------------------------
  async recoverStartup(featureId?: string): Promise<void> {
    if (featureId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(featureId))
      throw new Error('Invalid startup feature.');
    await this.workspace.onRequestStartupRecovery?.(featureId);
  }

  showAbout(): void {
    this.workspace.showModal(t('actions.actionContext.aboutOrcaXR', 'About OrcaXR'), ABOUT_HTML);
  }
  showHelpSearch(): void {
    this.workspace.showHelpSearch();
  }
  /**
   * Open the language picker (P10.4).
   *
   * Routed like every other action rather than owned by the DOM header, so the
   * choice is reachable from the command palette, from XR, and from automation
   * — an operator who cannot read the current language needs the one control
   * that fixes that to be findable by more than one route.
   */
  chooseLanguage(): void {
    this.workspace.showLanguagePicker();
  }
  showShortcuts(): void {
    this.workspace.showModal(
      t('actions.actionContext.keyboardShortcuts', 'Keyboard Shortcuts'),
      shortcutsHtml(this.registry.all()),
    );
  }
  showTutorial(): void {
    this.workspace.showModal(t('actions.actionContext.gettingStarted', 'Getting Started'), TUTORIAL_HTML);
  }
  showTip(): void {
    this.workspace.showModal(t('actions.actionContext.tipOfTheDay', 'Tip of the Day'), tipOfTheDayHtml());
  }
  /** Interactive printer / filament setup wizard (built by the DOM shell). */
  setupWizard(): void {
    if (this.workspace.onShowSetupWizard) this.workspace.onShowSetupWizard();
    else
      this.workspace.setStatus(
        t('actions.actionContext.setupWizardIsUnavailableIn', 'Setup wizard is unavailable in this shell.'),
      );
  }

  /** Open an external URL in a new tab (Help → report bug / docs). */
  openUrl(url: string): void {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    else this.workspace.setStatus(`Open ${url}`);
  }
}
