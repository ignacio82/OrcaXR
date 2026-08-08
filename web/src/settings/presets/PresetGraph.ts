/**
 * Headless preset inheritance, compatibility, and selection semantics.
 *
 * The behavior anchors are exact Git blobs from Snapmaker OrcaSlicer v2.3.4:
 * - Preset.cpp:639-717 evaluates print/printer compatibility.
 * - Preset.cpp:1253-1288 applies visibility and parent configuration.
 * - Preset.cpp:2777-2805 updates compatibility without mutating preset data.
 * - Preset.hpp:630-680 chooses the first visible compatible preset.
 * - PresetBundle.cpp:3793-3940 preserves compatible selections and ranks
 *   replacements by alias, printer defaults, layer height, and filament type.
 *
 * This module deliberately has no DOM, storage, network, or slicer dependency.
 */

export const PINNED_PRESET_SEMANTICS = Object.freeze({
  repository: 'https://github.com/Snapmaker/OrcaSlicer.git',
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  files: Object.freeze({
    presetHeader: Object.freeze({
      path: 'src/libslic3r/Preset.hpp',
      blob: 'e5fae9bd1fddf597bbc00d4036723f9e24ec8d98',
    }),
    preset: Object.freeze({
      path: 'src/libslic3r/Preset.cpp',
      blob: '3646369750323d80880bc65ab4fa6be7eb3d4cdc',
    }),
    bundle: Object.freeze({
      path: 'src/libslic3r/PresetBundle.cpp',
      blob: 'e93dfa024c5a8e9e872025576adb933c39b77bc0',
    }),
  }),
});

export type PresetKind = 'machine' | 'process' | 'filament';
export type PresetSource = 'system' | 'user' | 'project' | 'external' | 'default' | 'unknown';

declare const presetIdBrand: unique symbol;
export type PresetId = string & { readonly [presetIdBrand]: 'preset' };

export type PresetJsonValue = null | boolean | number | string | readonly PresetJsonValue[] | PresetJsonObject;
export interface PresetJsonObject {
  readonly [key: string]: PresetJsonValue;
}

export interface PresetCatalogInputGroup {
  readonly machine?: readonly unknown[];
  readonly process?: readonly unknown[];
  readonly filament?: readonly unknown[];
}

export type PresetCatalogInput = Readonly<Record<string, PresetCatalogInputGroup>>;

export interface PresetNode {
  readonly id: PresetId;
  readonly vendor: string;
  readonly kind: PresetKind;
  readonly name: string;
  readonly parentId?: PresetId;
  readonly source: PresetSource;
  readonly isSystem: boolean;
  readonly isDefault: boolean;
  readonly isVisible: boolean;
  /** Exact caller payload, defensively cloned and deeply frozen. */
  readonly raw: PresetJsonObject;
  /** Shallow config-key overlay of every ancestor followed by this payload. */
  readonly effective: PresetJsonObject;
}

export interface PresetAuxiliaryPayload {
  readonly id: string;
  readonly vendor: string;
  readonly kind: PresetKind;
  /** Unnamed non-preset JSON (for example a material/nozzle rule table). */
  readonly raw: PresetJsonObject;
}

export interface PresetGraphIssue {
  readonly code:
    | 'invalid-catalog'
    | 'invalid-group'
    | 'invalid-profile'
    | 'duplicate-profile'
    | 'missing-parent'
    | 'ambiguous-parent'
    | 'inheritance-cycle'
    | 'inheritance-depth';
  readonly path: string;
  readonly message: string;
}

export class PresetGraphError extends Error {
  constructor(readonly issues: readonly PresetGraphIssue[]) {
    super(`Preset graph contains ${issues.length} issue${issues.length === 1 ? '' : 's'}`);
    this.name = 'PresetGraphError';
  }
}

export interface PresetConditionContext {
  readonly candidate: PresetNode;
  readonly activePrinter: PresetNode;
  readonly activePrint?: PresetNode;
  readonly extraConfig: Readonly<{
    printerPreset: string;
    numExtruders?: number;
  }>;
}

