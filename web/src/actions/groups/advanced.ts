import type { ActionContext } from '../ActionContext';
import type { ActionDefinition as Action } from '../ActionRegistry';
import type { PrinterStorageOperation } from '../../printer/PrinterStorage';

/**
 * Route one storage operation, refusing a payload that names a different one.
 *
 * These actions each act on a file the operator picked, so an action invoked
 * with no target — from the command palette, say — has to say what is missing
 * rather than guess at a file.
 */
function storageOperation(
  ctx: ActionContext,
  operation: PrinterStorageOperation | undefined,
  kind: PrinterStorageOperation['kind'],
  label: string,
): void | Promise<void> {
  if (!operation || operation.kind !== kind) {
    ctx.reportCapabilityUnavailable(label, 'Pick a file in the printer storage browser first.');
    return;
  }
  return ctx.operatePrinterStorage(operation);
}

export const advancedActions: Action[] = [
  {
    id: 'filament_virtual_mutate',
    label: 'Edit virtual filament library',
    icon: 'filament',
    group: 'filament',
    disclosure: 'inspector',
    hint: 'Add, edit, duplicate, enable, or delete one stable FullSpectrum recipe',
    run: (ctx, invocation) => {
      if (invocation.fullSpectrumAutoPairPreference) {
        const request = invocation.fullSpectrumAutoPairPreference;
        ctx.configureFullSpectrumAutoPairs(request.enabled, request.confirmedPhysicalCount);
        return;
      }
      if (!invocation.virtualFilamentMutation) {
        ctx.reportCapabilityUnavailable(
          'Edit virtual filament library',
          'Open the virtual filament editor and submit a complete validated recipe.',
        );
        return;
      }
      ctx.mutateVirtualFilament(invocation.virtualFilamentMutation);
    },
  },
  {
    id: 'settings_apply_project',
    label: 'Apply project settings',
    icon: 'settings',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Apply validated generated settings as one canonical project override command',
    run: (ctx, invocation) => {
      const request = invocation.projectSettingsApply;
      if (!request) {
        ctx.reportCapabilityUnavailable('Apply project settings', 'Review and apply a settings draft first.');
        return;
      }
      ctx.applyProjectSettings(request.inheritedConfig, request.overrides, {
        sourceRevision: request.sourceRevision,
        sourceHash: request.sourceHash,
      });
    },
  },
  {
    id: 'settings_apply_scoped',
    label: 'Apply scoped settings',
    icon: 'advanced',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Override settings on a plate, object, part, or height range as one canonical command',
    run: (ctx, invocation) => {
      const request = invocation.scopedSettingsApply;
      if (!request) {
        ctx.reportCapabilityUnavailable(
          'Apply scoped settings',
          'Pick a plate, object, part, or height range in the Settings panel and edit one of its settings first.',
        );
        return;
      }
      ctx.applyScopedSettings(request.target, request.overrides, {
        sourceRevision: request.sourceRevision,
        sourceHash: request.sourceHash,
      });
    },
  },
  {
    id: 'add_magnet',
    mcpTool: 'add_magnets',
    label: 'Add Magnet Hole',
    icon: 'magnet',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Add a cavity for a magnet',
  },
  {
    id: 'auto_place_wipe',
    label: 'Auto-place Wipe Tower',
    icon: 'wipe_tower',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Automatically position the wipe tower',
    run: (ctx) => ctx.autoPlaceWipeTower(),
  },
  {
    id: 'scan_network',
    label: 'Scan Subnets',
    icon: 'network',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Scan local network for printers',
  },
  {
    id: 'printer_test_connection',
    label: 'Test Printer Connection',
    icon: 'network',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Connect to the configured Moonraker endpoint and verify its typed capabilities',
    run: (ctx) => ctx.testPrinterConnection(),
  },
  {
    id: 'printer_inspect_filaments',
    mcpTool: 'sync_filaments_from_printer',
    label: 'Sync Filaments From Printer',
    icon: 'filament',
    group: 'filament',
    disclosure: 'inspector',
    // The old label and hint said this only read the slots. It has adopted
    // them into the project as an undoable command for some time, so saying
    // otherwise hid the feature from the person looking for exactly it.
    hint: 'Adopt the filaments the connected printer reports as loaded, as one undoable change',
    run: (ctx) => ctx.inspectPrinterFilaments(),
  },
  {
    id: 'printer_pause_print',
    label: 'Pause Print',
    icon: 'printer_pause',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Pause the running print on the connected printer',
    run: (ctx) => ctx.controlPrintJob('pause'),
  },
  {
    id: 'printer_resume_print',
    label: 'Resume Print',
    icon: 'printer_resume',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Resume the paused print on the connected printer',
    run: (ctx) => ctx.controlPrintJob('resume'),
  },
  {
    id: 'printer_cancel_print',
    label: 'Cancel Print',
    icon: 'printer_cancel',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Stop the running print after an explicit confirmation',
    run: (ctx, invocation) => ctx.controlPrintJob('cancel', { preconfirmed: invocation.printJobPreconfirmed === true }),
  },
  {
    id: 'printer_emergency_stop',
    label: 'Emergency Stop',
    icon: 'emergency_stop',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Halt the printer immediately; Klipper then needs a firmware restart',
    run: (ctx, invocation) =>
      ctx.controlPrintJob('emergency-stop', { preconfirmed: invocation.printJobPreconfirmed === true }),
  },
  {
    id: 'printer_browse_storage',
    mcpTool: 'browse_printer_storage',
    label: 'Browse Printer Files',
    icon: 'file',
    group: 'advanced',
    disclosure: 'inspector',
    hint: "List the G-code already on the connected printer, with each file's own metadata",
    run: (ctx, invocation) => {
      const operation = invocation.printerStorage;
      return ctx.operatePrinterStorage(
        operation?.kind === 'browse' ? operation : { kind: 'browse', ...(operation ? { path: operation.path } : {}) },
      );
    },
  },
  {
    id: 'printer_print_stored_file',
    mcpTool: 'print_stored_file',
    label: 'Print Stored File',
    icon: 'printer_resume',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Start a print of a file already on the printer, without re-slicing or re-uploading it',
    run: (ctx, invocation) => storageOperation(ctx, invocation.printerStorage, 'print', 'Print Stored File'),
  },
  {
    id: 'printer_rename_stored_file',
    label: 'Rename Stored File',
    icon: 'edit',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Rename one file on the printer, leaving it in the folder it is already in',
    run: (ctx, invocation) => storageOperation(ctx, invocation.printerStorage, 'rename', 'Rename Stored File'),
  },
  {
    id: 'printer_download_stored_file',
    label: 'Download Stored File',
    icon: 'download',
    group: 'advanced',
    disclosure: 'inspector',
    hint: "Fetch one file's bytes from the printer to this device",
    run: (ctx, invocation) => storageOperation(ctx, invocation.printerStorage, 'download', 'Download Stored File'),
  },
  {
    id: 'printer_delete_stored_file',
    label: 'Delete Stored File',
    icon: 'delete',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Remove one file from the printer after an explicit confirmation',
    run: (ctx, invocation) => storageOperation(ctx, invocation.printerStorage, 'delete', 'Delete Stored File'),
  },
  {
    id: 'printer_console_send',
    mcpTool: 'send_printer_gcode',
    label: 'Send G-code Command',
    icon: 'gcode',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Run one typed G-code command on the printer, after confirming what it will do',
    run: (ctx, invocation) => {
      const operation = invocation.printerConsole;
      if (!operation || operation.kind !== 'send') {
        ctx.reportCapabilityUnavailable('Send G-code Command', 'Type a command in the printer console first.');
        return;
      }
      return ctx.operatePrinterConsole(operation);
    },
  },
  {
    id: 'printer_run_macro',
    mcpTool: 'run_printer_macro',
    label: 'Run Printer Macro',
    icon: 'gcode',
    group: 'advanced',
    disclosure: 'inspector',
    hint: "Run one of the printer's own macros with the parameters its body declares",
    run: (ctx, invocation) => {
      const operation = invocation.printerConsole;
      if (!operation || operation.kind !== 'macro') {
        ctx.reportCapabilityUnavailable('Run Printer Macro', 'Pick a macro in the printer console first.');
        return;
      }
      return ctx.operatePrinterConsole(operation);
    },
  },
  {
    id: 'printer_list_macros',
    label: 'Refresh Printer Macros',
    icon: 'network',
    group: 'advanced',
    disclosure: 'inspector',
    hint: "Read the macros from the connected printer's own configuration",
    run: (ctx) => ctx.operatePrinterConsole({ kind: 'refresh-macros' }),
  },
  {
    id: 'printer_show_status',
    mcpTool: 'show_printer_status',
    label: 'Printer Status',
    icon: 'printer_send',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Show the running print over the plate, on any tab and at any width',
    run: (ctx) => ctx.togglePrinterStatusBar(),
  },
  {
    id: 'printer_view_history',
    mcpTool: 'list_print_history',
    label: 'Print History',
    icon: 'logs',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Read what this printer has already printed, with how each run ended and what it used',
    run: (ctx, invocation) => ctx.loadPrintHistory(invocation.printHistoryStart ?? 0),
  },
  {
    id: 'view_webcam',
    mcpTool: 'view_printer_camera',
    label: 'View Webcam',
    icon: 'webcam',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: "Discover the printer's cameras and watch one as authenticated snapshots",
    run: (ctx, invocation) => ctx.viewPrinterCamera(invocation.printerCameraUid),
  },
  {
    id: 'recreate_model_colors_fullspectrum',
    label: 'Recreate Model Colors (Full-Spectrum)',
    icon: 'palette',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Recreate model colors using printer filaments via Full-Spectrum dithering',
    isEnabled: (s) => s.modelCount > 0,
    xrUnsupportedReason:
      'Recreating model colors uses a DOM configuration and preview dialog; no in-headset color mapping editor exists yet.',
    run: async (ctx, invocation) => {
      await ctx.recreateModelColors(invocation.recreateModelColors);
    },
  },
];
