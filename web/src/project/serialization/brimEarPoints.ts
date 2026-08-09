/**
 * Pinned BBS brim-ear point codec (P5.3.6).
 *
 * `Metadata/brim_ear_points.txt` as the pinned `bbs_3mf.cpp` writes and reads
 * it at `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`:
 *
 * ```text
 * brim_points_format_version=0
 * object_id=1|x y z r x y z r
 * ```
 *
 * The object ID is the writer's 1-based position in `model.objects`, values are
 * `%f` (six decimals), and version 0 reads points in groups of four. Upstream
 * skips a malformed line and records an error rather than aborting the archive;
 * this port surfaces the same lines as typed warnings so nothing is dropped
 * silently.
 */

import type { BrimEarPoint } from '../domain/model';

export const BRIM_EAR_POINTS_PATH = 'Metadata/brim_ear_points.txt';

/** Pinned `brim_points_format_version`. */
export const BRIM_EAR_POINTS_FORMAT_VERSION = 0;

const VERSION_KEY = 'brim_points_format_version=';

export interface BrimEarObjectPoints {
  /** 1-based object index, exactly as the pinned writer emits it. */
  readonly objectId: number;
  readonly points: readonly BrimEarPoint[];
}

export interface BrimEarDecodeResult {
  readonly version: number;
  readonly objects: readonly BrimEarObjectPoints[];
  /** Lines the pinned reader would have logged an error for and skipped. */
  readonly warnings: readonly string[];
}

/** Serialize to the exact pinned text, or `undefined` when nothing is placed. */
export function encodeBrimEarPoints(objects: readonly BrimEarObjectPoints[]): string | undefined {
  const lines: string[] = [];
  for (const entry of objects) {
    if (entry.points.length === 0) continue;
    if (!Number.isSafeInteger(entry.objectId) || entry.objectId < 1) {
      throw new Error(`Brim-ear object id ${entry.objectId} must be a positive integer`);
    }
    const values = entry.points
      .map((point) => {
        for (const value of [...point.positionMm, point.headFrontRadiusMm]) {
          if (!Number.isFinite(value)) throw new Error('Brim-ear coordinates and radius must be finite');
        }
        if (point.headFrontRadiusMm <= 0) throw new Error('A brim ear needs a positive front radius');
        return [...point.positionMm, point.headFrontRadiusMm].map(formatFloat).join(' ');
      })
      .join(' ');
    lines.push(`object_id=${entry.objectId}|${values}`);
  }
  if (lines.length === 0) return undefined;
  return `${VERSION_KEY}${BRIM_EAR_POINTS_FORMAT_VERSION}\n${lines.join('\n')}\n`;
}

export function decodeBrimEarPoints(text: string): BrimEarDecodeResult {
  const warnings: string[] = [];
  let body = text;
  // The pinned reader pops exactly one trailing newline before splitting.
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const lines = body.split('\n');

  let version = 0;
  if (lines.length > 0 && lines[0].includes(VERSION_KEY)) {
    const parsed = Number.parseInt(lines[0].slice(lines[0].indexOf(VERSION_KEY) + VERSION_KEY.length), 10);
    version = Number.isFinite(parsed) ? parsed : 0;
    lines.shift();
  }

  const objects: BrimEarObjectPoints[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    if (line.trim() === '') continue;
    const parts = line.split('|');
    if (parts.length !== 2) {
      warnings.push(`Error while reading object data: ${bounded(line)}`);
      continue;
    }
    const idParts = parts[0].split('=');
    if (idParts.length !== 2) {
      warnings.push(`Error while reading object id: ${bounded(parts[0])}`);
      continue;
    }
    const objectId = Number.parseInt(idParts[1], 10);
    if (!Number.isFinite(objectId) || objectId === 0) {
      warnings.push(`Found invalid object id: ${bounded(idParts[1])}`);
      continue;
    }
    if (seen.has(objectId)) {
      warnings.push(`Found duplicated brim ear points for object ${objectId}`);
      continue;
    }
    seen.add(objectId);

    if (version !== BRIM_EAR_POINTS_FORMAT_VERSION) {
      // A future layout is not guessed at; the whole object is reported.
      warnings.push(`Unsupported brim_points_format_version ${version} for object ${objectId}`);
      continue;
    }
    const raw = parts[1].split(' ');
    const points: BrimEarPoint[] = [];
    for (let index = 0; index + 3 < raw.length; index += 4) {
      const values = raw.slice(index, index + 4).map((value) => Number.parseFloat(value));
      if (!values.every(Number.isFinite)) {
        warnings.push(`Skipped a non-finite brim ear on object ${objectId}`);
        continue;
      }
      points.push({
        positionMm: [values[0], values[1], values[2]],
        headFrontRadiusMm: values[3],
      });
    }
    if (raw.length % 4 !== 0) {
      warnings.push(`Object ${objectId} has ${raw.length % 4} trailing brim-ear value(s) that do not form a point`);
    }
    if (points.length > 0) objects.push({ objectId, points });
  }
  return Object.freeze({
    version,
    objects: Object.freeze(objects.map((entry) => Object.freeze({ ...entry, points: Object.freeze(entry.points) }))),
    warnings: Object.freeze(warnings),
  });
}

/** `%f` — always six decimals, matching the pinned `sprintf`. */
function formatFloat(value: number): string {
  return value.toFixed(6);
}

function bounded(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
