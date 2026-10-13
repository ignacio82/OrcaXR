/**
 * The names the File menu's outputs are offered under: the sliced G-code a
 * single download hands over, each plate's G-code when every plate is
 * downloaded, a plate's toolpaths as OBJ, and the active configuration.
 * A plate's name keeps only `A–Z a–z 0–9 . _ -`; each run of anything else
 * (a UTF-16 surrogate pair is two units of one run) becomes one `_`.
 */

/** The single Download / Export G-code… file (`onDownloadGcode`). */
export const GCODE_DOWNLOAD_FILENAME = 'orcaxr.gcode';

/** File → Export Config…'s file. */
export const CONFIG_EXPORT_FILENAME = 'orcaxr_config.json';

function plateStem(plateName: string | undefined): string {
  return (plateName ?? 'plate').replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Download All Plates: one file per sliced plate, named after the plate (`plate` for one the project no longer has). */
export function plateGcodeFilename(plateName: string | undefined): string {
  return `${plateStem(plateName)}.gcode`;
}

/** File → Export Toolpaths as OBJ…: the active plate's toolpaths. */
export function toolpathObjFilename(plateName: string | undefined): string {
  return `${plateStem(plateName)}_toolpaths.obj`;
}
