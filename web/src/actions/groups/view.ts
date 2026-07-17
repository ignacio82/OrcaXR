/**
 * View group — mirrors Snapmaker Orca's `View` menu (camera presets, projection
 * mode, scene-display toggles). All entries are parity placeholders today:
 * OrcaXR uses XR Blocks' OrbitControls with no preset-view or display-toggle
 * API wired yet. `docs/orca_parity_plan.md` lists the camera-preset hook to
 * implement (the OrbitControls target + a canned quaternion per view).
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

function cameraView(id: string, label: string): Action {
  return {
    id: `view_camera_${id}`,
    label,
    icon: `view_${id}`,
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: `Snap the camera to the ${label.toLowerCase()}`,
    run: (ctx) => ctx.setCameraView(id),
  };
}

export const viewActions: Action[] = [
  cameraView('default', 'Default View'),
  cameraView('top', 'Top View'),
  cameraView('front', 'Front View'),
  cameraView('left', 'Left View'),
  cameraView('right', 'Right View'),
  cameraView('rear', 'Rear View'),
  cameraView('bottom', 'Bottom View'),
  {
    id: 'view_perspective_toggle',
    label: 'Perspective / Orthographic',
    icon: 'perspective',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Toggle between perspective and orthographic projection',
  },
  {
    id: 'view_show_labels',
    label: 'Show Object Labels',
    icon: 'labels',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Show object name labels in the 3D scene',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.toggleLabels(),
  },
  {
    id: 'view_show_overhang',
    label: 'Show Overhangs',
    icon: 'overhang',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Highlight overhang faces that will need support',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.toggleOverhang(),
  },
  {
    id: 'view_show_wireframe',
    label: 'Show Wireframe',
    icon: 'wireframe',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Draw model wireframes in the 3D scene',
    isEnabled: (s) => s.modelCount > 0,
    run: (ctx) => ctx.toggleWireframe(),
  },
  {
    id: 'view_auto_perspective',
    label: 'Auto Perspective',
    icon: 'perspective',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Auto-switch orthographic/perspective when changing to top/side views',
  },
  {
    id: 'view_show_navigator',
    label: 'Show 3D Navigator',
    icon: 'navigator',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Show the orientation navigator gizmo',
  },
  {
    id: 'view_show_outline',
    label: 'Show Selected Outline',
    icon: 'outline',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Draw an outline around the selected object',
  },
  {
    id: 'view_show_gcode_window',
    label: 'Show G-code Window',
    icon: 'gcode',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Show the G-code text window in Preview',
  },
  {
    id: 'view_show_printable_box',
    label: 'Show Printable Box',
    icon: 'printable_box',
    group: 'view',
    disclosure: 'menu',
    menuSection: 'view',
    hint: 'Show the printable build volume box',
    run: (ctx) => ctx.togglePrintableBox(),
  },
];
