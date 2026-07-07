/**
 * Bambu Studio → OrcaXR (Snapmaker U1) 3MF import translator — web port of
 * Android `bambu/BambuImportTranslator.kt`.
 *
 * A Bambu Studio 3MF shares libslic3r's config-key namespace but embeds
 * Bambu-Lab hardware/filament tunings that would clobber the user's U1
 * profile. Pure function: detects Bambu authorship, strips Bambu-specific
 * filament tunings (keeping object tunings), and emits per-slot U1 filament
 * profile suggestions + a banner. Non-Bambu 3MFs pass through unchanged.
 */

export interface Bambu3mfFingerprint {
  printerModel: string;
  printerSettingsId: string;
  filamentTypes: string[];
}

export interface BambuTranslateResult {
  translatedOverrides: Record<string, string>;
  wasBambu: boolean;
  droppedKeys: string[];
  filamentProfileSuggestion: string[];
  bannerText: string;
}

/** Filament-tuning keys dropped for a Bambu 3MF so the U1 profile wins. */
export const BAMBU_FILAMENT_TUNING_STRIP = new Set<string>([
  'filament_max_volumetric_speed',
  'filament_flow_ratio',
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
  'pressure_advance',
  'enable_pressure_advance',
  'slow_down_layer_time',
  'slow_down_min_speed',
  'fan_cooling_layer_time',
  'fan_min_speed',
  'fan_max_speed',
  'overhang_fan_speed',
  'overhang_fan_threshold',
]);

/** filament_type literal → U1 bundled filament profile id. */
export const FILAMENT_TYPE_TO_U1_PROFILE: Record<string, string> = {
  'PLA': 'Snapmaker PLA SnapSpeed @U1',
  'PLA+': 'Snapmaker PLA SnapSpeed @U1',
  'PLA-CF': 'Snapmaker PLA-CF',
  'PETG': 'Snapmaker PETG HF',
  'PETG-HF': 'Snapmaker PETG HF',
  'PETG-CF': 'Snapmaker PETG-CF',
  'ABS': 'Generic ABS',
  'ABS-GF': 'Generic ABS',
  'ASA': 'Snapmaker ASA U1',
  'ASA-CF': 'Snapmaker ASA U1',
  'TPU': 'Generic TPU',
  'TPU-95A': 'Generic TPU',
  'PC': 'Generic ABS',
  'PA': 'Generic ABS',
  'PA-CF': 'Generic ABS',
  'PVA': 'Generic PVA',
  'HIPS': 'Generic HIPS',
};

const BAMBU_SETTINGS_MARKERS = ['@BBL', '@P1S', '@P1P', '@A1', '@A1M', '@A1 Mini', '@X1', '@X1C', '@X1E', '@H2D'];

/** True iff the fingerprint looks Bambu Studio-authored (conservative). */
export function detectBambu(fp: Bambu3mfFingerprint): boolean {
  const model = fp.printerModel ?? '';
  const settings = fp.printerSettingsId ?? '';
  if (!model.trim() && !settings.trim()) return false;
  if (model.toLowerCase().startsWith('bambu lab')) return true;
  const s = settings.toLowerCase();
  return BAMBU_SETTINGS_MARKERS.some((m) => s.includes(m.toLowerCase()));
}

/** Strip "Bambu " prefix + trailing finish-marker so "BAMBU PLA MATTE" → "PLA". */
export function normalizeFilamentType(raw: string): string {
  if (!raw || !raw.trim()) return '';
  let s = raw.trim().replace(/"/g, '').toUpperCase();
  if (s.startsWith('BAMBU ')) s = s.slice('BAMBU '.length).trim();
  const finishMarkers = [' BASIC', ' MATTE', ' SILK', ' METAL', ' WOOD', ' SPARKLE',
    ' GLOW', ' TOUGH', ' AERO', ' ECO', ' PRO', ' HIGH SPEED'];
  for (const marker of finishMarkers) {
    if (s.endsWith(marker)) { s = s.slice(0, -marker.length).trim(); break; }
  }
  return s;
}

/** Run the translation pass. Non-Bambu → input unchanged, wasBambu=false. */
export function translateBambu(
  rawOverrides: Record<string, string>,
  fingerprint: Bambu3mfFingerprint,
  slotCount: number,
): BambuTranslateResult {
  if (!detectBambu(fingerprint)) {
    return {
      translatedOverrides: rawOverrides,
      wasBambu: false,
      droppedKeys: [],
      filamentProfileSuggestion: [],
      bannerText: '',
    };
  }

  const dropped: string[] = [];
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (BAMBU_FILAMENT_TUNING_STRIP.has(k)) { dropped.push(k); continue; }
    filtered[k] = v;
  }
  dropped.sort();

  let suggestions: string[] = [];
  if (slotCount > 0 && fingerprint.filamentTypes.length > 0) {
    suggestions = Array.from({ length: slotCount }, (_, i) => {
      const normalized = normalizeFilamentType(fingerprint.filamentTypes[i] ?? '');
      return FILAMENT_TYPE_TO_U1_PROFILE[normalized] ?? 'Generic PLA';
    });
  }

  const modelHint = fingerprint.printerModel.trim() || fingerprint.printerSettingsId.trim() || 'Bambu Studio';
  let banner = `Imported as Bambu Studio 3MF (${modelHint}).`;
  if (dropped.length) {
    banner += ` Dropped ${dropped.length} filament-tuning key${dropped.length !== 1 ? 's' : ''} so the active U1 profile wins.`;
  } else {
    banner += ' Using active U1 profile for machine + filament settings.';
  }

  return {
    translatedOverrides: filtered,
    wasBambu: true,
    droppedKeys: dropped,
    filamentProfileSuggestion: suggestions,
    bannerText: banner,
  };
}

/** Build a fingerprint from a parsed 3MF `project_settings.config` object. */
export function fingerprintFromConfig(config: Record<string, unknown>): Bambu3mfFingerprint {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    printerModel: str(config['printer_model']),
    printerSettingsId: str(config['printer_settings_id']),
    filamentTypes: arr(config['filament_type']),
  };
}
