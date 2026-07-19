/**
 * ConfigIO — serialise / parse an OrcaXR printer+process+filament config bundle
 * (Snapmaker Orca's Import / Export Config). Export writes a self-describing JSON
 * wrapper around the flat `config` map the slicer consumes; parse accepts that
 * wrapper OR a plain flat Orca-style `{key: value}` config (best-effort).
 *
 * Pure text-in / text-out so the format is unit-testable without a workspace.
 */

import { serializePrintConfigArray } from '../settings/configSerialization';

export interface ConfigBundle {
  machineName: string;
  processName: string;
  filamentName: string;
  /** Flat slicer config: every value a string (vectors already joined). */
  config: Record<string, string>;
}

/** Coerce an arbitrary object into a flat string map using PrintConfig wire types. */
function normalize(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) out[k] = serializePrintConfigArray(k, v);
    else if (v !== null && v !== undefined && typeof v !== 'object') out[k] = String(v);
  }
  return out;
}

export function exportConfigJson(b: ConfigBundle): string {
  return JSON.stringify(
    {
      orcaxr_config: 1,
      machineName: b.machineName,
      processName: b.processName,
      filamentName: b.filamentName,
      config: b.config,
    },
    null,
    2,
  );
}

export function parseConfigJson(text: string): ConfigBundle | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  // OrcaXR wrapper format: an explicit `config` sub-object.
  if (o.config && typeof o.config === 'object' && !Array.isArray(o.config)) {
    const config = normalize(o.config as Record<string, unknown>);
    if (Object.keys(config).length === 0) return null;
    return {
      machineName: String(o.machineName ?? 'Imported'),
      processName: String(o.processName ?? 'Imported'),
      filamentName: String(o.filamentName ?? 'Imported'),
      config,
    };
  }

  // Plain flat Orca-style config: the whole object is the config map.
  const flat = normalize(o);
  if (Object.keys(flat).length === 0) return null;
  return { machineName: 'Imported', processName: 'Imported', filamentName: 'Imported', config: flat };
}
