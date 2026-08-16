/**
 * Installed printers and user-authored presets (parity P6.4).
 *
 * `PresetGraph` answers "what does this catalog mean"; this module answers
 * "what did *this operator* install and author on top of it". The two are
 * deliberately separate: the system catalog is pinned engine data that nobody
 * may edit, while installation and custom presets are local state that has to
 * survive a reload, export to another browser, and outlive a catalog update.
 *
 * Three rules shape everything below.
 *
 * Installation is visibility, never deletion. A machine preset the operator did
 * not install is kept in the composed catalog with `instantiation: "false"`,
 * because Snapmaker's nozzle variants inherit from one another — dropping the
 * 0.4 mm profile because only 0.2 mm was installed would break the 0.2 mm
 * profile's parent chain and fail the whole graph. Hidden means unselectable,
 * not absent.
 *
 * A custom preset is an *overlay on a system base*, never a free-standing
 * config. It stores `inherits` plus the keys it changes, so upstream's
 * `direct-parent-name` compatibility rule (Preset.cpp:639-717) keeps a custom
 * printer compatible with everything its base was compatible with, and a
 * catalog update reaches it through inheritance instead of freezing it at the
 * version it was authored against.
 *
 * Every mutation is atomic and proven. A change is applied only after the
 * merged catalog rebuilds as a valid `PresetGraph`, so a rejected edit leaves
 * the previous state byte-identical rather than half-applied.
 *
 * Like `PresetGraph`, this module has no DOM, storage, network, or slicer
 * dependency; `PresetLibraryStore` binds it to a key/value store.
 */

import { fnv1a64Text } from '../../project/domain/canonical';
import {
  PINNED_PRESET_SEMANTICS,
  PresetGraph,
  PresetGraphError,
  presetId,
  type PresetCatalogInput,
  type PresetId,
  type PresetJsonObject,
  type PresetJsonValue,
  type PresetKind,
  type PresetNode,
} from './PresetGraph';

export const PRESET_LIBRARY_SCHEMA_VERSION = 1;
export const PRESET_BUNDLE_FORMAT = 'orcaxr.preset-bundle';

/**
 * Keys the library owns. A custom preset declares its identity and lineage
 * through the record, so accepting them as overrides would let a bundle rename
 * or re-parent itself behind the validator's back.
 */
export const RESERVED_PRESET_KEYS: readonly string[] = Object.freeze([
  'name',
  'type',
  'inherits',
  'from',
  'instantiation',
  'is_default',
  'setting_id',
]);

/** Kinds an operator may author. Upstream exposes exactly these three tabs. */
export const CUSTOM_PRESET_KINDS: readonly PresetKind[] = Object.freeze(['machine', 'process', 'filament']);

export type PresetProvenanceSource = 'user-derived' | 'imported';

export interface PresetLineage {
  readonly vendor: string;
  readonly kind: PresetKind;
  readonly name: string;
}

/**
 * Where a custom preset came from and what may be done with it. P6.4 requires
 * this to be explicit: an exported bundle that does not say what it inherits,
 * under what licence, and at which version cannot be reviewed by whoever
 * receives it.
 */
export interface PresetProvenance {
  readonly source: PresetProvenanceSource;
  readonly license: string;
  readonly version: string;
  readonly derivedFrom: PresetLineage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly note?: string;
}

export interface CustomPresetRecord {
  readonly vendor: string;
  readonly kind: PresetKind;
  readonly name: string;
  /** Name of the system (or earlier custom) preset this overlays. */
  readonly inherits: string;
  readonly overrides: PresetJsonObject;
  readonly provenance: PresetProvenance;
}

export interface InstalledPrinterSelection {
  readonly vendor: string;
  readonly model: string;
  /** Printer variants (nozzle diameters) installed for this model. */
  readonly variants: readonly string[];
}

export interface PresetLibraryState {
  readonly schemaVersion: number;
  /** Fingerprint of the system catalog this state was last reconciled against. */
  readonly catalogFingerprint: string;
  readonly installed: readonly InstalledPrinterSelection[];
  readonly customPresets: readonly CustomPresetRecord[];
}

export type PresetLibraryIssueCode =
  | 'invalid-state'
  | 'invalid-bundle'
  | 'unsupported-schema'
  | 'engine-mismatch'
  | 'unknown-printer-model'
  | 'unknown-printer-variant'
  | 'unknown-base-preset'
  | 'base-not-instantiable'
  | 'duplicate-preset-name'
  | 'reserved-key'
  | 'unknown-preset-key'
  | 'invalid-value'
  | 'invalid-provenance'
  | 'invalid-name'
  | 'unknown-preset'
  | 'dependent-preset'
  | 'graph-rejected'
  | 'nothing-installed';

