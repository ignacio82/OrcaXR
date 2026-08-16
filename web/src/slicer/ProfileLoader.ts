/**
 * OrcaSlicer profile loader — TypeScript port of the Android app's
 * OrcaProfileLoader.kt. Reads the bundled profile JSONs (machine /
 * process / filament trees with `inherits` chains) and flattens them
 * into the flat string map libslic3r's `set_deserialize_nothrow`
 * consumes. Key filtering (META_KEYS skip + SAFE_KEYS whitelist)
 * mirrors the Android implementation — see profileKeys.ts.
 */
import { serializePrintConfigArray } from '../settings/configSerialization';
import {
  PINNED_PRESET_SEMANTICS,
  PresetGraph,
  PresetGraphError,
  type PresetId,
  type PresetNode,
  type PresetSelectionRequest,
  type ResolvedPresetSelection,
} from '../settings/presets/PresetGraph';
import { META_KEYS, SAFE_KEYS } from './profileKeys';

export interface SlicerProfile {
  id: string;
  displayName: string;
  machineName: string;
  processName: string;
  filamentName: string;
  /** Full logical filament preset name before the compact picker label. */
  filamentPresetName?: string;
  /** Canonical graph identities; absent only on ad-hoc imported configs. */
  machinePresetId?: PresetId;
  processPresetId?: PresetId;
  filamentPresetId?: PresetId;
  config: Record<string, string>;
}

export interface ProfileCatalogDiagnostic {
  readonly code:
    | 'profile-corpus-pinned-overlay'
    | 'invalid-preset-graph'
    | 'no-compatible-process'
    | 'no-compatible-filament'
    | 'unresolved-compatibility';
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly machineName?: string;
  readonly processName?: string;
  readonly presetId?: PresetId;
}

export interface ProfileCatalogProvenance {
  readonly compatibilitySemanticsCommit: typeof PINNED_PRESET_SEMANTICS.commit;
  /**
   * Same-path profiles are exact Git blobs from the semantics pin; target
   * profiles absent upstream are separately SHA-256 locked by the profile
   * overlay gate.
   */
  readonly profileCorpus: 'pinned-v2.3.4-overlay-with-locked-adaptations';
}

export interface ProfileCatalogSelectionResolution {
  /** Present only when the requested printer exists in the validated graph. */
  readonly selection?: ResolvedPresetSelection;
  /** Actionable fail-closed reason when no selection can be resolved. */
  readonly unavailableReason?: string;
}

export class ProfileCatalogLoadError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly ProfileCatalogDiagnostic[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProfileCatalogLoadError';
  }
}

function str(v: unknown, key?: string): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return key === undefined ? v.map((x) => `${x}`).join(',') : serializePrintConfigArray(key, v);
  if (typeof v === 'object') return JSON.stringify(v);
  return `${v}`;
}

function flatten(node: PresetNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.effective)) {
    if (META_KEYS.has(key)) continue;
    if (!SAFE_KEYS.has(key)) continue;
    out[key] = str(value, key);
  }
  return out;
}

export class ProfileCatalog {
  profiles: readonly SlicerProfile[] = Object.freeze([]);
  diagnostics: readonly ProfileCatalogDiagnostic[] = Object.freeze([]);
  readonly provenance: ProfileCatalogProvenance = Object.freeze({
    compatibilitySemanticsCommit: PINNED_PRESET_SEMANTICS.commit,
    profileCorpus: 'pinned-v2.3.4-overlay-with-locked-adaptations',
  });
  private graph?: PresetGraph;
  private raw?: unknown;
  /**
   * Applied to the fetched corpus before it is compiled, so the operator's own
   * installation and authored presets are part of what "the catalog" means
   * everywhere downstream (P6.4). Kept as a hook rather than a constructor
   * argument because the library is built from the corpus this fetch returns.
   */
  compose: ((catalog: unknown) => unknown) | null = null;

  static fromRaw(catalog: unknown): ProfileCatalog {
    const result = new ProfileCatalog();
    result.replaceFromRaw(catalog);
    return result;
  }

  /** The exact corpus as fetched, before composition. */
  get rawCatalog(): unknown {
    return this.raw;
  }

  /**
   * Recompile the last fetched corpus through the current composer. Returns
   * false when there is nothing loaded to recompose.
   */
  recompose(): boolean {
    if (this.raw === undefined) return false;
    this.replaceFromRaw(this.compose ? this.compose(this.raw) : this.raw, this.raw);
    return true;
  }