export type PresetConditionEvaluator = (expression: string, context: PresetConditionContext) => boolean;

export interface PresetCompatibilityAssessment {
  readonly status: 'compatible' | 'incompatible' | 'unresolved';
  readonly reason:
    | 'default-preset'
    | 'empty-active-preset'
    | 'explicit-name'
    | 'direct-parent-name'
    | 'implicit-all'
    | 'condition-true'
    | 'condition-false'
    | 'condition-evaluator-missing'
    | 'condition-evaluation-failed'
    | 'explicit-list-miss'
    | 'excluded-printer'
    | 'printer-mismatch'
    | 'print-mismatch';
  readonly expression?: string;
}

export interface PresetSelectionRequest {
  readonly printerId: PresetId;
  readonly processId?: PresetId;
  readonly filamentIds?: readonly (PresetId | undefined)[];
  /**
   * Restrict visible candidates to installed vendors. Cross-vendor
   * compatibility remains enabled when more than one vendor is installed.
   */
  readonly installedVendors?: readonly string[];
}

export interface PresetSelectionSubstitution {
  readonly kind: 'process' | 'filament';
  readonly slot?: number;
  readonly previousId?: PresetId;
  readonly nextId?: PresetId;
  readonly reason: 'missing' | 'incompatible' | 'no-compatible-preset';
}

export interface PresetSelectionDiagnostic {
  readonly code: 'unresolved-condition' | 'no-compatible-process' | 'no-compatible-filament';
  readonly presetId?: PresetId;
  readonly slot?: number;
  readonly message: string;
}

export interface ResolvedPresetSelection {
  readonly printer: PresetNode;
  readonly process?: PresetNode;
  readonly filaments: readonly (PresetNode | null)[];
  readonly substitutions: readonly PresetSelectionSubstitution[];
  readonly diagnostics: readonly PresetSelectionDiagnostic[];
  readonly complete: boolean;
}

interface MutableRecord {
  readonly id: PresetId;
  readonly vendor: string;
  readonly kind: PresetKind;
  readonly name: string;
  readonly path: string;
  readonly raw: PresetJsonObject;
  parentId?: PresetId;
}

const KINDS: readonly PresetKind[] = ['machine', 'process', 'filament'];
const MAX_INHERITANCE_DEPTH = 64;
const MAX_MATCH_QUALITY = Number.MAX_SAFE_INTEGER;

export class PresetGraph {
  private readonly byId: ReadonlyMap<PresetId, PresetNode>;
  private readonly ordered: readonly PresetNode[];
  readonly auxiliaryPayloads: readonly PresetAuxiliaryPayload[];

  private constructor(nodes: readonly PresetNode[], auxiliaryPayloads: readonly PresetAuxiliaryPayload[]) {
    this.ordered = Object.freeze([...nodes].sort(compareNodes));
    this.byId = new Map(this.ordered.map((node) => [node.id, node]));
    this.auxiliaryPayloads = Object.freeze([...auxiliaryPayloads].sort(compareAuxiliary));
  }