export interface PresetLibraryIssue {
  readonly code: PresetLibraryIssueCode;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

export interface PresetLibraryResult {
  readonly ok: boolean;
  readonly issues: readonly PresetLibraryIssue[];
}

export interface PrinterVariantEntry {
  readonly variant: string;
  readonly presetName: string;
  readonly presetId: PresetId;
  readonly nozzleDiameter?: number;
  readonly installed: boolean;
}

export interface PrinterModelEntry {
  readonly vendor: string;
  readonly model: string;
  readonly variants: readonly PrinterVariantEntry[];
  readonly installed: boolean;
}

export interface PrinterInventory {
  readonly vendors: readonly string[];
  readonly models: readonly PrinterModelEntry[];
}

export interface CustomPresetDraft {
  readonly vendor?: string;
  readonly kind: PresetKind;
  readonly name: string;
  readonly inherits: string;
  readonly overrides?: Readonly<Record<string, PresetJsonValue>>;
  readonly license?: string;
  readonly version?: string;
  readonly note?: string;
  readonly source?: PresetProvenanceSource;
}

export interface PresetCatalogUpdatePlan {
  readonly previousFingerprint: string;
  readonly nextFingerprint: string;
  readonly changed: boolean;
  readonly addedModels: readonly PresetLineage[];
  readonly removedModels: readonly PresetLineage[];
  readonly removedVariants: readonly PresetLineage[];
  readonly orphanedCustomPresets: readonly PresetLineage[];
  readonly issues: readonly PresetLibraryIssue[];
  readonly applicable: boolean;
}

export interface PresetBundle {
  readonly format: typeof PRESET_BUNDLE_FORMAT;
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly engine: { readonly repository: string; readonly commit: string };
  readonly catalogFingerprint: string;
  readonly installed: readonly InstalledPrinterSelection[];
  readonly customPresets: readonly CustomPresetRecord[];
}

/**
 * One library change requested by a surface.
 *
 * No panel edits the library directly. The DOM shell, an XR shell, and an
 * automation client all submit one of these through the action registry, so
 * every edit takes the same validated write path and produces the same issues.
 */
export type PresetLibraryOperation =
  | { readonly kind: 'install'; readonly vendor: string; readonly model: string; readonly variants: readonly string[] }
  | { readonly kind: 'create'; readonly draft: CustomPresetDraft }
  | {
      readonly kind: 'update';
      readonly vendor: string;
      readonly presetKind: PresetKind;
      readonly name: string;
      readonly draft: Partial<CustomPresetDraft>;
    }
  | { readonly kind: 'delete'; readonly vendor: string; readonly presetKind: PresetKind; readonly name: string }
  | { readonly kind: 'export' }
  | { readonly kind: 'import'; readonly bundle: string };

/**
 * Route one operation onto the library. Export changes nothing, so it succeeds
 * with no issues; the surface that asked for it owns handing the bytes over.
 */
export function applyPresetLibraryOperation(
  library: PresetLibrary,
  operation: PresetLibraryOperation,
): PresetLibraryResult {
  switch (operation.kind) {
    case 'install':
      return library.installPrinter(operation.vendor, operation.model, operation.variants);
    case 'create':
      return library.createCustomPreset(operation.draft);
    case 'update':
      return library.updateCustomPreset(operation.vendor, operation.presetKind, operation.name, operation.draft);
    case 'delete':
      return library.deleteCustomPreset(operation.vendor, operation.presetKind, operation.name);
    case 'import':
      return library.importBundle(operation.bundle);
    case 'export':
      return Object.freeze({ ok: true, issues: Object.freeze([]) });
  }
}

/** Default vendor for operator-authored presets; kept out of every pinned group. */
export const CUSTOM_PRESET_VENDOR = 'OrcaXR Custom';

const MAX_PRESET_NAME_LENGTH = 120;
const DEFAULT_LICENSE = 'All rights reserved (operator-authored)';
const DEFAULT_VERSION = '1.0.0';

export interface PresetLibraryClock {
  now(): string;
}

const SYSTEM_CLOCK: PresetLibraryClock = {
  now: () => new Date().toISOString(),
};

export function emptyPresetLibraryState(catalogFingerprint = ''): PresetLibraryState {
  return Object.freeze({
    schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
    catalogFingerprint,
    installed: Object.freeze([]),
    customPresets: Object.freeze([]),
  });
}

export class PresetLibrary {
  readonly systemGraph: PresetGraph;
  readonly catalogFingerprint: string;
  private readonly systemCatalog: PresetCatalogInput;
  private readonly allowedKeysByKind: ReadonlyMap<PresetKind, ReadonlySet<string>>;
  private readonly clock: PresetLibraryClock;
  private current: PresetLibraryState;
  private composedGraph: PresetGraph;

  private constructor(
    systemCatalog: PresetCatalogInput,
    systemGraph: PresetGraph,
    state: PresetLibraryState,
    clock: PresetLibraryClock,
  ) {
    this.systemCatalog = systemCatalog;
    this.systemGraph = systemGraph;
    this.clock = clock;
    this.catalogFingerprint = fingerprintGraph(systemGraph);
    this.allowedKeysByKind = allowedKeys(systemGraph);
    this.current = state;
    this.composedGraph = PresetGraph.build(this.composeCatalog());
  }

  /**
   * Build a library over a pinned system catalog. A malformed catalog throws
   * (`PresetGraphError`) exactly as `ProfileCatalog` does; malformed *local*
   * state never throws — it is reported and replaced with an empty library, so
   * one bad write cannot lock an operator out of their own printers.
   */
  static create(
    systemCatalog: unknown,
    options: { readonly state?: unknown; readonly clock?: PresetLibraryClock } = {},
  ): { readonly library: PresetLibrary; readonly issues: readonly PresetLibraryIssue[] } {
    const graph = PresetGraph.build(systemCatalog);
    const catalog = systemCatalog as PresetCatalogInput;
    const clock = options.clock ?? SYSTEM_CLOCK;
    const fingerprint = fingerprintGraph(graph);
    if (options.state === undefined) {
      return {
        library: new PresetLibrary(catalog, graph, emptyPresetLibraryState(fingerprint), clock),
        issues: Object.freeze([]),
      };
    }
    const issues: PresetLibraryIssue[] = [];
    const parsed = parseLibraryState(options.state, issues);
    const library = new PresetLibrary(catalog, graph, emptyPresetLibraryState(fingerprint), clock);
    if (!parsed) return { library, issues: freezeIssues(issues) };
    // The pinned corpus ships with the build, so a fingerprint that no longer
    // matches means this setup was made against a different catalog — the one
    // moment "profile updates" is observable from inside the app. Anything the
    // new catalog cannot support is caught below; this says why.
    if (parsed.catalogFingerprint && parsed.catalogFingerprint !== fingerprint) {
      issues.push(
        issue(
          'engine-mismatch',
          '$.catalogFingerprint',
          'This setup was made against a different printer catalog. Anything the current catalog no longer ' +
            'offers is listed below and has not been kept.',
          'warning',
        ),
      );
    }
    // Deliberately asymmetric with `importBundle`, which passes its parse
    // issues into `applyState` and so refuses a bundle whole. Local state is
    // the operator's only copy: an unreadable custom preset is dropped and
    // reported, but it must not take their installed printers down with it.
    const applied = library.applyState(parsed, '$');
    if (!applied.ok) issues.push(...applied.issues);
    return { library, issues: freezeIssues(issues) };
  }

  get state(): PresetLibraryState {
    return this.current;
  }

  /** True once the operator has installed at least one printer variant. */
  isConfigured(): boolean {
    return this.current.installed.some((entry) => entry.variants.length > 0);
  }

  /** Vendors with at least one installed variant, or every vendor when unconfigured. */
  installedVendors(): readonly string[] {
    if (!this.isConfigured()) return Object.freeze([...new Set(this.systemGraph.list().map((n) => n.vendor))].sort());
    const vendors = new Set<string>();
    for (const entry of this.current.installed) {
      if (entry.variants.length > 0) vendors.add(entry.vendor);
    }
    for (const preset of this.current.customPresets) vendors.add(preset.vendor);
    return Object.freeze([...vendors].sort());
  }

  /**
   * Every printer the pinned catalog can install, grouped the way the operator
   * thinks about them: vendor, then model, then nozzle. Selection state is
   * included so a wizard never has to re-derive it.
   */
  inventory(): PrinterInventory {
    const installedIndex = this.installedIndex();
    const models = new Map<string, { vendor: string; model: string; variants: PrinterVariantEntry[] }>();
    for (const node of this.systemGraph.list('machine')) {
      if (!node.isSystem) continue;
      const model = optionalString(node.effective.printer_model);
      if (!model) continue;
      const variant = printerVariantOf(node);
      if (!variant) continue;
      const key = `${node.vendor}\u0000${model}`;
      const entry = models.get(key) ?? { vendor: node.vendor, model, variants: [] };
      if (entry.variants.some((candidate) => candidate.variant === variant)) continue;
      const nozzle = firstNumber(node.effective.nozzle_diameter);
      entry.variants.push(
        Object.freeze({
          variant,
          presetName: node.name,
          presetId: node.id,
          ...(nozzle === undefined ? {} : { nozzleDiameter: nozzle }),
          installed: installedIndex.get(key)?.has(variant) === true,
        }),
      );
      models.set(key, entry);
    }
    const ordered = [...models.values()]
      .sort(
        (left, right) => left.vendor.localeCompare(right.vendor, 'en') || left.model.localeCompare(right.model, 'en'),
      )
      .map((entry) =>
        Object.freeze({
          vendor: entry.vendor,
          model: entry.model,
          variants: Object.freeze(
            [...entry.variants].sort((left, right) => compareVariants(left.variant, right.variant)),
          ),
          installed: entry.variants.some((variant) => variant.installed),
        }),
      );
    return Object.freeze({
      vendors: Object.freeze([...new Set(ordered.map((entry) => entry.vendor))].sort()),
      models: Object.freeze(ordered),
    });
  }

