/**
 * Output group — getting the sliced result off the plate. Download today;
 * Moonraker send + print and STL/3MF export are wired in later phases.
 */
import type { Action } from '../ActionRegistry';

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
    id: 'send_to_printer',
    label: 'Send to Printer',
    icon: 'printer_send',
    group: 'output',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Upload the sliced G-code to a Moonraker printer and start the print',
    run: (ctx) => ctx.sendToPrinter(),
  },
];
