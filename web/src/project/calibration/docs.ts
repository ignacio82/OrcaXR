/**
 * Where each calibration is documented (P8.3).
 *
 * The plan asks for contextual links to the *pinned* docs, and the emphasis is
 * the whole requirement. A link to "the latest calibration guide" describes
 * whatever upstream is doing today, which may not be what this build does; a
 * link pinned to the commit the behaviour was ported from cannot drift away
 * from it. So every href names `PINNED_CALIBRATION_COMMIT` explicitly.
 *
 * Each target is a real file in the pinned tree, and a trace holds that — an
 * invented documentation link is worse than no link, because it sends someone
 * away and gives them nothing.
 */

import { PINNED_CALIBRATION_COMMIT, type CalibrationWorkflowId } from '../../features/calibrationInventory';

/** Path under `doc/calibration/` in the pinned Snapmaker OrcaSlicer tree. */
const DOC_FILE_BY_WORKFLOW: Readonly<Record<CalibrationWorkflowId, string>> = Object.freeze({
  'temperature-tower': 'temp-calib.md',
  'flow-pass-1': 'flow-rate-calib.md',
  'flow-pass-2': 'flow-rate-calib.md',
  'flow-yolo': 'flow-rate-calib.md',
  'flow-yolo-perfectionist': 'flow-rate-calib.md',
  'pressure-advance-tower': 'pressure-advance-calib.md',
  'pressure-advance-line': 'pressure-advance-calib.md',
  'pressure-advance-pattern': 'adaptive-pressure-advance-calib.md',
  'retraction-tower': 'retraction-calib.md',
  'max-volumetric-speed': 'volumetric-speed-calib.md',
  'junction-deviation': 'cornering-calib.md',
  'input-shaping-frequency': 'input-shaping-calib.md',
  'input-shaping-damping': 'input-shaping-calib.md',
  vfa: 'vfa-calib.md',
  'tolerance-extension': 'tolerance-calib.md',
});

/** Repository-relative path, which is what a pinned-tree check can verify. */
export function calibrationDocPath(workflow: CalibrationWorkflowId): string {
  return `doc/calibration/${DOC_FILE_BY_WORKFLOW[workflow]}`;
}

/**
 * A link to the documentation for exactly the commit this build was ported
 * from — never a moving `main`, which would eventually describe something else.
 */
export function calibrationDocHref(workflow: CalibrationWorkflowId): string {
  return `https://github.com/Snapmaker/OrcaSlicer/blob/${PINNED_CALIBRATION_COMMIT}/${calibrationDocPath(workflow)}`;
}

export { DOC_FILE_BY_WORKFLOW };