  /**
   * Replace the installation set. An unknown model or variant is rejected
   * rather than dropped, so a stale bundle cannot quietly install less than it
   * claims.
   */
  setInstalled(selections: readonly InstalledPrinterSelection[]): PresetLibraryResult {
    const issues: PresetLibraryIssue[] = [];
    const normalized = this.normalizeInstalled(selections, '$.installed', issues);
    if (issues.some((issue) => issue.severity === 'error')) return failed(issues);
    return this.applyState({ ...this.current, installed: normalized }, '$.installed', issues);
  }

  /**
   * Install one model's variants, leaving every other model untouched. Clearing
   * the last variant is the same act as uninstalling the model, so it takes the
   * same route — otherwise unchecking the final nozzle in a wizard would slip
   * past the dependant check that `uninstallPrinter` enforces.
   */
  installPrinter(vendor: string, model: string, variants: readonly string[]): PresetLibraryResult {
    if (variants.length === 0) return this.uninstallPrinter(vendor, model);
    const others = this.current.installed.filter((entry) => entry.vendor !== vendor || entry.model !== model);
    return this.setInstalled([...others, { vendor, model, variants }]);
  }

  /**
   * Remove a model. A custom preset that inherits from one of its variants
   * would be orphaned, so the removal is refused and names the dependants.
   */
  uninstallPrinter(vendor: string, model: string): PresetLibraryResult {
    const removed = this.current.installed.filter((entry) => entry.vendor === vendor && entry.model === model);
    if (removed.length === 0) {
      return failed([issue('unknown-printer-model', `$.installed`, `${vendor} ${model} is not installed.`)]);
    }
    const removedPresetNames = new Set<string>();
    for (const entry of removed) {
      for (const variant of entry.variants) {
        const node = this.systemMachineFor(vendor, model, variant);
        if (node) removedPresetNames.add(node.name);
      }
    }
    const dependants = this.current.customPresets.filter((preset) => removedPresetNames.has(preset.inherits));
    if (dependants.length > 0) {
      return failed([
        issue(
          'dependent-preset',
          '$.customPresets',
          `${vendor} ${model} still has ${dependants.length} custom preset${dependants.length === 1 ? '' : 's'} ` +
            `derived from it (${dependants.map((preset) => preset.name).join(', ')}). Delete or re-base them first.`,
        ),
      ]);
    }
    return this.setInstalled(
      this.current.installed.filter((entry) => entry.vendor !== vendor || entry.model !== model),
    );
  }

  /** Preset names an operator may derive a new custom preset of this kind from. */
  basePresetsFor(
    kind: PresetKind,
    against: { readonly printerId?: PresetId; readonly processId?: PresetId } = {},
  ): readonly PresetNode[] {
    const selectable = this.composedGraph.selectable(kind);
    // Without a printer to judge against, every visible preset is on offer.
    // With one, only what that printer can actually use is: the pinned corpus
    // lists 68 selectable filaments and a Snapmaker accepts a fraction of them,
    // so an unfiltered list would let someone derive a preset the printer they
    // just installed can never select.
    const printerId = against.printerId;
    if (kind === 'machine' || !printerId || !this.composedGraph.list('machine').some((n) => n.id === printerId)) {
      return selectable;
    }
    if (kind === 'process') return this.composedGraph.compatibleProcesses(printerId);
    const processId = against.processId;
    if (processId && this.composedGraph.list('process').some((node) => node.id === processId)) {
      return this.composedGraph.compatibleFilaments(printerId, processId);
    }
    return Object.freeze(
      selectable.filter(
        (node) => this.composedGraph.assessPrinterCompatibility(node.id, printerId).status === 'compatible',
      ),
    );
  }

  customPresets(kind?: PresetKind): readonly CustomPresetRecord[] {
    return Object.freeze(this.current.customPresets.filter((preset) => kind === undefined || preset.kind === kind));
  }

  /** Create one operator-authored preset over a compatible, instantiable base. */
  createCustomPreset(draft: CustomPresetDraft): PresetLibraryResult {
    const issues: PresetLibraryIssue[] = [];
    const record = this.buildRecord(draft, undefined, issues);
    if (!record) return failed(issues);
    return this.applyState(
      { ...this.current, customPresets: [...this.current.customPresets, record] },
      '$.customPresets',
      issues,
    );
  }

  /**
   * Edit an existing custom preset. The identity keys are re-validated, so a
   * rename that collides, or a re-base onto a preset that would form a cycle,
   * fails before anything is written.
   */
  updateCustomPreset(
    vendor: string,
    kind: PresetKind,
    name: string,
    draft: Partial<CustomPresetDraft>,
  ): PresetLibraryResult {
    const index = this.current.customPresets.findIndex(
      (preset) => preset.vendor === vendor && preset.kind === kind && preset.name === name,
    );
    if (index < 0) {
      return failed([
        issue('unknown-preset', '$.customPresets', `No custom ${kind} preset named ${JSON.stringify(name)}.`),
      ]);
    }
    const existing = this.current.customPresets[index];
    const issues: PresetLibraryIssue[] = [];
    const merged: CustomPresetDraft = {
      vendor: draft.vendor ?? existing.vendor,
      kind: draft.kind ?? existing.kind,
      name: draft.name ?? existing.name,
      inherits: draft.inherits ?? existing.inherits,
      overrides: draft.overrides ?? existing.overrides,
      license: draft.license ?? existing.provenance.license,
      version: draft.version ?? existing.provenance.version,
      ...((draft.note ?? existing.provenance.note) ? { note: draft.note ?? existing.provenance.note } : {}),
      source: draft.source ?? existing.provenance.source,
    };
    const record = this.buildRecord(merged, existing, issues);
    if (!record) return failed(issues);
    const next = [...this.current.customPresets];
    next[index] = record;
    const dependants = this.current.customPresets.filter(
      (preset) => preset !== existing && preset.inherits === existing.name && record.name !== existing.name,
    );
    if (dependants.length > 0) {
      return failed([
        issue(
          'dependent-preset',
          '$.customPresets',
          `Renaming ${JSON.stringify(existing.name)} would orphan ${dependants
            .map((preset) => JSON.stringify(preset.name))
            .join(', ')}.`,
        ),
      ]);
    }
    return this.applyState({ ...this.current, customPresets: next }, '$.customPresets', issues);
  }

