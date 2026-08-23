/**
 * XrTopStrip — spatial HUD header strip above the build plate in XR.
 *
 * Hosts the Menu launcher, Quick Save/Undo/Redo actions, the 4 Workspace Tabs
 * (Prepare / Preview / Device / Project), Primary Slice & Print triggers, and
 * utility buttons (Profile toggle, Recenter, Exit).
 */
import { createXrButton, createXrTabBar, type XrTabItem } from './XrComponents';
import type { XrUiAdapter } from './XrUiAdapter';
import { tokens } from '../tokens';

export type XrWorkspaceMode = 'prepare' | 'preview' | 'device' | 'project';

export interface XrTopStripContext {
  readonly activeMode: XrWorkspaceMode;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly isDirty: boolean;
  onToggleMenu?(): void;
  onSelectMode(mode: XrWorkspaceMode): void;
  onUndo?(): void;
  onRedo?(): void;
  onSave?(): void;
  onSlice?(): void;
  onPrint?(): void;
  onToggleProfiles?(): void;
  onRecenter?(): void;
  onExitXr?(): void;
}

export interface XrTopStripRender<PanelNode> {
  readonly root: PanelNode;
  setActiveMode(mode: XrWorkspaceMode): void;
  dispose(): void;
}

const WORKSPACE_MODES: readonly XrTabItem[] = [
  { id: 'prepare', label: 'Prepare', icon: 'view_in_ar' },
  { id: 'preview', label: 'Preview', icon: 'visibility' },
  { id: 'device', label: 'Device', icon: 'print' },
  { id: 'project', label: 'Project', icon: 'folder' },
];

export function renderXrTopStrip<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrTopStripContext,
): XrTopStripRender<PanelNode> {
  const shell = ui.createPanel({
    width: '100%',
    flexDirection: 'column',
    alignItems: 'stretch',
    fillColor: '#0d141cE6',
    cornerRadius: tokens.radius.md,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 6,
    strokeWidth: 1,
    strokeColor: '#FF6D0066',
  });
  ui.appendChild(root, shell);

  // Top Row: Menu launcher + Quick Actions (Save, Undo, Redo) + Utilities (Profiles, Recenter, Exit)
  const topRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  });
  ui.appendChild(shell, topRow);

  // Left group: Menu button + Quick actions
  const leftGroup = ui.createPanel({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  });
  ui.appendChild(topRow, leftGroup);

  const menuBtn = createXrButton(ui, {
    label: 'Menu',
    icon: 'layers',
    iconSize: 18,
    fontSize: 14,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: ctx.onToggleMenu,
  });
  ui.appendChild(leftGroup, menuBtn.root);

  const saveBtn = createXrButton(ui, {
    icon: 'save',
    iconSize: 16,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    primary: ctx.isDirty,
    onClick: ctx.onSave,
  });
  ui.appendChild(leftGroup, saveBtn.root);

  const undoBtn = createXrButton(ui, {
    icon: 'undo',
    iconSize: 16,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    enabled: ctx.canUndo,
    onClick: ctx.onUndo,
  });
  ui.appendChild(leftGroup, undoBtn.root);

  const redoBtn = createXrButton(ui, {
    icon: 'redo',
    iconSize: 16,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    enabled: ctx.canRedo,
    onClick: ctx.onRedo,
  });
  ui.appendChild(leftGroup, redoBtn.root);

  // Right group: Utilities (Profiles, Recenter, Exit)
  const rightGroup = ui.createPanel({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  });
  ui.appendChild(topRow, rightGroup);

  const profBtn = createXrButton(ui, {
    icon: 'tune',
    iconSize: 16,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: ctx.onToggleProfiles,
  });
  ui.appendChild(rightGroup, profBtn.root);

  const recenterBtn = createXrButton(ui, {
    icon: 'home',
    iconSize: 16,
    paddingLeft: 8,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: ctx.onRecenter,
  });
  ui.appendChild(rightGroup, recenterBtn.root);

  const exitBtn = createXrButton(ui, {
    label: 'Exit XR',
    icon: 'logout',
    iconSize: 16,
    fontSize: 12,
    danger: true,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: ctx.onExitXr,
  });
  ui.appendChild(rightGroup, exitBtn.root);

  // Bottom Row: Workspace Tabs (Prepare / Preview / Device / Project) + Slice / Print buttons
  const bottomRow = ui.createPanel({
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  });
  ui.appendChild(shell, bottomRow);

  const modeTabBar = createXrTabBar(ui, WORKSPACE_MODES, ctx.activeMode, (modeId) => {
    ctx.onSelectMode(modeId as XrWorkspaceMode);
  });
  ui.appendChild(bottomRow, modeTabBar.root);

  // Slice & Print buttons at the inline end
  const printActions = ui.createPanel({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  });
  ui.appendChild(bottomRow, printActions);

  const sliceBtn = createXrButton(ui, {
    label: 'Slice',
    icon: 'slice',
    iconSize: 16,
    fontSize: 13,
    primary: true,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: ctx.onSlice,
  });
  ui.appendChild(printActions, sliceBtn.root);

  const printBtn = createXrButton(ui, {
    label: 'Print',
    icon: 'output',
    iconSize: 16,
    fontSize: 13,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 6,
    paddingBottom: 6,
    onClick: ctx.onPrint,
  });
  ui.appendChild(printActions, printBtn.root);

  return {
    root: shell,
    setActiveMode(mode: XrWorkspaceMode) {
      modeTabBar.setActiveTab(mode);
    },
    dispose() {},
  };
}