  static build(input: unknown): PresetGraph {
    const issues: PresetGraphIssue[] = [];
    const catalog = parseCatalog(input, issues);
    if (!catalog) throw new PresetGraphError(freezeIssues(issues));

    const records: MutableRecord[] = [];
    const auxiliary: PresetAuxiliaryPayload[] = [];
    const byScopedName = new Map<string, MutableRecord>();
    const byKindAndName = new Map<string, MutableRecord[]>();
    for (const vendor of Object.keys(catalog).sort((left, right) => left.localeCompare(right, 'en'))) {
      const group = catalog[vendor];
      for (const kind of KINDS) {
        const entries = group[kind] ?? [];
        for (let index = 0; index < entries.length; index += 1) {
          const path = `$.${vendor}.${kind}[${index}]`;
          const raw = cloneJsonObject(entries[index], path, issues);
          if (!raw) continue;
          validateRelevantFields(raw, kind, path, issues);
          const name = optionalString(raw.name);
          if (!name) {
            auxiliary.push(
              deepFreeze({
                id: `preset-aux:${encodeURIComponent(vendor)}:${kind}:${index}`,
                vendor,
                kind,
                raw,
              }),
            );
            continue;
          }
          const id = presetId(vendor, kind, name);
          const record: MutableRecord = { id, vendor, kind, name, path, raw };
          const scopeKey = scopedName(vendor, kind, name);
          const duplicate = byScopedName.get(scopeKey);
          if (duplicate) {
            issues.push({
              code: 'duplicate-profile',
              path,
              message: `Duplicate ${kind} preset ${JSON.stringify(name)} in vendor ${JSON.stringify(vendor)}`,
            });
            continue;
          }
          byScopedName.set(scopeKey, record);
          const globalKey = kindAndName(kind, name);
          const sameName = byKindAndName.get(globalKey) ?? [];
          sameName.push(record);
          byKindAndName.set(globalKey, sameName);
          records.push(record);
        }
      }
    }

    for (const record of records) {
      const parentName = optionalString(record.raw.inherits);
      if (!parentName) continue;
      const local = byScopedName.get(scopedName(record.vendor, record.kind, parentName));
      if (local) {
        record.parentId = local.id;
        continue;
      }
      const global = byKindAndName.get(kindAndName(record.kind, parentName)) ?? [];
      if (global.length === 1) {
        record.parentId = global[0].id;
      } else if (global.length === 0) {
        issues.push({
          code: 'missing-parent',
          path: pathFor(record, 'inherits'),
          message: `${record.kind} preset ${JSON.stringify(record.name)} inherits missing preset ${JSON.stringify(parentName)}`,
        });
      } else {
        issues.push({
          code: 'ambiguous-parent',
          path: pathFor(record, 'inherits'),
          message:
            `${record.kind} preset ${JSON.stringify(record.name)} has ambiguous cross-vendor parent ` +
            `${JSON.stringify(parentName)}`,
        });
      }
    }

    detectInheritanceProblems(records, issues);
    if (issues.length > 0) throw new PresetGraphError(freezeIssues(issues));

    const mutableById = new Map(records.map((record) => [record.id, record]));
    const effectiveById = new Map<PresetId, PresetJsonObject>();
    const effective = (record: MutableRecord): PresetJsonObject => {
      const cached = effectiveById.get(record.id);
      if (cached) return cached;
      const parent = record.parentId ? mutableById.get(record.parentId) : undefined;
      const merged = deepFreeze({
        ...(parent ? effective(parent) : {}),
        ...cloneJsonObjectUnchecked(record.raw),
      });
      effectiveById.set(record.id, merged);
      return merged;
    };

    const nodes = records.map((record) => {
      const source = sourceOf(record.raw);
      return deepFreeze<PresetNode>({
        id: record.id,
        vendor: record.vendor,
        kind: record.kind,
        name: record.name,
        ...(record.parentId ? { parentId: record.parentId } : {}),
        source,
        isSystem: source === 'system',
        isDefault: source === 'default' || record.raw.is_default === true,
        isVisible: record.raw.instantiation !== false && record.raw.instantiation !== 'false',
        raw: record.raw,
        effective: effective(record),
      });
    });
    return new PresetGraph(nodes, auxiliary);
  }

  get(id: PresetId): PresetNode {
    const node = this.byId.get(id);
    if (!node) throw new Error(`Unknown preset ${JSON.stringify(id)}`);
    return node;
  }

  find(vendor: string, kind: PresetKind, name: string): PresetNode | undefined {
    return this.byId.get(presetId(vendor, kind, name));
  }

  list(kind?: PresetKind): readonly PresetNode[] {
    return Object.freeze(this.ordered.filter((node) => kind === undefined || node.kind === kind));
  }

  selectable(kind: PresetKind, installedVendors?: readonly string[]): readonly PresetNode[] {
    const installed = installedVendors ? new Set(installedVendors) : undefined;
    return Object.freeze(
      this.ordered.filter(
        (node) => node.kind === kind && node.isVisible && (installed === undefined || installed.has(node.vendor)),
      ),
    );
  }