  deleteCustomPreset(vendor: string, kind: PresetKind, name: string): PresetLibraryResult {
    const existing = this.current.customPresets.find(
      (preset) => preset.vendor === vendor && preset.kind === kind && preset.name === name,
    );
    if (!existing) {
      return failed([
        issue('unknown-preset', '$.customPresets', `No custom ${kind} preset named ${JSON.stringify(name)}.`),
      ]);
    }
    const dependants = this.current.customPresets.filter(
      (preset) => preset !== existing && preset.inherits === name && preset.kind === kind,
    );
    if (dependants.length > 0) {
      return failed([
        issue(
          'dependent-preset',
          '$.customPresets',
          `${JSON.stringify(name)} is the base of ${dependants.map((preset) => JSON.stringify(preset.name)).join(', ')}.`,
        ),
      ]);
    }
    return this.applyState(
      { ...this.current, customPresets: this.current.customPresets.filter((preset) => preset !== existing) },
      '$.customPresets',
      [],
    );
  }

  /**
   * The catalog the rest of the app consumes: pinned system data, uninstalled
   * printers hidden rather than removed, and custom presets appended to their
   * vendor group.
   */
  composeCatalog(): PresetCatalogInput {
    const configured = this.isConfigured();
    const installedIndex = this.installedIndex();
    const composed: Record<string, { machine: unknown[]; process: unknown[]; filament: unknown[] }> = {};
    const groupFor = (vendor: string) => {
      const existing = composed[vendor];
      if (existing) return existing;
      const created = { machine: [] as unknown[], process: [] as unknown[], filament: [] as unknown[] };
      composed[vendor] = created;
      return created;
    };

    for (const [vendor, group] of Object.entries(this.systemCatalog)) {
      const target = groupFor(vendor);
      for (const kind of CUSTOM_PRESET_KINDS) {
        for (const entry of group[kind] ?? []) {
          if (kind !== 'machine' || !configured) {
            target[kind].push(entry);
            continue;
          }
          target.machine.push(this.hideWhenNotInstalled(vendor, entry, installedIndex));
        }
      }
    }

    for (const preset of this.current.customPresets) {
      groupFor(preset.vendor)[preset.kind].push(customPresetPayload(preset));
    }
    return composed as PresetCatalogInput;
  }

  /** The composed catalog as a validated graph — the same object every mutation proves. */
  graph(): PresetGraph {
    return this.composedGraph;
  }

  /**
   * A deterministic, reviewable bundle. Keys are emitted in sorted order and
   * arrays in a stable order, so two exports of the same library are byte-identical
   * and a diff between two operators' setups is readable.
   */
  exportBundle(exportedAt = this.clock.now()): string {
    const bundle: PresetBundle = {
      format: PRESET_BUNDLE_FORMAT,
      schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
      exportedAt,
      engine: { repository: PINNED_PRESET_SEMANTICS.repository, commit: PINNED_PRESET_SEMANTICS.commit },
      catalogFingerprint: this.catalogFingerprint,
      installed: this.current.installed,
      customPresets: this.current.customPresets,
    };
    return stableStringify(bundle as unknown as PresetJsonValue);
  }

