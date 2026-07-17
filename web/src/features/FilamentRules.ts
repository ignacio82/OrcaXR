/**
 * Filament-vs-bed compatibility pre-flight — web port of Android
 * `FilamentRules.kt` (Snapmaker fork's FilamentHotBedNozzleRules).
 *
 * Loads the bundled `filament_hot_bed_nozzles.json` (byte-identical to the
 * fork's) and evaluates the project's filament types against the active
 * build plate. Substring, case-insensitive match: "PLA-CF"/"PLA Matte"
 * match PLA's support list. Forbidden beats Warning so the worse tier
 * surfaces. A malformed/absent asset collapses to EMPTY (never blocks).
 */

export type FilamentRuleResult =
  { kind: 'ok' } | { kind: 'warning'; message: string } | { kind: 'forbidden'; message: string };

export interface FilamentRules {
  supportByBed: Record<string, Set<string>>;
  warningByBed: Record<string, Set<string>>;
}

export const EMPTY_RULES: FilamentRules = { supportByBed: {}, warningByBed: {} };

const baseUrl = import.meta.env?.BASE_URL ?? '/';
const ASSET_PATH = baseUrl.endsWith('/')
  ? `${baseUrl}profiles/Snapmaker/filament/filament_hot_bed_nozzles.json`
  : `${baseUrl}/profiles/Snapmaker/filament/filament_hot_bed_nozzles.json`;
/** Parse the rules JSON. Tokens uppercased for case-insensitive substring match. */
export function parseFilamentRules(text: string): FilamentRules {
  const root = JSON.parse(text) as Record<string, unknown>;
  const support: Record<string, Set<string>> = {};
  const warning: Record<string, Set<string>> = {};
  for (const key of Object.keys(root)) {
    // Nozzle bands (keys ending "mm") need preset-name resolution — skip.
    if (key.toLowerCase().endsWith('mm')) continue;
    const obj = root[key];
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    const toSet = (arr: unknown): Set<string> | null => {
      if (!Array.isArray(arr)) return null;
      const set = new Set<string>();
      for (const v of arr) {
        const s = String(v ?? '')
          .trim()
          .toUpperCase();
        if (s) set.add(s);
      }
      return set.size ? set : null;
    };
    const s = toSet(rec['support']);
    if (s) support[key] = s;
    const w = toSet(rec['warning']);
    if (w) warning[key] = w;
  }
  return { supportByBed: support, warningByBed: warning };
}

/** Fetch + parse the bundled rules asset. Any failure → EMPTY_RULES. */
export async function loadFilamentRules(fetchImpl: typeof fetch = fetch): Promise<FilamentRules> {
  try {
    const res = await fetchImpl(ASSET_PATH);
    if (!res.ok) return EMPTY_RULES;
    return parseFilamentRules(await res.text());
  } catch {
    return EMPTY_RULES;
  }
}

/**
 * Map libslic3r's BedType display string (`curr_bed_type`) to a rule key.
 * Returns null for plates the rules don't enumerate (caller = "no opinion").
 */
export function bedKeyFor(currBedType: string | null | undefined): string | null {
  if (!currBedType || !currBedType.trim()) return null;
  const n = currBedType.trim();
  if (/PEI/i.test(n)) return 'btPEI';
  if (/Engineering/i.test(n) || /GESP/i.test(n)) return 'btGESP';
  return null;
}

/**
 * Evaluate [filamentTypes] against [rules] for [bedKey]. Forbidden wins
 * over Warning. Ok when bedKey is null, unknown, or all filaments supported.
 */
export function evaluateFilamentRules(
  rules: FilamentRules,
  bedKey: string | null,
  filamentTypes: string[],
): FilamentRuleResult {
  if (bedKey === null) return { kind: 'ok' };
  const support = rules.supportByBed[bedKey];
  if (!support) return { kind: 'ok' };
  const warningSet = rules.warningByBed[bedKey] ?? new Set<string>();

  const unsupported: string[] = [];
  const warned: string[] = [];
  for (const rawType of filamentTypes) {
    const ty = rawType.trim().toUpperCase();
    if (!ty) continue;
    const isSupport = [...support].some((token) => ty.includes(token));
    const isWarning = [...warningSet].some((token) => ty.includes(token));
    if (isWarning) warned.push(rawType);
    else if (!isSupport) unsupported.push(rawType);
  }
  if (unsupported.length) {
    return {
      kind: 'forbidden',
      message:
        `Filament ${unsupported.join(', ')} is not supported on the active ` +
        `build plate. Change the plate or pick a different filament before slicing.`,
    };
  }
  if (warned.length) {
    return {
      kind: 'warning',
      message:
        `Filament ${warned.join(', ')} may have poor adhesion on this build ` +
        `plate. Slicing is allowed but the print may need extra care (brim, ` +
        `glue, plate temperature).`,
    };
  }
  return { kind: 'ok' };
}