  assessPrinterCompatibility(
    candidateId: PresetId,
    printerId: PresetId,
    conditionEvaluator?: PresetConditionEvaluator,
  ): PresetCompatibilityAssessment {
    const candidate = this.get(candidateId);
    const printer = this.get(printerId);
    if (candidate.kind === 'machine' || printer.kind !== 'machine') {
      return frozenAssessment('incompatible', 'printer-mismatch');
    }
    if (candidate.isDefault) return frozenAssessment('compatible', 'default-preset');
    if (!printer.name) return frozenAssessment('compatible', 'empty-active-preset');

    const excluded = stringList(candidate.effective.excluded_printers);
    if (candidate.kind === 'filament' && excluded.includes(printer.name)) {
      return frozenAssessment('incompatible', 'excluded-printer');
    }

    const compatiblePrinters = stringList(candidate.effective.compatible_printers);
    if (compatiblePrinters.length > 0) {
      if (compatiblePrinters.includes(printer.name)) {
        return frozenAssessment('compatible', 'explicit-name');
      }
      const parentName = printer.parentId ? this.get(printer.parentId).name : undefined;
      if (!printer.isSystem && parentName && compatiblePrinters.includes(parentName)) {
        return frozenAssessment('compatible', 'direct-parent-name');
      }
      return frozenAssessment('incompatible', 'explicit-list-miss');
    }

    const expression = optionalString(candidate.effective.compatible_printers_condition);
    if (!expression) return frozenAssessment('compatible', 'implicit-all');
    return evaluateCondition(expression, candidate, printer, undefined, conditionEvaluator);
  }

  assessPrintCompatibility(
    candidateId: PresetId,
    printId: PresetId,
    printerId: PresetId,
    conditionEvaluator?: PresetConditionEvaluator,
  ): PresetCompatibilityAssessment {
    const candidate = this.get(candidateId);
    const activePrint = this.get(printId);
    const printer = this.get(printerId);
    if (candidate.kind !== 'filament' || activePrint.kind !== 'process' || printer.kind !== 'machine') {
      return frozenAssessment('incompatible', 'print-mismatch');
    }
    if (candidate.isDefault) return frozenAssessment('compatible', 'default-preset');
    if (!activePrint.name) return frozenAssessment('compatible', 'empty-active-preset');

    const compatiblePrints = stringList(candidate.effective.compatible_prints);
    if (compatiblePrints.length > 0) {
      return compatiblePrints.includes(activePrint.name)
        ? frozenAssessment('compatible', 'explicit-name')
        : frozenAssessment('incompatible', 'explicit-list-miss');
    }

    const expression = optionalString(candidate.effective.compatible_prints_condition);
    if (!expression) return frozenAssessment('compatible', 'implicit-all');
    return evaluateCondition(expression, candidate, printer, activePrint, conditionEvaluator);
  }

  compatibleProcesses(
    printerId: PresetId,
    options: {
      readonly installedVendors?: readonly string[];
      readonly conditionEvaluator?: PresetConditionEvaluator;
    } = {},
  ): readonly PresetNode[] {
    return Object.freeze(
      this.selectable('process', options.installedVendors).filter(
        (candidate) =>
          this.assessPrinterCompatibility(candidate.id, printerId, options.conditionEvaluator).status === 'compatible',
      ),
    );
  }

  compatibleFilaments(
    printerId: PresetId,
    printId: PresetId,
    options: {
      readonly installedVendors?: readonly string[];
      readonly conditionEvaluator?: PresetConditionEvaluator;
    } = {},
  ): readonly PresetNode[] {
    return Object.freeze(
      this.selectable('filament', options.installedVendors).filter((candidate) => {
        const printer = this.assessPrinterCompatibility(candidate.id, printerId, options.conditionEvaluator);
        if (printer.status !== 'compatible') return false;
        return (
          this.assessPrintCompatibility(candidate.id, printId, printerId, options.conditionEvaluator).status ===
          'compatible'
        );
      }),
    );
  }

