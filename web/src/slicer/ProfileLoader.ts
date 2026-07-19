/**
 * OrcaSlicer profile loader — TypeScript port of the Android app's
 * OrcaProfileLoader.kt. Reads the bundled profile JSONs (machine /
 * process / filament trees with `inherits` chains) and flattens them
 * into the flat string map libslic3r's `set_deserialize_nothrow`
 * consumes. Key filtering (META_KEYS skip + SAFE_KEYS whitelist)
 * mirrors the Android implementation — see profileKeys.ts.
 */
import { serializePrintConfigArray } from '../settings/configSerialization';
import { MAX_INHERITANCE_DEPTH, META_KEYS, SAFE_KEYS } from './profileKeys';

type ProfileJson = Record<string, unknown>;

export interface SlicerProfile {
  id: string;
  displayName: string;
  machineName: string;
  processName: string;
  filamentName: string;
  config: Record<string, string>;
}

interface Catalog {
  [brand: string]: {
    machine: ProfileJson[];
    process: ProfileJson[];
    filament: ProfileJson[];
  };
}

function str(v: unknown, key?: string): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return key === undefined ? v.map((x) => `${x}`).join(',') : serializePrintConfigArray(key, v);
  if (typeof v === 'object') return JSON.stringify(v);
  return `${v}`;
}

function leavesOf(jsons: ProfileJson[]): ProfileJson[] {
  // OrcaSlicer semantics: `instantiation` decides user-visible presets.
  // Being inherited-FROM does not disqualify — the ECC "0.4 nozzle"
  // machine is the base the other nozzle sizes inherit from AND a real
  // preset (instantiation: "true"). Only fall back to parent-exclusion
  // for profiles that don't declare the flag at all.
  const parentNames = new Set(jsons.map((j) => str(j.inherits)).filter((s) => s.length > 0));
  return jsons.filter((j) => {
    const name = str(j.name);
    if (!name) return false;
    const inst = j.instantiation;
    if (inst !== undefined) return str(inst) !== 'false';
    return !parentNames.has(name);
  });
}

function flatten(leaf: ProfileJson, byName: Map<string, ProfileJson>): Record<string, string> {
  const chain: ProfileJson[] = [];
  let current: ProfileJson | undefined = leaf;
  let depth = 0;
  while (current && depth < MAX_INHERITANCE_DEPTH) {
    chain.push(current);
    const parent = str(current.inherits);
    current = parent ? byName.get(parent) : undefined;
    depth += 1;
  }
  const out: Record<string, string> = {};
  for (const json of chain.reverse()) {
    for (const [key, value] of Object.entries(json)) {
      if (META_KEYS.has(key)) continue;
      if (!SAFE_KEYS.has(key)) continue;
      out[key] = str(value, key);
    }
  }
  return out;
}

export class ProfileCatalog {
  profiles: SlicerProfile[] = [];

  async load(): Promise<void> {
    // Single bundled catalog: one fetch, and no per-file URLs — vite's dev
    // middleware serves the SPA fallback for filenames containing '@'
    // (every process/filament profile), which silently gutted profiles.
    let catalog: Catalog | null = null;
    try {
      const baseUrl = import.meta.env.BASE_URL;
      const url = baseUrl.endsWith('/') ? `${baseUrl}profiles/catalog.json` : `${baseUrl}/profiles/catalog.json`;
      const cacheBustUrl = `${url}?t=${Date.now()}`;
      const r = await fetch(cacheBustUrl, { cache: 'no-store' });
      if (r.ok) catalog = (await r.json()) as Catalog;
      else console.error(`[orcaxr] failed to fetch catalog: HTTP ${r.status}`);
    } catch (e) {
      console.error('[orcaxr] failed to fetch catalog (network/parse error)', e);
      return;
    }
    if (!catalog) return;
    for (const cats of Object.values(catalog)) {
      const machines = cats.machine ?? [];
      const processes = cats.process ?? [];
      const filaments = cats.filament ?? [];
      const byName = new Map<string, ProfileJson>();
      for (const j of [...machines, ...processes, ...filaments]) {
        const name = str(j.name);
        if (name) byName.set(name, j);
      }
      for (const machine of leavesOf(machines)) {
        const machineCfg = flatten(machine, byName);
        for (const process of leavesOf(processes)) {
          const processCfg = flatten(process, byName);
          for (const filament of leavesOf(filaments)) {
            const filamentCfg = flatten(filament, byName);
            const machineName = str(machine.name);
            const processName = str(process.name);
            const filamentName = str(filament.name);
            const processShort = processName.split('@')[0].trim();
            const filamentShort = filamentName.split('@')[0].trim();
            this.profiles.push({
              id: `${machineName}|${processName}|${filamentName}`,
              displayName: `${machineName} · ${processShort} · ${filamentShort}`,
              machineName,
              processName,
              filamentName: filamentShort,
              config: { ...machineCfg, ...processCfg, ...filamentCfg },
            });
          }
        }
      }
    }
  }

  /** First profile whose parts all substring-match (case-insensitive). */
  find(machine: string, process: string, filament: string): SlicerProfile | null {
    const m = machine.toLowerCase();
    const p = process.toLowerCase();
    const f = filament.toLowerCase();
    return (
      this.profiles.find(
        (x) =>
          x.machineName.toLowerCase().includes(m) &&
          x.processName.toLowerCase().includes(p) &&
          x.filamentName.toLowerCase().includes(f),
      ) ?? null
    );
  }
}

/** Bed size (mm) from a flattened profile's printable_area polygon. */
export function bedSizeFromProfile(config: Record<string, string>): {
  x: number;
  y: number;
} {
  const pa = config['printable_area'];
  if (!pa) return { x: 200, y: 200 };
  let maxX = 0;
  let maxY = 0;
  for (const pt of pa.split(',')) {
    const [x, y] = pt.split('x').map(Number);
    if (Number.isFinite(x)) maxX = Math.max(maxX, x);
    if (Number.isFinite(y)) maxY = Math.max(maxY, y);
  }
  return { x: maxX || 200, y: maxY || 200 };
}