  /**
   * Replace the library from a bundle, atomically. Every referenced model,
   * variant, and base preset must exist in *this* catalog; a bundle from a
   * different engine revision is refused rather than partially applied,
   * because its overrides may name keys this engine no longer has.
   */
  importBundle(text: string): PresetLibraryResult {
    const issues: PresetLibraryIssue[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return failed([
        issue(
          'invalid-bundle',
          '$',
          `Bundle is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
        ),
      ]);
    }
    if (!isPlainObject(parsed)) return failed([issue('invalid-bundle', '$', 'Bundle must be a JSON object.')]);
    if (parsed.format !== PRESET_BUNDLE_FORMAT) {
      return failed([
        issue('invalid-bundle', '$.format', `Bundle format must be ${JSON.stringify(PRESET_BUNDLE_FORMAT)}.`),
      ]);
    }
    if (parsed.schemaVersion !== PRESET_LIBRARY_SCHEMA_VERSION) {
      return failed([
        issue(
          'unsupported-schema',
          '$.schemaVersion',
          `Bundle schema version ${String(parsed.schemaVersion)} is not supported by this build ` +
            `(expected ${PRESET_LIBRARY_SCHEMA_VERSION}).`,
        ),
      ]);
    }
    const engine = parsed.engine;
    const commit = isPlainObject(engine) ? optionalString(engine.commit) : undefined;
    if (commit !== PINNED_PRESET_SEMANTICS.commit) {
      return failed([
        issue(
          'engine-mismatch',
          '$.engine.commit',
          `Bundle was exported against engine ${commit ?? 'unknown'}; this build is pinned to ` +
            `${PINNED_PRESET_SEMANTICS.commit}.`,
        ),
      ]);
    }
    const state = parseLibraryState(
      {
        schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
        catalogFingerprint: this.catalogFingerprint,
        installed: parsed.installed,
        customPresets: parsed.customPresets,
      },
      issues,
    );
    if (!state) return failed(issues);
    return this.applyState(state, '$', issues);
  }

  /**
   * What a newer system catalog would do to this library. Nothing is applied:
   * an operator is told which models appeared, which disappeared, and which of
   * their own presets would lose their base, before anything moves.
   */
  planCatalogUpdate(nextSystemCatalog: unknown): PresetCatalogUpdatePlan {
    const issues: PresetLibraryIssue[] = [];
    let nextGraph: PresetGraph;
    try {
      nextGraph = PresetGraph.build(nextSystemCatalog);
    } catch (error) {
      return Object.freeze({
        previousFingerprint: this.catalogFingerprint,
        nextFingerprint: '',
        changed: false,
        addedModels: Object.freeze([]),
        removedModels: Object.freeze([]),
        removedVariants: Object.freeze([]),
        orphanedCustomPresets: Object.freeze([]),
        issues: freezeIssues([...issues, ...graphIssues(error, '$')]),
        applicable: false,
      });
    }
    const nextFingerprint = fingerprintGraph(nextGraph);
    const currentModels = modelKeys(this.systemGraph);
    const nextModels = modelKeys(nextGraph);
    const addedModels: PresetLineage[] = [];
    const removedModels: PresetLineage[] = [];
    for (const [key, lineage] of nextModels) if (!currentModels.has(key)) addedModels.push(lineage);
    for (const [key, lineage] of currentModels) if (!nextModels.has(key)) removedModels.push(lineage);

    const removedVariants: PresetLineage[] = [];
    const nextVariants = variantKeys(nextGraph);
    for (const entry of this.current.installed) {
      for (const variant of entry.variants) {
        if (!nextVariants.has(`${entry.vendor}\u0000${entry.model}\u0000${variant}`)) {
          removedVariants.push({ vendor: entry.vendor, kind: 'machine', name: `${entry.model} ${variant}` });
        }
      }
    }

    const nextNames = new Set(nextGraph.list().map((node) => `${node.kind}\u0000${node.name}`));
    // A preset whose base is another custom preset travels with it, so only a
    // base the *new system catalog* dropped can orphan anything.
    const orphaned: PresetLineage[] = [];
    for (const preset of this.current.customPresets) {
      const key = `${preset.kind}\u0000${preset.inherits}`;
      const derivedFromCustom = this.current.customPresets.some(
        (candidate) => candidate !== preset && candidate.kind === preset.kind && candidate.name === preset.inherits,
      );
      if (!nextNames.has(key) && !derivedFromCustom) {
        orphaned.push({ vendor: preset.vendor, kind: preset.kind, name: preset.name });
      }
    }
    for (const lineage of removedVariants) {
      issues.push(
        issue(
          'unknown-printer-variant',
          '$.installed',
          `${lineage.vendor} ${lineage.name} is no longer in the catalog and would be uninstalled.`,
          'warning',
        ),
      );
    }
    for (const lineage of orphaned) {
      issues.push(
        issue(
          'unknown-base-preset',
          '$.customPresets',
          `${JSON.stringify(lineage.name)} inherits a preset the new catalog no longer contains; re-base it before updating.`,
        ),
      );
    }
    return Object.freeze({
      previousFingerprint: this.catalogFingerprint,
      nextFingerprint,
      changed: nextFingerprint !== this.catalogFingerprint,
      addedModels: Object.freeze(addedModels.sort(compareLineage)),
      removedModels: Object.freeze(removedModels.sort(compareLineage)),
      removedVariants: Object.freeze(removedVariants.sort(compareLineage)),
      orphanedCustomPresets: Object.freeze(orphaned.sort(compareLineage)),
      issues: freezeIssues(issues),
      applicable: !issues.some((entry) => entry.severity === 'error'),
    });
  }

  /**
   * Move this library onto a newer system catalog, dropping installations the
   * new catalog no longer offers. A plan with blocking issues is refused, so an
   * orphaned custom preset is never silently discarded.
   */
  applyCatalogUpdate(nextSystemCatalog: unknown): {
    readonly ok: boolean;
    readonly issues: readonly PresetLibraryIssue[];
    readonly library?: PresetLibrary;
  } {
    const plan = this.planCatalogUpdate(nextSystemCatalog);
    if (!plan.applicable) return { ok: false, issues: plan.issues };
    const nextGraph = PresetGraph.build(nextSystemCatalog);
    const nextVariants = variantKeys(nextGraph);
    const installed = this.current.installed
      .map((entry) => ({
        vendor: entry.vendor,
        model: entry.model,
        variants: entry.variants.filter((variant) =>
          nextVariants.has(`${entry.vendor}\u0000${entry.model}\u0000${variant}`),
        ),
      }))
      .filter((entry) => entry.variants.length > 0);
    const library = new PresetLibrary(
      nextSystemCatalog as PresetCatalogInput,
      nextGraph,
      emptyPresetLibraryState(fingerprintGraph(nextGraph)),
      this.clock,
    );
    const applied = library.applyState(
      {
        schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
        catalogFingerprint: library.catalogFingerprint,
        installed,
        customPresets: this.current.customPresets,
      },
      '$',
      [],
    );
    if (!applied.ok) return { ok: false, issues: [...plan.issues, ...applied.issues] };
    return { ok: true, issues: plan.issues, library };
  }

  // ---- internals -----------------------------------------------------

  /**
   * The one write path. A candidate state is normalized, then proven by
   * rebuilding the merged graph; only a graph that builds replaces the live
   * state, so every rejection leaves the library exactly as it was.
   */
  private applyState(
    candidate: PresetLibraryState,
    path: string,
    priorIssues: readonly PresetLibraryIssue[] = [],
  ): PresetLibraryResult {
    const issues: PresetLibraryIssue[] = [...priorIssues];
    const installed = this.normalizeInstalled(candidate.installed, `${path}.installed`, issues);
    const presets = this.normalizeCustomPresets(candidate.customPresets, `${path}.customPresets`, issues);
    if (issues.some((entry) => entry.severity === 'error')) return failed(issues);
    const next: PresetLibraryState = Object.freeze({
      schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
      catalogFingerprint: this.catalogFingerprint,
      installed: Object.freeze(installed),
      customPresets: Object.freeze(presets),
    });
    const previous = this.current;
    this.current = next;
    try {
      this.composedGraph = PresetGraph.build(this.composeCatalog());
    } catch (error) {
      this.current = previous;
      return failed([...issues, ...graphIssues(error, path)]);
    }
    return Object.freeze({ ok: true, issues: freezeIssues(issues) });
  }

  private normalizeInstalled(
    selections: readonly InstalledPrinterSelection[],
    path: string,
    issues: PresetLibraryIssue[],
  ): InstalledPrinterSelection[] {
    const byModel = new Map<string, Set<string>>();
    for (let index = 0; index < selections.length; index += 1) {
      const entry = selections[index];
      const vendor = entry.vendor.trim();
      const model = entry.model.trim();
      const available = this.variantsForModel(vendor, model);
      if (!available) {
        issues.push(
          issue(
            'unknown-printer-model',
            `${path}[${index}]`,
            `${vendor || '(empty)'} ${model || '(empty)'} is not in the catalog.`,
          ),
        );
        continue;
      }
      const key = `${vendor}\u0000${model}`;
      const variants = byModel.get(key) ?? new Set<string>();
      for (const variant of entry.variants) {
        const normalized = variant.trim();
        if (!available.has(normalized)) {
          issues.push(
            issue(
              'unknown-printer-variant',
              `${path}[${index}]`,
              `${vendor} ${model} has no ${JSON.stringify(normalized)} variant ` +
                `(available: ${[...available].sort(compareVariants).join(', ')}).`,
            ),
          );
          continue;
        }
        variants.add(normalized);
      }
      byModel.set(key, variants);
    }
    return [...byModel.entries()]
      .map(([key, variants]) => {
        const [vendor, model] = key.split('\u0000');
        return { vendor, model, variants: Object.freeze([...variants].sort(compareVariants)) };
      })
      .filter((entry) => entry.variants.length > 0)
      .sort(
        (left, right) => left.vendor.localeCompare(right.vendor, 'en') || left.model.localeCompare(right.model, 'en'),
      );
  }

  private normalizeCustomPresets(
    presets: readonly CustomPresetRecord[],
    path: string,
    issues: PresetLibraryIssue[],
  ): CustomPresetRecord[] {
    const accepted: CustomPresetRecord[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < presets.length; index += 1) {
      const preset = presets[index];
      const entryPath = `${path}[${index}]`;
      const key = `${preset.vendor}\u0000${preset.kind}\u0000${preset.name}`;
      if (seen.has(key)) {
        issues.push(
          issue('duplicate-preset-name', entryPath, `Duplicate custom preset ${JSON.stringify(preset.name)}.`),
        );
        continue;
      }
      const validated = this.validateRecord(preset, accepted, undefined, entryPath, issues);
      if (!validated) continue;
      seen.add(key);
      accepted.push(validated);
    }
    return accepted;
  }

  private buildRecord(
    draft: CustomPresetDraft,
    replacing: CustomPresetRecord | undefined,
    issues: PresetLibraryIssue[],
  ): CustomPresetRecord | undefined {
    const now = this.clock.now();
    const vendor = (draft.vendor ?? CUSTOM_PRESET_VENDOR).trim() || CUSTOM_PRESET_VENDOR;
    const base = this.findBase(
      draft.kind,
      draft.inherits,
      this.current.customPresets.filter((p) => p !== replacing),
    );
    const baseVendor = base === undefined ? vendor : base.kind === 'node' ? base.node.vendor : base.record.vendor;
    const record: CustomPresetRecord = {
      vendor,
      kind: draft.kind,
      name: draft.name.trim(),
      inherits: draft.inherits.trim(),
      overrides: Object.freeze({ ...(draft.overrides ?? {}) }) as PresetJsonObject,
      provenance: {
        source: draft.source ?? 'user-derived',
        license: (draft.license ?? DEFAULT_LICENSE).trim() || DEFAULT_LICENSE,
        version: (draft.version ?? DEFAULT_VERSION).trim() || DEFAULT_VERSION,
        derivedFrom: {
          vendor: baseVendor,
          kind: draft.kind,
          name: draft.inherits.trim(),
        },
        createdAt: replacing?.provenance.createdAt ?? now,
        updatedAt: now,
        ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
      },
    };
    const peers = this.current.customPresets.filter((preset) => preset !== replacing);
    return this.validateRecord(record, peers, replacing, '$.customPresets', issues);
  }

  private validateRecord(
    record: CustomPresetRecord,
    peers: readonly CustomPresetRecord[],
    replacing: CustomPresetRecord | undefined,
    path: string,
    issues: PresetLibraryIssue[],
  ): CustomPresetRecord | undefined {
    const before = issues.length;
    if (!CUSTOM_PRESET_KINDS.includes(record.kind)) {
      issues.push(issue('invalid-state', `${path}.kind`, `Unknown preset kind ${JSON.stringify(record.kind)}.`));
      return undefined;
    }
    const name = record.name.trim();
    if (!name) {
      issues.push(issue('invalid-name', `${path}.name`, 'A custom preset needs a name.'));
    } else if (name.length > MAX_PRESET_NAME_LENGTH) {
      issues.push(
        issue('invalid-name', `${path}.name`, `Preset names are limited to ${MAX_PRESET_NAME_LENGTH} characters.`),
      );
    } else if (this.systemGraph.list(record.kind).some((node) => node.name === name)) {
      issues.push(
        issue(
          'duplicate-preset-name',
          `${path}.name`,
          `${JSON.stringify(name)} is already a system ${record.kind} preset. Choose a different name.`,
        ),
      );
    } else if (
      peers.some((preset) => preset.kind === record.kind && preset.name === name && preset.vendor === record.vendor)
    ) {
      issues.push(
        issue(
          'duplicate-preset-name',
          `${path}.name`,
          `${JSON.stringify(name)} is already a custom ${record.kind} preset.`,
        ),
      );
    }

    const base = this.findBase(record.kind, record.inherits, peers);
    if (!base) {
      issues.push(
        issue(
          'unknown-base-preset',
          `${path}.inherits`,
          `No ${record.kind} preset named ${JSON.stringify(record.inherits)} to inherit from.`,
        ),
      );
    } else if (base.kind === 'node' && !base.node.isVisible) {
      issues.push(
        issue(
          'base-not-instantiable',
          `${path}.inherits`,
          `${JSON.stringify(record.inherits)} is a non-instantiable template; derive from a selectable preset.`,
        ),
      );
    }
    if (base?.kind === 'custom' && wouldCycle(record, peers)) {
      issues.push(issue('invalid-state', `${path}.inherits`, 'A custom preset may not inherit from itself.'));
    }

    validateOverrides(record.overrides, record.kind, this.allowedKeysByKind, path, issues);
    validateProvenance(record.provenance, path, issues);
    if (issues.length !== before) return undefined;
    return Object.freeze({
      vendor: record.vendor,
      kind: record.kind,
      name,
      inherits: record.inherits.trim(),
      overrides: deepFreezeJson(record.overrides) as PresetJsonObject,
      provenance: Object.freeze({
        ...record.provenance,
        derivedFrom: Object.freeze({ ...record.provenance.derivedFrom }),
      }),
    });
  }

  private findBase(
    kind: PresetKind,
    name: string,
    peers: readonly CustomPresetRecord[] = this.current.customPresets,
  ): { kind: 'node'; node: PresetNode } | { kind: 'custom'; record: CustomPresetRecord } | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const node = this.systemGraph.list(kind).find((candidate) => candidate.name === trimmed);
    if (node) return { kind: 'node', node };
    const record = peers.find((candidate) => candidate.kind === kind && candidate.name === trimmed);
    return record ? { kind: 'custom', record } : undefined;
  }

  private installedIndex(): ReadonlyMap<string, ReadonlySet<string>> {
    const index = new Map<string, Set<string>>();
    for (const entry of this.current.installed) {
      index.set(`${entry.vendor}\u0000${entry.model}`, new Set(entry.variants));
    }
    return index;
  }

  private variantsForModel(vendor: string, model: string): ReadonlySet<string> | undefined {
    const variants = new Set<string>();
    for (const node of this.systemGraph.list('machine')) {
      if (node.vendor !== vendor || !node.isSystem) continue;
      if (optionalString(node.effective.printer_model) !== model) continue;
      const variant = printerVariantOf(node);
      if (variant) variants.add(variant);
    }
    return variants.size > 0 ? variants : undefined;
  }

  private systemMachineFor(vendor: string, model: string, variant: string): PresetNode | undefined {
    return this.systemGraph
      .list('machine')
      .find(
        (node) =>
          node.vendor === vendor &&
          optionalString(node.effective.printer_model) === model &&
          printerVariantOf(node) === variant,
      );
  }

  private hideWhenNotInstalled(
    vendor: string,
    entry: unknown,
    installedIndex: ReadonlyMap<string, ReadonlySet<string>>,
  ): unknown {
    if (!isPlainObject(entry)) return entry;
    const name = optionalString(entry.name);
    if (!name) return entry;
    const node = this.systemGraph.find(vendor, 'machine', name);
    if (!node) return entry;
    const model = optionalString(node.effective.printer_model);
    const variant = printerVariantOf(node);
    if (!model || !variant) return entry;
    if (installedIndex.get(`${vendor}\u0000${model}`)?.has(variant) === true) return entry;
    return { ...entry, instantiation: 'false' };
  }
}

/**
 * Binds a library to a key/value store. Persistence is deliberately outside
 * `PresetLibrary` so the rules above stay testable without a browser, and so a
 * storage failure (private mode, quota) degrades to an in-memory library
 * instead of losing the catalog.
 */
export interface PresetLibraryKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PRESET_LIBRARY_STORAGE_KEY = 'orcaxr.preset-library';

export class PresetLibraryStore {
  readonly library: PresetLibrary;
  readonly loadIssues: readonly PresetLibraryIssue[];

  constructor(
    systemCatalog: unknown,
    private readonly storage: PresetLibraryKeyValueStorage | undefined,
    private readonly key: string = PRESET_LIBRARY_STORAGE_KEY,
  ) {
    let persisted: unknown;
    const raw = safeRead(storage, key);
    if (raw !== null) {
      try {
        persisted = JSON.parse(raw);
      } catch {
        persisted = { schemaVersion: -1 };
      }
    }
    const created = PresetLibrary.create(systemCatalog, persisted === undefined ? {} : { state: persisted });
    this.library = created.library;
    this.loadIssues = created.issues;
  }

  /** Persist the current state. Returns false when storage refused the write. */
  save(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, stableStringify(this.library.state as unknown as PresetJsonValue));
      return true;
    } catch {
      return false;
    }
  }

  clear(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(this.key);
      return true;
    } catch {
      return false;
    }
  }
}

// ---- helpers ---------------------------------------------------------

function safeRead(storage: PresetLibraryKeyValueStorage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function customPresetPayload(preset: CustomPresetRecord): PresetJsonObject {
  return {
    ...preset.overrides,
    type: preset.kind,
    name: preset.name,
    inherits: preset.inherits,
    from: 'user',
    instantiation: 'true',
  } as PresetJsonObject;
}

function printerVariantOf(node: PresetNode): string | undefined {
  const variant = optionalString(node.effective.printer_variant);
  if (variant) return variant;
  const nozzle = firstNumber(node.effective.nozzle_diameter);
  return nozzle === undefined ? undefined : String(nozzle);
}

function allowedKeys(graph: PresetGraph): ReadonlyMap<PresetKind, ReadonlySet<string>> {
  const byKind = new Map<PresetKind, Set<string>>();
  for (const kind of CUSTOM_PRESET_KINDS) byKind.set(kind, new Set<string>());
  for (const node of graph.list()) {
    const keys = byKind.get(node.kind);
    if (!keys) continue;
    for (const key of Object.keys(node.effective)) keys.add(key);
  }
  return byKind;
}

function validateOverrides(
  overrides: PresetJsonObject,
  kind: PresetKind,
  allowed: ReadonlyMap<PresetKind, ReadonlySet<string>>,
  path: string,
  issues: PresetLibraryIssue[],
): void {
  if (!isPlainObject(overrides)) {
    issues.push(issue('invalid-state', `${path}.overrides`, 'Overrides must be an object.'));
    return;
  }
  const permitted = allowed.get(kind) ?? new Set<string>();
  for (const [key, value] of Object.entries(overrides)) {
    const keyPath = `${path}.overrides.${key}`;
    if (RESERVED_PRESET_KEYS.includes(key)) {
      issues.push(issue('reserved-key', keyPath, `${key} is owned by the preset library and cannot be overridden.`));
      continue;
    }
    if (!permitted.has(key)) {
      issues.push(
        issue(
          'unknown-preset-key',
          keyPath,
          `No system ${kind} preset defines ${JSON.stringify(key)}; a ${kind} preset holding it would never be read.`,
        ),
      );
      continue;
    }
    validateJsonValue(value, keyPath, issues);
  }
}

function validateJsonValue(value: PresetJsonValue, path: string, issues: PresetLibraryIssue[], depth = 0): void {
  if (depth > 8) {
    issues.push(issue('invalid-value', path, 'Value is nested too deeply.'));
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push(issue('invalid-value', path, 'Numbers must be finite.'));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, issues, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) validateJsonValue(entry, `${path}.${key}`, issues, depth + 1);
    return;
  }
  issues.push(issue('invalid-value', path, `Unsupported ${typeof value} value.`));
}

function validateProvenance(provenance: PresetProvenance, path: string, issues: PresetLibraryIssue[]): void {
  if (!isPlainObject(provenance)) {
    issues.push(issue('invalid-provenance', `${path}.provenance`, 'Provenance must be an object.'));
    return;
  }
  if (provenance.source !== 'user-derived' && provenance.source !== 'imported') {
    issues.push(
      issue('invalid-provenance', `${path}.provenance.source`, 'Source must be "user-derived" or "imported".'),
    );
  }
  for (const key of ['license', 'version'] as const) {
    if (typeof provenance[key] !== 'string' || !provenance[key].trim()) {
      issues.push(issue('invalid-provenance', `${path}.provenance.${key}`, `A custom preset must declare a ${key}.`));
    }
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    const value = provenance[key];
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      issues.push(issue('invalid-provenance', `${path}.provenance.${key}`, `${key} must be an ISO-8601 timestamp.`));
    }
  }
  const lineage = provenance.derivedFrom;
  if (!isPlainObject(lineage) || typeof lineage.name !== 'string' || !lineage.name.trim()) {
    issues.push(
      issue('invalid-provenance', `${path}.provenance.derivedFrom`, 'Provenance must name the preset it derives from.'),
    );
  }
}

function wouldCycle(record: CustomPresetRecord, peers: readonly CustomPresetRecord[]): boolean {
  const seen = new Set<string>([`${record.kind}\u0000${record.name}`]);
  let cursor = record.inherits;
  for (let guard = 0; guard < 64; guard += 1) {
    const key = `${record.kind}\u0000${cursor}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const next = peers.find((candidate) => candidate.kind === record.kind && candidate.name === cursor);
    if (!next) return false;
    cursor = next.inherits;
  }
  return true;
}

function parseLibraryState(input: unknown, issues: PresetLibraryIssue[]): PresetLibraryState | undefined {
  if (!isPlainObject(input)) {
    issues.push(issue('invalid-state', '$', 'Stored preset library must be an object.'));
    return undefined;
  }
  if (input.schemaVersion !== PRESET_LIBRARY_SCHEMA_VERSION) {
    issues.push(
      issue(
        'unsupported-schema',
        '$.schemaVersion',
        `Stored preset library uses schema version ${String(input.schemaVersion)}; this build reads ` +
          `${PRESET_LIBRARY_SCHEMA_VERSION}.`,
      ),
    );
    return undefined;
  }
  const installed: InstalledPrinterSelection[] = [];
  const rawInstalled = input.installed;
  if (rawInstalled !== undefined) {
    if (!Array.isArray(rawInstalled)) {
      issues.push(issue('invalid-state', '$.installed', 'installed must be an array.'));
      return undefined;
    }
    for (let index = 0; index < rawInstalled.length; index += 1) {
      const entry = rawInstalled[index];
      const path = `$.installed[${index}]`;
      if (!isPlainObject(entry)) {
        issues.push(issue('invalid-state', path, 'Installed entry must be an object.'));
        continue;
      }
      const vendor = optionalString(entry.vendor);
      const model = optionalString(entry.model);
      const variants = Array.isArray(entry.variants)
        ? entry.variants.filter((value): value is string => typeof value === 'string')
        : undefined;
      if (!vendor || !model || !variants) {
        issues.push(issue('invalid-state', path, 'Installed entry needs vendor, model, and string variants.'));
        continue;
      }
      installed.push({ vendor, model, variants: Object.freeze(variants) });
    }
  }

  const customPresets: CustomPresetRecord[] = [];
  const rawPresets = input.customPresets;
  if (rawPresets !== undefined) {
    if (!Array.isArray(rawPresets)) {
      issues.push(issue('invalid-state', '$.customPresets', 'customPresets must be an array.'));
      return undefined;
    }
    for (let index = 0; index < rawPresets.length; index += 1) {
      const entry = rawPresets[index];
      const path = `$.customPresets[${index}]`;
      if (!isPlainObject(entry)) {
        issues.push(issue('invalid-state', path, 'Custom preset must be an object.'));
        continue;
      }
      const vendor = optionalString(entry.vendor) ?? CUSTOM_PRESET_VENDOR;
      const kind = entry.kind;
      const name = optionalString(entry.name);
      const inherits = optionalString(entry.inherits);
      if (typeof kind !== 'string' || !CUSTOM_PRESET_KINDS.includes(kind as PresetKind)) {
        issues.push(issue('invalid-state', `${path}.kind`, `Unknown preset kind ${JSON.stringify(kind)}.`));
        continue;
      }
      if (!name || !inherits) {
        issues.push(issue('invalid-state', path, 'Custom preset needs a name and an inherits base.'));
        continue;
      }
      const overrides = entry.overrides;
      if (overrides !== undefined && !isPlainObject(overrides)) {
        issues.push(issue('invalid-state', `${path}.overrides`, 'Overrides must be an object.'));
        continue;
      }
      const provenance = parseProvenance(entry.provenance, kind as PresetKind, vendor, inherits, path, issues);
      if (!provenance) continue;
      customPresets.push({
        vendor,
        kind: kind as PresetKind,
        name,
        inherits,
        overrides: (overrides ?? {}) as PresetJsonObject,
        provenance,
      });
    }
  }

  return {
    schemaVersion: PRESET_LIBRARY_SCHEMA_VERSION,
    catalogFingerprint: optionalString(input.catalogFingerprint) ?? '',
    installed,
    customPresets,
  };
}

function parseProvenance(
  input: unknown,
  kind: PresetKind,
  vendor: string,
  inherits: string,
  path: string,
  issues: PresetLibraryIssue[],
): PresetProvenance | undefined {
  if (!isPlainObject(input)) {
    issues.push(issue('invalid-provenance', `${path}.provenance`, 'Custom preset must carry provenance metadata.'));
    return undefined;
  }
  const lineage = isPlainObject(input.derivedFrom) ? input.derivedFrom : undefined;
  const source = input.source === 'imported' ? 'imported' : 'user-derived';
  const provenance: PresetProvenance = {
    source,
    license: optionalString(input.license) ?? '',
    version: optionalString(input.version) ?? '',
    derivedFrom: {
      vendor: (lineage && optionalString(lineage.vendor)) ?? vendor,
      kind,
      name: (lineage && optionalString(lineage.name)) ?? inherits,
    },
    createdAt: optionalString(input.createdAt) ?? '',
    updatedAt: optionalString(input.updatedAt) ?? '',
    ...(optionalString(input.note) ? { note: optionalString(input.note) as string } : {}),
  };
  const before = issues.length;
  validateProvenance(provenance, path, issues);
  return issues.length === before ? provenance : undefined;
}

function fingerprintGraph(graph: PresetGraph): string {
  const identities = graph
    .list()
    .map((node) => `${node.vendor}\u0000${node.kind}\u0000${node.name}\u0000${stableStringify(node.raw)}`)
    .sort();
  return fnv1a64Text(identities.join(''));
}

function modelKeys(graph: PresetGraph): ReadonlyMap<string, PresetLineage> {
  const models = new Map<string, PresetLineage>();
  for (const node of graph.list('machine')) {
    if (!node.isSystem) continue;
    const model = optionalString(node.effective.printer_model);
    if (!model) continue;
    models.set(`${node.vendor}\u0000${model}`, { vendor: node.vendor, kind: 'machine', name: model });
  }
  return models;
}

function variantKeys(graph: PresetGraph): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const node of graph.list('machine')) {
    if (!node.isSystem) continue;
    const model = optionalString(node.effective.printer_model);
    const variant = printerVariantOf(node);
    if (model && variant) keys.add(`${node.vendor}\u0000${model}\u0000${variant}`);
  }
  return keys;
}

/**
 * Read one typed override value in the shape the base already uses.
 *
 * Engine config is not free-form: `nozzle_temperature` is a list of strings and
 * `layer_height` is one. Storing `"215"` where the base holds `["215"]` would
 * produce a preset that validates here and then deserializes differently in the
 * engine, so the inherited value decides the shape and the operator only ever
 * types the value.
 */
export function coerceOverrideValue(inherited: PresetJsonValue | undefined, text: string): PresetJsonValue {
  const trimmed = text.trim();
  if (Array.isArray(inherited)) {
    const parts = trimmed
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const sample = inherited[0];
    return parts.map((part) => (typeof sample === 'number' ? numberOrText(part) : part));
  }
  if (typeof inherited === 'number') return numberOrText(trimmed);
  if (typeof inherited === 'boolean') return trimmed === 'true' || trimmed === '1';
  return trimmed;
}

function numberOrText(text: string): PresetJsonValue {
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) && String(parsed) === text ? parsed : text;
}

/** How an inherited value is presented for editing — the inverse of the above. */
export function formatOverrideValue(value: PresetJsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((entry) => formatOverrideValue(entry)).join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

/** Deterministic JSON: sorted keys at every level, so exports diff cleanly. */
export function stableStringify(value: PresetJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as PresetJsonObject)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function compareVariants(left: string, right: string): number {
  const leftNumber = Number.parseFloat(left);
  const rightNumber = Number.parseFloat(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right, 'en');
}

function compareLineage(left: PresetLineage, right: PresetLineage): number {
  return left.vendor.localeCompare(right.vendor, 'en') || left.name.localeCompare(right.name, 'en');
}

function firstNumber(value: PresetJsonValue | undefined): number | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar === 'number' && Number.isFinite(scalar)) return scalar;
  if (typeof scalar === 'string') {
    const parsed = Number.parseFloat(scalar);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, PresetJsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreezeJson(entry);
    Object.freeze(value);
  }
  return value;
}

function issue(
  code: PresetLibraryIssueCode,
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): PresetLibraryIssue {
  return Object.freeze({ code, severity, path, message });
}

function graphIssues(error: unknown, path: string): PresetLibraryIssue[] {
  if (error instanceof PresetGraphError) {
    return error.issues.map((entry) => issue('graph-rejected', entry.path, entry.message));
  }
  return [
    issue('graph-rejected', path, error instanceof Error ? error.message : 'Preset catalog rejected the change.'),
  ];
}

function failed(issues: readonly PresetLibraryIssue[]): PresetLibraryResult {
  return Object.freeze({ ok: false, issues: freezeIssues(issues) });
}

function freezeIssues(issues: readonly PresetLibraryIssue[]): readonly PresetLibraryIssue[] {
  return Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
}

/** Re-exported so callers can build stable preset identities without a second import. */
export { presetId };