  resolveSelection(
    request: PresetSelectionRequest,
    conditionEvaluator?: PresetConditionEvaluator,
  ): ResolvedPresetSelection {
    const printer = this.get(request.printerId);
    if (printer.kind !== 'machine') throw new Error(`Preset ${printer.id} is not a machine preset`);
    const substitutions: PresetSelectionSubstitution[] = [];
    const diagnostics: PresetSelectionDiagnostic[] = [];
    const processCandidates = this.selectable('process', request.installedVendors);
    const requestedProcess = request.processId ? this.byId.get(request.processId) : undefined;
    const processAssessment =
      requestedProcess?.kind === 'process'
        ? this.assessPrinterCompatibility(requestedProcess.id, printer.id, conditionEvaluator)
        : undefined;
    let process =
      requestedProcess?.kind === 'process' && processAssessment?.status === 'compatible' ? requestedProcess : undefined;

    if (!process) {
      const compatible: PresetNode[] = [];
      for (const candidate of processCandidates) {
        const assessment = this.assessPrinterCompatibility(candidate.id, printer.id, conditionEvaluator);
        if (assessment.status === 'compatible') compatible.push(candidate);
        else if (assessment.status === 'unresolved') {
          diagnostics.push({
            code: 'unresolved-condition',
            presetId: candidate.id,
            message: `Could not evaluate compatibility for process preset ${candidate.name}`,
          });
        }
      }
      process = chooseProcessReplacement(
        compatible,
        requestedProcess?.kind === 'process' ? requestedProcess : undefined,
        optionalString(printer.effective.default_print_profile),
      );
      substitutions.push({
        kind: 'process',
        ...(request.processId ? { previousId: request.processId } : {}),
        ...(process ? { nextId: process.id } : {}),
        reason: process ? (requestedProcess ? 'incompatible' : 'missing') : 'no-compatible-preset',
      });
      if (!process) {
        diagnostics.push({
          code: 'no-compatible-process',
          message: `No visible process preset is compatible with ${printer.name}`,
        });
      }
    }

    const requestedFilaments = request.filamentIds ?? [];
    const defaultFilaments = stringList(printer.effective.default_filament_profile);
    const slotCount = Math.max(1, requestedFilaments.length, defaultFilaments.length, nozzleCount(printer));
    const filaments: (PresetNode | null)[] = [];
    for (let slot = 0; slot < slotCount; slot += 1) {
      const requestedId = requestedFilaments[slot];
      const requested = requestedId ? this.byId.get(requestedId) : undefined;
      let selected: PresetNode | undefined;
      if (process && requested?.kind === 'filament') {
        const printerAssessment = this.assessPrinterCompatibility(requested.id, printer.id, conditionEvaluator);
        const printAssessment = this.assessPrintCompatibility(requested.id, process.id, printer.id, conditionEvaluator);
        if (printerAssessment.status === 'compatible' && printAssessment.status === 'compatible') {
          selected = requested;
        }
      }
      if (!selected && process) {
        const compatible: PresetNode[] = [];
        for (const candidate of this.selectable('filament', request.installedVendors)) {
          const printerAssessment = this.assessPrinterCompatibility(candidate.id, printer.id, conditionEvaluator);
          const printAssessment =
            printerAssessment.status === 'compatible'
              ? this.assessPrintCompatibility(candidate.id, process.id, printer.id, conditionEvaluator)
              : undefined;
          if (printerAssessment.status === 'compatible' && printAssessment?.status === 'compatible') {
            compatible.push(candidate);
          } else if (printerAssessment.status === 'unresolved' || printAssessment?.status === 'unresolved') {
            diagnostics.push({
              code: 'unresolved-condition',
              presetId: candidate.id,
              slot,
              message: `Could not evaluate compatibility for filament preset ${candidate.name}`,
            });
          }
        }
        // A slot the caller never asked about (a machine with more tools than
        // the request carried) inherits the first slot's filament, the way Orca
        // fills a new extruder with the active preset. Falling back to the
        // catalog's first compatible preset instead would silently pair, say,
        // PLA with ABS, and the engine refuses to slice that combination.
        const inherited = slot > 0 && !requestedId && !defaultFilaments[slot] ? (filaments[0] ?? undefined) : undefined;
        selected = chooseFilamentReplacement(
          compatible,
          requested?.kind === 'filament' ? requested : inherited,
          defaultFilaments[slot] ?? inherited?.name ?? defaultFilaments[0],
        );
      }
      filaments.push(selected ?? null);
      if (!selected || selected.id !== requestedId) {
        substitutions.push({
          kind: 'filament',
          slot,
          ...(requestedId ? { previousId: requestedId } : {}),
          ...(selected ? { nextId: selected.id } : {}),
          reason: selected ? (requested ? 'incompatible' : 'missing') : 'no-compatible-preset',
        });
      }
      if (!selected) {
        diagnostics.push({
          code: 'no-compatible-filament',
          slot,
          message: process
            ? `No visible filament preset is compatible with ${printer.name} and ${process.name}`
            : `A filament cannot be selected without a compatible process preset`,
        });
      }
    }

    return deepFreeze({
      printer,
      ...(process ? { process } : {}),
      filaments,
      substitutions,
      diagnostics: deduplicateDiagnostics(diagnostics),
      complete: process !== undefined && filaments.every((filament) => filament !== null),
    });
  }
}

