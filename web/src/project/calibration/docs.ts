/**
 * Where each calibration is documented (P8.3).
 *
 * The plan asks for contextual links to the *pinned* docs, and the emphasis is
 * the whole requirement. A link to "the latest calibration guide" describes
 * whatever upstream is doing today, which may not be what this build does; a
 * link pinned to the commit the behaviour was ported from cannot drift away
 * from it. So every href names `PINNED_CALIBRATION_COMMIT` explicitly.
 *
 * The targets are not written here. They come from the generated inventory,
 * where each one was resolved to a Git blob at the pinned commit — resolving a
 * path that is not in that tree fails the generator outright. That is what
 * makes the link check real on a machine with no upstream clone: a second copy
 * of the mapping maintained by hand could drift into naming a page that does
 * not exist, and an invented documentation link is worse than no link, because
 * it sends someone away and gives them nothing.
 */

import {
  calibrationInventory,
  PINNED_CALIBRATION_COMMIT,
  type CalibrationWorkflowId,
} from '../../features/calibrationInventory';

/** Path under `doc/calibration/` in the pinned Snapmaker OrcaSlicer tree. */
const DOC_PATH_BY_WORKFLOW: Readonly<Record<CalibrationWorkflowId, string>> = Object.freeze(
  Object.fromEntries(calibrationInventory.documentation.map((target) => [target.workflowId, target.path])) as Record<
    CalibrationWorkflowId,
    string
  >,
);

/** Repository-relative path, which is what a pinned-tree check can verify. */
export function calibrationDocPath(workflow: CalibrationWorkflowId): string {
  return DOC_PATH_BY_WORKFLOW[workflow];
}

/** The Git blob the target resolved to at the pinned commit. */
export function calibrationDocBlob(workflow: CalibrationWorkflowId): string {
  const target = calibrationInventory.documentation.find((entry) => entry.workflowId === workflow);
  if (!target) throw new Error(`No pinned documentation target for ${workflow}`);
  return target.blob;
}

/**
 * A link to the documentation for exactly the commit this build was ported
 * from — never a moving `main`, which would eventually describe something else.
 */
export function calibrationDocHref(workflow: CalibrationWorkflowId): string {
  return `https://github.com/Snapmaker/OrcaSlicer/blob/${PINNED_CALIBRATION_COMMIT}/${calibrationDocPath(workflow)}`;
}

export { DOC_PATH_BY_WORKFLOW };
