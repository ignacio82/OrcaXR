/**
 * Calibration group — mirrors Snapmaker Orca's `Calibration` menu. OrcaXR
 * has a shared alpha geometry generator behind these actions, but the complete
 * per-band setting effects and validated workflows are still in progress. The
 * acceptance work is tracked in `docs/parity.md`.
 */
import type { ActionContext } from '../ActionContext';
import type { ActionDefinition as Action } from '../ActionRegistry';
import type { CalibrationHistoryOperation } from '../../project/calibration/history';

/** Route one ledger operation, refusing a payload that names a different one. */
function historyOperation(
  ctx: ActionContext,
  operation: CalibrationHistoryOperation | undefined,
  kind: CalibrationHistoryOperation['kind'],
  label: string,
  missing: string,
): void | Promise<void> {
  if (!operation || operation.kind !== kind) {
    ctx.reportCapabilityUnavailable(label, missing);
    return;
  }
  return ctx.operateCalibrationHistory(operation);
}

export const calibrationActions: Action[] = [
  {
    id: 'calib_temperature',
    mcpTool: 'generate_calibration_ramp',
    label: 'Temperature Tower',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Generate a temperature-tuning tower',
    run: (ctx) => ctx.addCalibration('tower'),
  },
  {
    id: 'calib_flow_pass1',
    label: 'Flow Rate — Pass 1',
    icon: 'flow',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Coarse flow-rate (extrusion multiplier) calibration plate',
    run: (ctx) => ctx.addCalibration('flow_pass1'),
  },
  {
    id: 'calib_flow_pass2',
    label: 'Flow Rate — Pass 2',
    icon: 'flow',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Fine flow-rate calibration plate',
    run: (ctx) => ctx.addCalibration('flow_pass2'),
  },
  {
    id: 'calib_flow_yolo',
    label: 'Flow Rate — YOLO (Recommended)',
    icon: 'flow',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Single-pass Orca YOLO flow calibration',
    run: (ctx) => ctx.addCalibration('flow_yolo'),
  },
  {
    id: 'calib_flow_yolo_perfectionist',
    label: 'Flow Rate — YOLO (Perfectionist)',
    icon: 'flow',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Extended-range fine-step Orca YOLO flow calibration',
    run: (ctx) => ctx.addCalibration('flow_yolo_perfectionist'),
  },
  {
    id: 'calib_pressure_advance',
    label: 'Pressure Advance',
    icon: 'pressure',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Pressure-advance / linear-advance tuning pattern',
    run: (ctx) => ctx.addCalibration('pressure_advance'),
  },
  {
    id: 'calib_retraction',
    label: 'Retraction Test',
    icon: 'retraction',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Retraction-distance stringing test tower',
    run: (ctx) => ctx.addCalibration('retraction'),
  },
  {
    id: 'calib_max_flow',
    label: 'Max Flowrate',
    icon: 'flow',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Maximum volumetric-speed calibration',
    run: (ctx) => ctx.addCalibration('max_flow'),
  },
  {
    id: 'calib_vfa',
    label: 'VFA Test',
    icon: 'vfa',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Vertical Fine Artefact (resonance) test',
    run: (ctx) => ctx.addCalibration('vfa'),
  },
  {
    id: 'calib_tolerance',
    label: 'Tolerance Test',
    icon: 'tolerance',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Dimensional-tolerance fit test',
    run: (ctx) => ctx.addCalibration('tolerance'),
  },
  {
    id: 'calib_junction_deviation',
    label: 'Junction Deviation',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Cornering junction-deviation test pattern',
    run: (ctx) => ctx.addCalibration('junction_deviation'),
  },
  {
    id: 'calib_input_shaping_frequency',
    label: 'Input Shaping Frequency',
    icon: 'vfa',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Resonance frequency calibration tower',
    run: (ctx) => ctx.addCalibration('input_shaping_frequency'),
  },
  {
    id: 'calib_input_shaping_damping',
    label: 'Input Shaping Damping / Zeta Factor',
    icon: 'vfa',
    group: 'calibration',
    disclosure: 'menu',
    menuSection: 'calibration',
    hint: 'Input-shaping damping factor (zeta) calibration tower',
    run: (ctx) => ctx.addCalibration('input_shaping_damping'),
  },
  {
    id: 'calib_view_history',
    mcpTool: 'list_calibration_history',
    label: 'Calibration History',
    icon: 'logs',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'What this machine has been calibrated for, and whether each result still applies',
    run: (ctx) => ctx.operateCalibrationHistory({ kind: 'refresh' }),
  },
  {
    id: 'calib_record_result',
    mcpTool: 'record_calibration_result',
    label: 'Record Calibration Result',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Store a measurement with the printer, nozzle, and material it was taken on',
    run: (ctx, invocation) =>
      historyOperation(
        ctx,
        invocation.calibrationHistory,
        'record',
        'Record Calibration Result',
        'Measure a calibration print and enter its result first.',
      ),
  },
  {
    id: 'calib_compare_results',
    label: 'Compare Calibration Results',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Put two runs side by side, with the caveats that make them comparable or not',
    run: (ctx, invocation) =>
      historyOperation(
        ctx,
        invocation.calibrationHistory,
        'compare',
        'Compare Calibration Results',
        'Pick two recorded runs first.',
      ),
  },
  {
    id: 'calib_rerun_result',
    label: 'Re-run Calibration',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Run the same method with the same sweep again, if the method has not changed since',
    run: (ctx, invocation) =>
      historyOperation(ctx, invocation.calibrationHistory, 'rerun', 'Re-run Calibration', 'Pick a recorded run first.'),
  },
  {
    id: 'calib_apply_result',
    mcpTool: 'apply_calibration_result',
    label: 'Save Result To Preset',
    icon: 'settings_import',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Write a measured result into the option it tunes, as one operator-authored preset',
    run: (ctx, invocation) =>
      historyOperation(
        ctx,
        invocation.calibrationHistory,
        'apply',
        'Save Result To Preset',
        'Pick a recorded run whose conditions still hold first.',
      ),
  },
  {
    id: 'calib_delete_result',
    label: 'Delete Calibration Result',
    icon: 'delete',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Remove one recorded run from this device',
    run: (ctx, invocation) =>
      historyOperation(
        ctx,
        invocation.calibrationHistory,
        'delete',
        'Delete Calibration Result',
        'Pick a recorded run first.',
      ),
  },
  {
    id: 'calib_choose',
    mcpTool: 'choose_calibration',
    label: 'Choose calibration to configure',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Pick which pinned calibration the parameter panel is editing',
    run: (ctx, invocation) => {
      const id = invocation.calibrationWorkflowId;
      if (id === undefined) {
        ctx.reportCapabilityUnavailable('Choose calibration', 'Name a calibration to configure.');
        return;
      }
      ctx.setCalibrationWorkflow(id);
    },
  },
  {
    id: 'calib_configure',
    mcpTool: 'configure_calibration',
    label: 'Set a calibration parameter',
    icon: 'settings',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Change one parameter of the calibration being configured; the preview recompiles',
    run: (ctx, invocation) => {
      const parameter = invocation.calibrationParameter;
      if (!parameter) {
        ctx.reportCapabilityUnavailable('Set a calibration parameter', 'Name a parameter and a value.');
        return;
      }
      ctx.setCalibrationParameter(parameter.key, parameter.text);
    },
  },
  {
    id: 'calib_reset_parameters',
    mcpTool: 'reset_calibration_parameters',
    label: 'Reset calibration parameters',
    icon: 'undo',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Put the definition’s own defaults back',
    // A back-out action: never withheld in a headset, and covered by the
    // registry invariant that says so.
    run: (ctx) => {
      ctx.resetCalibrationParameters();
    },
  },
  {
    id: 'calib_place_geometry',
    mcpTool: 'place_calibration_geometry',
    label: 'Place the calibration model',
    icon: 'calibration',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Load the upstream gauge for this calibration, verified against the hash it was audited under',
    run: async (ctx) => {
      const result = await ctx.placeCalibrationGeometry();
      if ('reason' in result) {
        ctx.reportCapabilityUnavailable('Place the calibration model', result.reason);
      }
    },
  },
  {
    id: 'calib_sweep_export',
    mcpTool: 'export_calibration_sweep',
    label: 'Save pressure-advance sweep G-code',
    icon: 'settings_export',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Build the line-sweep program and save it for inspection; it borrows your machine’s own start sequence from a real slice',
    run: (ctx) => {
      const built = ctx.buildCalibrationSweepProgram();
      if ('reason' in built) {
        ctx.reportCapabilityUnavailable('Save pressure-advance sweep G-code', built.reason);
        return;
      }
      ctx.saveTextToDownloads(built.filename, built.gcode);
    },
  },
  {
    id: 'calib_session_discard',
    mcpTool: 'discard_calibration',
    label: 'Discard calibration, restore my project',
    icon: 'undo',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Throw the calibration away and put the held project back exactly as it was',
    isEnabled: (s) => s.calibrationSessionOpen === true,
    // Never withheld in a headset. This is the way out of a state an operator
    // can enter from either shell, and a way out that only one shell offers is
    // a trap — see the back-out invariant in the registry parity traces.
    run: (ctx) => {
      ctx.discardCalibrationSession();
    },
  },
  {
    id: 'calib_session_keep',
    mcpTool: 'keep_calibration',
    label: 'Keep calibration as my project',
    icon: 'check',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Adopt the calibration as the project and let the held one go',
    isEnabled: (s) => s.calibrationSessionOpen === true,
    run: (ctx) => {
      ctx.keepCalibrationSession();
    },
  },
  {
    id: 'calib_export_history',
    mcpTool: 'export_calibration_history',
    label: 'Export Calibration History',
    icon: 'settings_export',
    group: 'calibration',
    disclosure: 'inspector',
    hint: 'Write every recorded run to one file, proven to carry no address or credential',
    run: (ctx) => ctx.operateCalibrationHistory({ kind: 'export' }),
  },
];