export function presetId(vendor: string, kind: PresetKind, name: string): PresetId {
  return `preset:${encodeURIComponent(vendor)}:${kind}:${encodeURIComponent(name)}` as PresetId;
}

function parseCatalog(input: unknown, issues: PresetGraphIssue[]): PresetCatalogInput | undefined {
  if (!isPlainObject(input)) {
    issues.push({ code: 'invalid-catalog', path: '$', message: 'Preset catalog must be an object' });
    return undefined;
  }
  const catalog: Record<string, PresetCatalogInputGroup> = {};
  for (const [vendor, value] of Object.entries(input)) {
    if (!vendor.trim()) {
      issues.push({ code: 'invalid-group', path: '$', message: 'Preset vendor names must not be empty' });
      continue;
    }
    if (!isPlainObject(value)) {
      issues.push({
        code: 'invalid-group',
        path: `$.${vendor}`,
        message: 'Preset vendor group must be an object',
      });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!KINDS.includes(key as PresetKind)) {
        issues.push({
          code: 'invalid-group',
          path: `$.${vendor}.${key}`,
          message: `Unknown preset category ${JSON.stringify(key)}`,
        });
      }
    }
    const group: Partial<Record<PresetKind, readonly unknown[]>> = {};
    for (const kind of KINDS) {
      const entries = value[kind];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) {
        issues.push({
          code: 'invalid-group',
          path: `$.${vendor}.${kind}`,
          message: 'Preset category must be an array',
        });
      } else {
        group[kind] = entries;
      }
    }
    catalog[vendor] = group;
  }
  return catalog;
}

function validateRelevantFields(
  raw: PresetJsonObject,
  kind: PresetKind,
  path: string,
  issues: PresetGraphIssue[],
): void {
  for (const key of ['name', 'inherits', 'from', 'compatible_printers_condition', 'compatible_prints_condition']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      issues.push({
        code: 'invalid-profile',
        path: `${path}.${key}`,
        message: `${key} must be a string`,
      });
    }
  }
  if (raw.type !== undefined && raw.type !== kind) {
    issues.push({
      code: 'invalid-profile',
      path: `${path}.type`,
      message: `Profile type must match category ${kind}`,
    });
  }
  for (const key of ['compatible_printers', 'compatible_prints', 'default_filament_profile', 'excluded_printers']) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      issues.push({
        code: 'invalid-profile',
        path: `${path}.${key}`,
        message: `${key} must be an array of strings`,
      });
    }
  }
  if (
    raw.instantiation !== undefined &&
    raw.instantiation !== true &&
    raw.instantiation !== false &&
    raw.instantiation !== 'true' &&
    raw.instantiation !== 'false'
  ) {
    issues.push({
      code: 'invalid-profile',
      path: `${path}.instantiation`,
      message: 'instantiation must be true, false, "true", or "false"',
    });
  }
}

