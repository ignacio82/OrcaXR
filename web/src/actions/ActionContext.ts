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
  addFromLibrary(): void {
    this.workspace.addFromLibrary();
  }
  deleteSelected(): void {
    this.workspace.deleteSelectedModel();
  }
  autoOrient(): void {
    this.workspace.autoOrientSelectedModel();
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
  addCalibration(kind: 'tower' | 'cube'): void {
    this.workspace.addCalibration(kind);
  }
  addPlate(): void {
    this.workspace.addPlate();
  }
  deletePlate(): void {
    this.workspace.deletePlate();
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
    // Prepare/Paint map onto the existing modal-tool machinery; Preview is a
    // read-only inspection surface that doesn't own a manipulation tool.
    if (mode === 'paint') this.workspace.setTool('paint');
    else if (mode === 'prepare') this.workspace.setTool('move');
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
    this.palette.add();
  }

  // ---- Advanced Features ----------------------------------------------
  embossText(): void {
    this.workspace.setStatus('Emboss Text feature called');
  }
  addMagnet(): void {
    this.workspace.setStatus('Add Magnet feature called');
  }
  autoPlaceWipeTower(): void {
    this.workspace.setWipeTowerAuto(!this.workspace.wipeTowerAuto);
    this.workspace.setStatus('Auto-place Wipe Tower toggled: ' + this.workspace.wipeTowerAuto);
  }
  scanNetwork(): void {
    this.workspace.setStatus('Scan Network feature called');
  }
  viewWebcam(): void {
    this.workspace.setStatus('View Webcam feature called');
  }
}
