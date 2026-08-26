/**
 * The thumbnail block a printer's display reads, and where it goes.
 *
 * A sliced file carries a picture of what it prints, and every screen between
 * the operator and the machine shows it: the printer's own display, Fluidd,
 * Mainsail, the file list on the SD card. OrcaXR's G-code carried none, so a
 * Snapmaker U1 fell back to its stock image and every print looked like every
 * other print.
 *
 * The reason is structural rather than a missing line of code. `GCode.cpp` only
 * writes thumbnails when it is handed a `thumbnail_cb`, and that callback is
 * the *GUI* rendering the plate offscreen — `libslic3r` cannot draw the scene,
 * it has never seen it. The WASM build has no GUI, so the callback is null and
 * the branch is skipped. The picture has to come from whoever owns the scene,
 * which in this app is the browser.
 *
 * So this module is the other half of that callback: the exact bytes the engine
 * would have written, given an image somebody else rendered. Two things are
 * ported from the pinned engine and must stay faithful to it, because a printer
 * parses this by pattern and a near-miss shows nothing at all:
 *
 *  - {@link parseThumbnailList} is `GCodeThumbnails::make_and_check_thumbnail_list`
 *    (`src/libslic3r/GCode/Thumbnails.cpp`) — the `WxH/EXT, WxH/EXT` grammar,
 *    its `0 < size < 1000` bounds, and PNG as the default extension.
 *  - {@link encodeThumbnailBlock} is `GCodeThumbnails::export_thumbnails_to_file`
 *    (`Thumbnails.hpp`) — the `THUMBNAIL_BLOCK_START` wrapper, the
 *    `; thumbnail begin WxH <base64 length>` header, the 78-character rows, and
 *    the tag per format (`thumbnail` for PNG, `thumbnail_JPG` for JPEG).
 *
 * {@link injectGcodeThumbnails} then puts the blocks exactly where `GCode.cpp`
 * puts them: after `HEADER_BLOCK_END` and before the extrusion-width comments,
 * which is the same position the desktop writes for a non-BBL printer.
 */

/** The image formats this app can actually produce from a canvas. */
export type GcodeThumbnailFormat = 'PNG' | 'JPG';

export interface GcodeThumbnailRequest {
  readonly width: number;
  readonly height: number;
  readonly format: GcodeThumbnailFormat;
}

/** What a `thumbnails` value asked for that could not be honoured. */
export interface GcodeThumbnailListProblem {
  readonly entry: string;
  readonly reason: 'invalid' | 'out-of-range' | 'unsupported-format';
}

export interface GcodeThumbnailList {
  readonly requests: readonly GcodeThumbnailRequest[];
  /** Stated rather than swallowed: an unread thumbnail is a blank display. */
  readonly problems: readonly GcodeThumbnailListProblem[];
}

/** The engine's own bound: `0 < size < 1000` on both axes. */
const MAX_DIMENSION = 1000;

/** `; ` plus 78 base64 characters per row, exactly as the engine wraps them. */
const MAX_ROW_LENGTH = 78;

const FORMAT_TAGS: Readonly<Record<GcodeThumbnailFormat, string>> = {
  PNG: 'thumbnail',
  JPG: 'thumbnail_JPG',
};

/**
 * Parse a `thumbnails` config value.
 *
 * Accepts the two shapes the corpus actually holds: the Snapmaker U1's string
 * `'48x48/PNG, 300x300/PNG'` and the Elegoo Centauri's vector `['144x144']`.
 * An entry with no `/EXT` is PNG, which is what the engine defaults to.
 *
 * Formats the engine supports but a browser canvas cannot produce — QOI,
 * BTT_TFT, ColPic — are reported as `unsupported-format` rather than quietly
 * emitted as a PNG under someone else's tag, which would be a block the printer
 * reads, decodes as garbage, and draws as nothing.
 */
export function parseThumbnailList(value: unknown): GcodeThumbnailList {
  const entries = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const requests: GcodeThumbnailRequest[] = [];
  const problems: GcodeThumbnailListProblem[] = [];

  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = /^(\d+)\s*x\s*(\d+)(?:\s*\/\s*([A-Za-z_]+))?$/.exec(entry);
    if (!match) {
      problems.push({ entry, reason: 'invalid' });
      continue;
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!(width > 0) || width >= MAX_DIMENSION || !(height > 0) || height >= MAX_DIMENSION) {
      problems.push({ entry, reason: 'out-of-range' });
      continue;
    }
    const ext = (match[3] ?? 'PNG').toUpperCase();
    const format = ext === 'PNG' ? 'PNG' : ext === 'JPG' || ext === 'JPEG' ? 'JPG' : undefined;
    if (!format) {
      problems.push({ entry, reason: 'unsupported-format' });
      continue;
    }
    requests.push({ width, height, format });
  }

  return { requests, problems };
}

/**
 * One thumbnail, in the engine's own wire format.
 *
 * The odd-looking leading newline and bare `;` line are not decoration: they
 * are what `export_thumbnails_to_file` writes (`"\n;\n; %s begin %dx%d %d\n"`),
 * and the whole point of this module is to be byte-compatible with a file the
 * desktop produced.
 */
export function encodeThumbnailBlock(request: GcodeThumbnailRequest, image: Uint8Array): string {
  const encoded = base64(image);
  const tag = FORMAT_TAGS[request.format];
  const rows: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += MAX_ROW_LENGTH) {
    rows.push(`; ${encoded.slice(offset, offset + MAX_ROW_LENGTH)}\n`);
  }
  return (
    '; THUMBNAIL_BLOCK_START\n' +
    `\n;\n; ${tag} begin ${request.width}x${request.height} ${encoded.length}\n` +
    rows.join('') +
    `; ${tag} end\n` +
    '; THUMBNAIL_BLOCK_END\n\n'
  );
}

/** Where `GCode.cpp` writes the thumbnails: after the header, before the widths. */
const HEADER_BLOCK_END = '; HEADER_BLOCK_END\n';

/**
 * Put the blocks in the file.
 *
 * Inserted after `HEADER_BLOCK_END` and its blank line, which is the position
 * the engine writes them at for a non-BBL printer — the Snapmaker U1 and the
 * Elegoo Centauri are both non-BBL, so this is the file layout their firmware
 * and Moonraker's metadata scanner have been looking at all along.
 *
 * G-code that already carries a thumbnail is returned untouched: a file sliced
 * by a build that grows its own thumbnails must not get a second set.
 */
export function injectGcodeThumbnails(gcode: string, blocks: readonly string[]): string {
  if (blocks.length === 0) return gcode;
  if (gcode.includes('; THUMBNAIL_BLOCK_START')) return gcode;
  const headerEnd = gcode.indexOf(HEADER_BLOCK_END);
  const payload = blocks.join('');
  if (headerEnd < 0) {
    // No header block to anchor to — a calibration or hand-written program.
    // The top of the file is still a place a parser looks, and prepending is
    // the one position that cannot land inside the executable block.
    return payload + gcode;
  }
  const insertAt = headerEnd + HEADER_BLOCK_END.length;
  const afterBlankLine = gcode.startsWith('\n', insertAt) ? insertAt + 1 : insertAt;
  return gcode.slice(0, afterBlankLine) + payload + gcode.slice(afterBlankLine);
}

/**
 * Base64, without assuming a DOM.
 *
 * `btoa` is a window global and this module is imported by the canonical slice
 * route, which runs in a worker and in Node under the test runner.
 */
function base64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  const encoder = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (encoder) return encoder(binary);
  return Buffer.from(bytes).toString('base64');
}