function detectInheritanceProblems(records: readonly MutableRecord[], issues: PresetGraphIssue[]): void {
  const byId = new Map(records.map((record) => [record.id, record]));
  const state = new Map<PresetId, 'visiting' | 'visited'>();
  const reportedCycles = new Set<string>();

  const visit = (record: MutableRecord, stack: readonly PresetId[]): void => {
    if (state.get(record.id) === 'visited') return;
    if (stack.length >= MAX_INHERITANCE_DEPTH) {
      issues.push({
        code: 'inheritance-depth',
        path: pathFor(record, 'inherits'),
        message: `Preset inheritance exceeds ${MAX_INHERITANCE_DEPTH} levels`,
      });
      return;
    }
    if (state.get(record.id) === 'visiting') {
      const start = stack.indexOf(record.id);
      const cycleIds = [...stack.slice(Math.max(0, start)), record.id];
      const key = [...new Set(cycleIds)].sort().join('|');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        issues.push({
          code: 'inheritance-cycle',
          path: pathFor(record, 'inherits'),
          message: `Preset inheritance cycle: ${cycleIds.map((id) => byId.get(id)?.name ?? id).join(' -> ')}`,
        });
      }
      return;
    }
    state.set(record.id, 'visiting');
    const parent = record.parentId ? byId.get(record.parentId) : undefined;
    if (parent) visit(parent, [...stack, record.id]);
    state.set(record.id, 'visited');
  };
  for (const record of records) visit(record, []);
}

function chooseProcessReplacement(
  candidates: readonly PresetNode[],
  previous: PresetNode | undefined,
  preferredName: string | undefined,
): PresetNode | undefined {
  return chooseHighest(candidates, (candidate) => {
    if (candidate.isDefault || candidate.source === 'external') return 0;
    const previousAlias = optionalString(previous?.effective.alias);
    const candidateAlias = optionalString(candidate.effective.alias);
    if (previousAlias && candidateAlias === previousAlias) return MAX_MATCH_QUALITY;
    let score = candidate.name === preferredName ? 2 : 1;
    const previousLayerHeight = numericScalar(previous?.effective.layer_height);
    const candidateLayerHeight = numericScalar(candidate.effective.layer_height);
    if (
      previousLayerHeight !== undefined &&
      previousLayerHeight > 0 &&
      candidateLayerHeight !== undefined &&
      Math.abs(candidateLayerHeight - previousLayerHeight) < 0.0005
    ) {
      score *= 10;
    }
    return score;
  });
}

function chooseFilamentReplacement(
  candidates: readonly PresetNode[],
  previous: PresetNode | undefined,
  preferredName: string | undefined,
): PresetNode | undefined {
  return chooseHighest(candidates, (candidate) => {
    if (candidate.isDefault || candidate.source === 'external') return 0;
    const previousAlias = optionalString(previous?.effective.alias);
    const candidateAlias = optionalString(candidate.effective.alias);
    if (previousAlias && candidateAlias === previousAlias) return MAX_MATCH_QUALITY;
    let score = candidate.name === preferredName ? 2 : 1;
    const previousType = firstString(previous?.effective.filament_type);
    const candidateType = firstString(candidate.effective.filament_type);
    if (previousType && candidateType === previousType) score *= 10;
    return score;
  });
}

