/**
 * OrcaSlicer profile loader — TypeScript port of the Android app's
 * OrcaProfileLoader.kt. Reads the bundled profile JSONs (machine /
 * process / filament trees with `inherits` chains) and flattens them
 * into the flat string map libslic3r's `set_deserialize_nothrow`
 * consumes. Key filtering (META_KEYS skip + SAFE_KEYS whitelist)
 * mirrors the Android implementation — see profileKeys.ts.
 */
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

interface Manifest {
  [brand: string]: { machine: string[]; process: string[]; filament: string[] };
}

async function fetchJson(url: string): Promise<ProfileJson | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as ProfileJson;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => `${x}`).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return `${v}`;
}

function leavesOf(jsons: ProfileJson[]): ProfileJson[] {
  const parentNames = new Set(
    jsons.map((j) => str(j.inherits)).filter((s) => s.length > 0),
  );
  return jsons.filter((j) => {
    const name = str(j.name);
    return (
      name.length > 0 &&
      !parentNames.has(name) &&
      str(j.instantiation ?? 'true') !== 'false'
    );
  });
}

function flatten(
  leaf: ProfileJson,
  byName: Map<string, ProfileJson>,
): Record<string, string> {
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
      out[key] = str(value);
    }
  }
  return out;
}

export class ProfileCatalog {
  profiles: SlicerProfile[] = [];

  async load(): Promise<void> {
    const manifest = (await fetchJson('/profiles/manifest.json')) as Manifest | null;
    if (!manifest) return;
    for (const [brand, cats] of Object.entries(manifest)) {
      const load = (cat: 'machine' | 'process' | 'filament') =>
        Promise.all(
          (cats[cat] ?? []).map((f) =>
            fetchJson(`/profiles/${brand}/${cat}/${encodeURIComponent(f)}`),
          ),
        ).then((list) => list.filter((j): j is ProfileJson => j != null));

      const [machines, processes, filaments] = await Promise.all([
        load('machine'),
        load('process'),
        load('filament'),
      ]);
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
