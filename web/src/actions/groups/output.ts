/**
 * Output group — getting the sliced result off the plate. Download today;
 * Moonraker send + print and STL/3MF export are wired in later phases.
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

export const outputActions: Action[] = [
  {
    id: 'save_gcode_to_downloads',
    mcpTool: 'save_gcode_to_downloads',
    label: 'Download',
    icon: 'download',
    group: 'output',
    disclosure: 'primary',
    hint: 'Download the sliced G-code',
    isEnabled: (s) => s.gcodeReady,
    run: (ctx) => ctx.downloadGcode(),
  },
  {
    id: 'view_open_gcode',
    label: 'Open G-code…',
    icon: 'load',
    group: 'output',
    disclosure: 'menu',
    menuSection: 'file',
    hint: 'Inspect a standalone G-code file without changing the project',
    run: (ctx) => ctx.openGcodeFile(),
  },
  {
    id: 'preview_configure',
    label: 'Set preview view',
    icon: 'view',
    group: 'output',
    disclosure: 'inspector',
    hint: 'Choose the preview colour mode, layer window, and visible move classes',
    run: (ctx, invocation) => {
      const request = invocation.previewView;
      if (!request) {
        ctx.reportCapabilityUnavailable('Set preview view', 'Choose a preview control first.');
        return;
      }
      ctx.updatePreviewView(request);
    },
  },
  {
    id: 'send_to_printer',
    label: 'Send to Printer',
    icon: 'printer_send',
    group: 'output',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Upload the sliced G-code to a Moonraker printer and start the print',
  },
];
