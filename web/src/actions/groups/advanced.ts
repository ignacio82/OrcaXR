import type { ActionDefinition as Action } from '../ActionRegistry';

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
    run: (ctx) => ctx.controlPrintJob('cancel'),
  },
  {
    id: 'printer_emergency_stop',
    label: 'Emergency Stop',
    icon: 'emergency_stop',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Halt the printer immediately; Klipper then needs a firmware restart',
    run: (ctx) => ctx.controlPrintJob('emergency-stop'),
  },
  {
    id: 'view_webcam',
    label: 'View Webcam',
    icon: 'webcam',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'View the live printer webcam feed',
  },
  {
    id: 'recreate_model_colors_fullspectrum',
    label: 'Recreate Model Colors (Full-Spectrum)',
    icon: 'palette',
    group: 'advanced',
    disclosure: 'menu',
    menuSection: 'tools',
    hint: 'Recreate model colors using printer filaments via Full-Spectrum dithering',
  },
];
