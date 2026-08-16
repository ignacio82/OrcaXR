/**
 * Preset library group — installing printers, authoring presets over a system
 * base, and moving a setup between browsers (parity P6.4).
 *
 * Every one of these is a write to the operator's own catalog, so none of them
 * happens anywhere but here: a panel collects the fields and submits one
 * `PresetLibraryOperation`, and the same route serves automation. An action
 * invoked with no operation says which one is missing rather than guessing at a
 * printer to install or a preset to delete.
 */
import type { ActionContext } from '../ActionContext';
import type { ActionDefinition as Action } from '../ActionRegistry';
import type { PresetLibraryOperation } from '../../settings/presets/PresetLibrary';

function libraryOperation(
  ctx: ActionContext,
  operation: PresetLibraryOperation | undefined,
  kind: PresetLibraryOperation['kind'],
  label: string,
  missing: string,
): void | Promise<void> {
  if (!operation || operation.kind !== kind) {
    ctx.reportCapabilityUnavailable(label, missing);
    return;
  }
  return ctx.operatePresetLibrary(operation);
}

export const presetActions: Action[] = [
  {
    id: 'presets_install_printer',
    mcpTool: 'install_printer',
    label: 'Install Printer',
    icon: 'library',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Choose which printers and nozzles this browser offers, from the pinned catalog',
    run: (ctx, invocation) =>
      libraryOperation(
        ctx,
        invocation.presetLibrary,
        'install',
        'Install Printer',
        'Pick a printer model and at least one nozzle in the setup panel first.',
      ),
  },
  {
    id: 'presets_create_custom',
    mcpTool: 'create_custom_preset',
    label: 'Create Custom Preset',
    icon: 'plus',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Author a printer, process, or filament preset as an overlay on a compatible base',
    run: (ctx, invocation) =>
      libraryOperation(
        ctx,
        invocation.presetLibrary,
        'create',
        'Create Custom Preset',
        'Name the preset and choose the base it inherits from first.',
      ),
  },
  {
    id: 'presets_update_custom',
    label: 'Edit Custom Preset',
    icon: 'edit',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Change one of your own presets, its licence, or its version, keeping its creation record',
    run: (ctx, invocation) =>
      libraryOperation(
        ctx,
        invocation.presetLibrary,
        'update',
        'Edit Custom Preset',
        'Pick one of your own presets in the setup panel first.',
      ),
  },
  {
    id: 'presets_delete_custom',
    label: 'Delete Custom Preset',
    icon: 'delete',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Remove one of your own presets, once nothing else inherits from it',
    run: (ctx, invocation) =>
      libraryOperation(
        ctx,
        invocation.presetLibrary,
        'delete',
        'Delete Custom Preset',
        'Pick one of your own presets in the setup panel first.',
      ),
  },
  {
    id: 'presets_export_bundle',
    mcpTool: 'export_preset_bundle',
    label: 'Export Preset Bundle',
    icon: 'settings_export',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Write this setup — installed printers and your own presets — to one reviewable file',
    run: (ctx) => ctx.operatePresetLibrary({ kind: 'export' }),
  },
  {
    id: 'presets_import_bundle',
    mcpTool: 'import_preset_bundle',
    label: 'Import Preset Bundle',
    icon: 'settings_import',
    group: 'advanced',
    disclosure: 'inspector',
    hint: 'Replace this setup from a bundle, or refuse it whole if it does not fit this build',
    run: (ctx, invocation) =>
      libraryOperation(
        ctx,
        invocation.presetLibrary,
        'import',
        'Import Preset Bundle',
        'Choose a preset bundle file first.',
      ),
  },
];
