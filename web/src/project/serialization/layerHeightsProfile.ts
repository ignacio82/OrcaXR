/**
 * `Metadata/layer_heights_profile.txt`, exactly as the pinned writer emits it.
 *
 * One line per object that has a profile: `object_id=<1-based>|z;h;z;h;…`,
 * every number `%f` — six decimals. Upstream skips any object whose profile is
 * shorter than four values or has an odd length, so a malformed profile is
 * simply absent rather than written out broken.
 */

export const LAYER_HEIGHTS_PROFILE_PATH = 'Metadata/layer_heights_profile.txt';

export interface LayerHeightsProfileEntry {
  /** One-based object index, matching the core model's object order. */
  readonly objectId: number;
  readonly profile: readonly number[];
}

export function encodeLayerHeightsProfile(entries: readonly LayerHeightsProfileEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    // The same guard the pinned exporter applies before writing a line.
    if (entry.profile.length < 4 || entry.profile.length % 2 !== 0) continue;
    if (!entry.profile.every((value) => Number.isFinite(value))) continue;
    lines.push(`object_id=${entry.objectId}|${entry.profile.map(formatNumber).join(';')}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export interface DecodedLayerHeightsProfile {
  readonly entries: readonly LayerHeightsProfileEntry[];
  readonly warnings: readonly string[];
}

export function decodeLayerHeightsProfile(text: string): DecodedLayerHeightsProfile {
  const entries: LayerHeightsProfileEntry[] = [];
  const warnings: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^object_id=(\d+)\|(.*)$/.exec(line);
    if (!match) {
      warnings.push(`Ignored a layer height profile line that is not object_id=<n>|<values>: ${truncate(line)}`);
      continue;
    }
    const objectId = Number(match[1]);
    const profile = match[2]
      .split(';')
      .filter((value) => value.trim() !== '')
      .map(Number);
    if (!Number.isSafeInteger(objectId) || objectId < 1) {
      warnings.push(`Ignored a layer height profile for an unusable object id ${match[1]}`);
      continue;
    }
    if (profile.length < 4 || profile.length % 2 !== 0 || !profile.every((value) => Number.isFinite(value))) {
      warnings.push(
        `Ignored the layer height profile for object ${objectId}: a profile is at least two finite z/height pairs`,
      );
      continue;
    }
    entries.push({ objectId, profile: Object.freeze(profile) });
  }
  return { entries: Object.freeze(entries), warnings: Object.freeze(warnings) };
}

/** Match the pinned `%f`: six decimals, always. */
function formatNumber(value: number): string {
  return value.toFixed(6);
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