function chooseHighest(
  candidates: readonly PresetNode[],
  score: (candidate: PresetNode) => number,
): PresetNode | undefined {
  let best: PresetNode | undefined;
  let bestScore = -1;
  for (const candidate of [...candidates].sort(compareNodes)) {
    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

function evaluateCondition(
  expression: string,
  candidate: PresetNode,
  activePrinter: PresetNode,
  activePrint: PresetNode | undefined,
  evaluator: PresetConditionEvaluator | undefined,
): PresetCompatibilityAssessment {
  if (!evaluator) {
    return deepFreeze({
      status: 'unresolved',
      reason: 'condition-evaluator-missing',
      expression,
    });
  }
  try {
    const matched = evaluator(expression, {
      candidate,
      activePrinter,
      ...(activePrint ? { activePrint } : {}),
      extraConfig: {
        printerPreset: activePrinter.name,
        ...(nozzleCount(activePrinter) > 0 ? { numExtruders: nozzleCount(activePrinter) } : {}),
      },
    });
    return deepFreeze({
      status: matched ? 'compatible' : 'incompatible',
      reason: matched ? 'condition-true' : 'condition-false',
      expression,
    });
  } catch {
    return deepFreeze({
      status: 'unresolved',
      reason: 'condition-evaluation-failed',
      expression,
    });
  }
}

function frozenAssessment(
  status: PresetCompatibilityAssessment['status'],
  reason: PresetCompatibilityAssessment['reason'],
): PresetCompatibilityAssessment {
  return Object.freeze({ status, reason });
}

function sourceOf(raw: PresetJsonObject): PresetSource {
  const source = optionalString(raw.from)?.toLocaleLowerCase('en-US');
  if (source === 'system' || source === 'user' || source === 'project' || source === 'external') return source;
  if (source === 'default') return 'default';
  return 'unknown';
}

function nozzleCount(printer: PresetNode): number {
  const value = printer.effective.nozzle_diameter;
  return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}

function stringList(value: PresetJsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function firstString(value: PresetJsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return stringList(value)[0];
}

function numericScalar(value: PresetJsonValue | undefined): number | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar === 'number' && Number.isFinite(scalar)) return scalar;
  if (typeof scalar === 'string' && scalar.trim()) {
    const parsed = Number(scalar);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function optionalString(value: PresetJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cloneJsonObject(value: unknown, path: string, issues: PresetGraphIssue[]): PresetJsonObject | undefined {
  if (!isPlainObject(value)) {
    issues.push({ code: 'invalid-profile', path, message: 'Preset payload must be an object' });
    return undefined;
  }
  try {
    return deepFreeze(cloneJsonObjectUnchecked(value));
  } catch (error) {
    issues.push({
      code: 'invalid-profile',
      path,
      message: error instanceof Error ? error.message : 'Preset payload is not valid JSON',
    });
    return undefined;
  }
}

function cloneJsonObjectUnchecked(value: Readonly<Record<string, unknown>>): PresetJsonObject {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child, `.${key}`)]));
}

function cloneJsonValue(value: unknown, path: string): PresetJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`));
  if (isPlainObject(value)) return cloneJsonObjectUnchecked(value);
  throw new Error(`Unsupported ${typeof value} value at ${path}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deduplicateDiagnostics(
  diagnostics: readonly PresetSelectionDiagnostic[],
): readonly PresetSelectionDiagnostic[] {
  const unique = new Map<string, PresetSelectionDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}|${diagnostic.presetId ?? ''}|${diagnostic.slot ?? ''}`;
    unique.set(key, diagnostic);
  }
  return Object.freeze([...unique.values()].map((diagnostic) => Object.freeze({ ...diagnostic })));
}

function scopedName(vendor: string, kind: PresetKind, name: string): string {
  return `${vendor}\u0000${kind}\u0000${name}`;
}

function kindAndName(kind: PresetKind, name: string): string {
  return `${kind}\u0000${name}`;
}

function pathFor(record: MutableRecord, field: string): string {
  return `${record.path}.${field}`;
}

function compareNodes(left: PresetNode, right: PresetNode): number {
  return (
    left.kind.localeCompare(right.kind, 'en') ||
    left.name.localeCompare(right.name, 'en') ||
    left.vendor.localeCompare(right.vendor, 'en') ||
    left.id.localeCompare(right.id, 'en')
  );
}

function compareAuxiliary(left: PresetAuxiliaryPayload, right: PresetAuxiliaryPayload): number {
  return (
    left.kind.localeCompare(right.kind, 'en') ||
    left.vendor.localeCompare(right.vendor, 'en') ||
    left.id.localeCompare(right.id, 'en')
  );
}

function freezeIssues(issues: readonly PresetGraphIssue[]): readonly PresetGraphIssue[] {
  return Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