  async load(): Promise<void> {
    // Single bundled catalog: one fetch, and no per-file URLs — vite's dev
    // middleware serves the SPA fallback for filenames containing '@'
    // (every process/filament profile), which silently gutted profiles.
    let catalog: unknown;
    try {
      const baseUrl = import.meta.env.BASE_URL;
      const url = baseUrl.endsWith('/') ? `${baseUrl}profiles/catalog.json` : `${baseUrl}/profiles/catalog.json`;
      const cacheBustUrl = `${url}?t=${Date.now()}`;
      const r = await fetch(cacheBustUrl, { cache: 'no-store' });
      if (!r.ok) {
        console.error(`[orcaxr] failed to fetch catalog: HTTP ${r.status}`);
        return;
      }
      catalog = await r.json();
    } catch (e) {
      console.error('[orcaxr] failed to fetch catalog (network/parse error)', e);
      return;
    }
    try {
      this.replaceFromRaw(this.compose ? this.compose(catalog) : catalog, catalog);
      const blocking = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      if (blocking.length > 0) {
        console.error(
          `[orcaxr] omitted incompatible profile combinations (${blocking.length} catalog diagnostics)`,
          blocking,
        );
      }
      console.warn(`[orcaxr] ${this.diagnostics[0]?.message ?? 'Profile corpus provenance is unverified.'}`);
    } catch (error) {
      console.error('[orcaxr] profile catalog failed compatibility validation', error);
    }
  }

  /**
   * Atomically replace the catalog after the complete graph validates. A bad
   * replacement never exposes a partial Cartesian product or mutates the last
   * known-good catalog.
   *
   * `source` is the pre-composition corpus to remember for a later
   * {@link recompose}; it defaults to the catalog itself.
   */
  replaceFromRaw(catalog: unknown, source: unknown = catalog): void {
    let graph: PresetGraph;
    try {
      graph = PresetGraph.build(catalog);
    } catch (error) {
      const diagnostics = graphErrorDiagnostics(error);
      throw new ProfileCatalogLoadError('Profile catalog failed canonical graph validation', diagnostics, {
        cause: error,
      });
    }
    const compiled = compileProfiles(graph);
    this.raw = source;
    this.graph = graph;
    this.profiles = Object.freeze(compiled.profiles);
    this.diagnostics = Object.freeze(compiled.diagnostics);
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

  /**
   * Explain why a requested triple is unavailable without guessing a
   * replacement. UI surfaces can present this message before invoking
   * `find`, while legacy callers keep the existing nullable contract.
   */
  explainUnavailable(machine: string, process: string, filament: string): string | null {
    if (this.find(machine, process, filament)) return null;
    const graph = this.graph;
    if (!graph) return 'The profile catalog has not loaded or failed validation.';
    const machineNode = findNode(graph.selectable('machine'), machine);
    if (!machineNode) return `Unknown printer profile ${JSON.stringify(machine)}.`;
    const compatibleProcesses = graph.compatibleProcesses(machineNode.id);
    const processNode = process.trim() ? findNode(graph.selectable('process'), process) : compatibleProcesses[0];
    if (!processNode) return `Unknown process profile ${JSON.stringify(process)} for ${machineNode.name}.`;
    if (!compatibleProcesses.some((candidate) => candidate.id === processNode.id)) {
      return `${processNode.name} is not compatible with ${machineNode.name}.`;
    }
    const compatibleFilaments = graph.compatibleFilaments(machineNode.id, processNode.id);
    const filamentNode = filament.trim() ? findNode(graph.selectable('filament'), filament) : compatibleFilaments[0];
    if (!filamentNode) return `Unknown filament profile ${JSON.stringify(filament)} for ${machineNode.name}.`;
    if (!compatibleFilaments.some((candidate) => candidate.id === filamentNode.id)) {
      return `${filamentNode.name} is not compatible with ${machineNode.name} and ${processNode.name}.`;
    }
    return 'The requested profile combination is unavailable.';
  }

  /**
   * Reconcile one printer/process/multi-filament request using the pinned
   * PresetGraph policy. The graph remains encapsulated and an unloaded or
   * stale printer identity fails closed instead of exposing a guessed profile.
   */
  reconcileSelection(request: PresetSelectionRequest): ProfileCatalogSelectionResolution {
    const graph = this.graph;
    if (!graph) {
      return Object.freeze({
        unavailableReason: 'The profile catalog has not loaded or failed validation.',
      });
    }
    try {
      return Object.freeze({ selection: graph.resolveSelection(request) });
    } catch {
      return Object.freeze({
        unavailableReason: 'The selected printer preset is no longer available in the validated profile catalog.',
      });
    }
  }
}

function compileProfiles(graph: PresetGraph): {
  profiles: SlicerProfile[];
  diagnostics: ProfileCatalogDiagnostic[];
} {
  const profiles: SlicerProfile[] = [];
  const diagnostics: ProfileCatalogDiagnostic[] = [
    {
      code: 'profile-corpus-pinned-overlay',
      severity: 'warning',
      message:
        'Profile corpus uses exact same-path blobs from the pinned engine tree plus SHA-256-locked OrcaXR target-printer adaptations.',
    },
  ];

  for (const machine of graph.selectable('machine')) {
    const processes: PresetNode[] = [];
    for (const process of graph.selectable('process')) {
      const assessment = graph.assessPrinterCompatibility(process.id, machine.id);
      if (assessment.status === 'compatible') {
        processes.push(process);
      } else if (assessment.status === 'unresolved') {
        diagnostics.push({
          code: 'unresolved-compatibility',
          severity: 'error',
          presetId: process.id,
          machineName: machine.name,
          processName: process.name,
          message:
            `Compatibility for process ${process.name} on ${machine.name} depends on an engine expression ` +
            'that the browser catalog cannot evaluate.',
        });
      }
    }
    if (processes.length === 0) {
      diagnostics.push({
        code: 'no-compatible-process',
        severity: 'error',
        machineName: machine.name,
        message: `${machine.name} has no visible compatible process preset in the installed profile corpus.`,
      });
      continue;
    }

    const machineConfig = flatten(machine);
    for (const process of processes) {
      const filaments: PresetNode[] = [];
      for (const filament of graph.selectable('filament')) {
        const printerAssessment = graph.assessPrinterCompatibility(filament.id, machine.id);
        const printAssessment =
          printerAssessment.status === 'compatible'
            ? graph.assessPrintCompatibility(filament.id, process.id, machine.id)
            : undefined;
        if (printerAssessment.status === 'compatible' && printAssessment?.status === 'compatible') {
          filaments.push(filament);
        } else if (printerAssessment.status === 'unresolved' || printAssessment?.status === 'unresolved') {
          diagnostics.push({
            code: 'unresolved-compatibility',
            severity: 'error',
            presetId: filament.id,
            machineName: machine.name,
            processName: process.name,
            message:
              `Compatibility for filament ${filament.name} with ${machine.name} / ${process.name} ` +
              'depends on an engine expression that the browser catalog cannot evaluate.',
          });
        }
      }
      if (filaments.length === 0) {
        diagnostics.push({
          code: 'no-compatible-filament',
          severity: 'error',
          machineName: machine.name,
          processName: process.name,
          message:
            `${machine.name} / ${process.name} has no visible compatible filament preset in the installed ` +
            'profile corpus.',
        });
        continue;
      }

      const processConfig = flatten(process);
      for (const filament of filaments) {
        const filamentConfig = flatten(filament);
        const processShort = process.name.split('@')[0].trim();
        const filamentShort = filament.name.split('@')[0].trim();
        profiles.push(
          Object.freeze({
            id: `${machine.name}|${process.name}|${filament.name}`,
            displayName: `${machine.name} · ${processShort} · ${filamentShort}`,
            machineName: machine.name,
            processName: process.name,
            filamentName: filamentShort,
            filamentPresetName: filament.name,
            machinePresetId: machine.id,
            processPresetId: process.id,
            filamentPresetId: filament.id,
            config: Object.freeze({ ...machineConfig, ...processConfig, ...filamentConfig }),
          }),
        );
      }
    }
  }
  return {
    profiles,
    diagnostics: deduplicateDiagnostics(diagnostics),
  };
}

function graphErrorDiagnostics(error: unknown): ProfileCatalogDiagnostic[] {
  if (!(error instanceof PresetGraphError)) {
    return [
      {
        code: 'invalid-preset-graph',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Profile catalog is not valid JSON preset data.',
      },
    ];
  }
  return error.issues.map((issue) => ({
    code: 'invalid-preset-graph',
    severity: 'error',
    message: `${issue.path}: ${issue.message}`,
  }));
}

function deduplicateDiagnostics(diagnostics: readonly ProfileCatalogDiagnostic[]): ProfileCatalogDiagnostic[] {
  const unique = new Map<string, ProfileCatalogDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.machineName ?? '',
      diagnostic.processName ?? '',
      diagnostic.presetId ?? '',
    ].join('|');
    unique.set(key, Object.freeze({ ...diagnostic }));
  }
  return [...unique.values()];
}

function findNode(nodes: readonly PresetNode[], query: string): PresetNode | undefined {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (!normalized) return nodes[0];
  return (
    nodes.find((node) => node.name.toLocaleLowerCase('en-US') === normalized) ??
    nodes.find((node) => node.name.toLocaleLowerCase('en-US').includes(normalized))
  );
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
