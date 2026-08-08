import type { EngineOptionValue } from '../generated/types';
import type { SettingsValidationIssue, SettingsValueMap } from './types';

/**
 * GUI/runtime semantics audited against the pinned Snapmaker Orca source.
 *
 * Keep this pin independent from the generated PrintConfig pin so a future
 * engine-pin update fails focused tests until the GUI-source rules are reviewed.
 */
export const FULL_SPECTRUM_SEMANTICS_SOURCE_COMMIT = '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626' as const;
export const FULL_SPECTRUM_PROJECT_UI_SOURCE_BLOB = '94ad6c3b2357c2f0bd2476265e83ea68babd6a9b' as const;

export const FULL_SPECTRUM_KEYS = Object.freeze({
  localZMode: 'dithering_local_z_mode',
  localZWholeObjects: 'dithering_local_z_whole_objects',
  localZInfill: 'dithering_local_z_infill',
  localZDirectMulticolor: 'dithering_local_z_direct_multicolor',
  heightLowerBound: 'mixed_filament_height_lower_bound',
  heightUpperBound: 'mixed_filament_height_upper_bound',
  definitions: 'mixed_filament_definitions',
} as const);

export type FullSpectrumLocalZDependentKey =
  | typeof FULL_SPECTRUM_KEYS.localZWholeObjects
  | typeof FULL_SPECTRUM_KEYS.localZInfill
  | typeof FULL_SPECTRUM_KEYS.localZDirectMulticolor;

export const FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS: readonly FullSpectrumLocalZDependentKey[] = Object.freeze([
  FULL_SPECTRUM_KEYS.localZWholeObjects,
  FULL_SPECTRUM_KEYS.localZInfill,
  FULL_SPECTRUM_KEYS.localZDirectMulticolor,
]);

/**
 * Narrow project-scope overlay proven by pinned Plater.cpp project-config reads
 * and writes at lines 5705-5708, 6434-6435, and 6527-6528. The Local-Z direct
 * key is independently emitted as exact Tab.cpp `set_project_bool` evidence.
 */
export const FULL_SPECTRUM_PROJECT_OVERRIDE_KEYS: readonly string[] = Object.freeze([
  FULL_SPECTRUM_KEYS.heightLowerBound,
  FULL_SPECTRUM_KEYS.heightUpperBound,
  FULL_SPECTRUM_KEYS.localZDirectMulticolor,
]);

export function isReviewedFullSpectrumProjectOverride(key: string): boolean {
  return FULL_SPECTRUM_PROJECT_OVERRIDE_KEYS.includes(key);
}

export interface FullSpectrumSettingsTransaction {
  /**
   * Keys explicitly changed by the caller. The dependency expansion runs only
   * when `dithering_local_z_mode` is one of these keys.
   */
  readonly changedKeys: readonly string[];
  /**
   * Effective typed values after applying the caller's explicit changes and
   * resolving inherited/default values.
   */
  readonly effectiveValues: SettingsValueMap;
}

export interface FullSpectrumSettingsTransactionExpansion {
  /** Effective values after applying the pinned implicit Local-Z mutations. */
  readonly effectiveValues: SettingsValueMap;
  /** Values the caller must add to the same atomic settings transaction. */
  readonly implicitValues: Readonly<Partial<Record<FullSpectrumLocalZDependentKey, boolean>>>;
  readonly implicitKeys: readonly FullSpectrumLocalZDependentKey[];
}

/**
 * Expand one typed settings transaction with the side effects in pinned
 * `Tab.cpp:1531-1561`.
 *
 * Enabling Local-Z turns infill subdivision on. Disabling it clears the whole
 * domain, infill, and direct-multicolor children. Pinned source gives these
 * implicit values precedence over conflicting child edits in the same event.
 */
export function expandFullSpectrumSettingsTransaction(
  transaction: FullSpectrumSettingsTransaction,
): FullSpectrumSettingsTransactionExpansion {
  const effectiveValues = cloneValueMap(transaction.effectiveValues);
  if (!transaction.changedKeys.includes(FULL_SPECTRUM_KEYS.localZMode)) {
    return freezeExpansion(effectiveValues, {});
  }

  const localZMode = effectiveValues[FULL_SPECTRUM_KEYS.localZMode];
  if (typeof localZMode !== 'boolean') {
    throw new TypeError(
      `Effective ${FULL_SPECTRUM_KEYS.localZMode} must be boolean before FullSpectrum transaction expansion`,
    );
  }

  const implicitValues: Partial<Record<FullSpectrumLocalZDependentKey, boolean>> = localZMode
    ? { [FULL_SPECTRUM_KEYS.localZInfill]: true }
    : {
        [FULL_SPECTRUM_KEYS.localZWholeObjects]: false,
        [FULL_SPECTRUM_KEYS.localZInfill]: false,
        [FULL_SPECTRUM_KEYS.localZDirectMulticolor]: false,
      };
  Object.assign(effectiveValues, implicitValues);
  return freezeExpansion(effectiveValues, implicitValues);
}

export interface FullSpectrumDependencyState {
  readonly key: FullSpectrumLocalZDependentKey;
  readonly controllerKey: typeof FULL_SPECTRUM_KEYS.localZMode;
  readonly controllerValue: true;
  /** Pinned Orca keeps the row visible and toggles only its enabled state. */
  readonly visible: true;
  readonly enabled: boolean;
  readonly applicable: boolean;
  readonly disabledReason?: 'requires-dithering-local-z-mode';
}

/**
 * Return the pinned enablement rule from `ConfigManipulation.cpp:776-781`.
 * Unmanaged keys return `undefined` so callers cannot accidentally infer a rule.
 */
export function getFullSpectrumDependencyState(
  key: string,
  effectiveValues: SettingsValueMap,
): FullSpectrumDependencyState | undefined {
  if (!isLocalZDependentKey(key)) return undefined;
  const enabled = effectiveValues[FULL_SPECTRUM_KEYS.localZMode] === true;
  return Object.freeze({
    key,
    controllerKey: FULL_SPECTRUM_KEYS.localZMode,
    controllerValue: true,
    visible: true,
    enabled,
    applicable: enabled,
    ...(!enabled ? { disabledReason: 'requires-dithering-local-z-mode' as const } : {}),
  });
}

export interface FullSpectrumCrossFieldValidationIssue extends SettingsValidationIssue {
  readonly relatedKeys: readonly [
    typeof FULL_SPECTRUM_KEYS.heightLowerBound,
    typeof FULL_SPECTRUM_KEYS.heightUpperBound,
  ];
}

/**
 * Validate the invariant enforced at engine use sites in
 * `PrintObject.cpp:3854-3862` and `PrintObjectSlice.cpp:3042-3053`.
 *
 * Scalar type/min/max validation remains the generated codec's responsibility;
 * this function reports only the relationship between two valid finite values.
 */
export function validateFullSpectrumCrossFields(
  effectiveValues: SettingsValueMap,
): readonly FullSpectrumCrossFieldValidationIssue[] {
  const lower = effectiveValues[FULL_SPECTRUM_KEYS.heightLowerBound];
  const upper = effectiveValues[FULL_SPECTRUM_KEYS.heightUpperBound];
  if (!isFiniteNumber(lower) || !isFiniteNumber(upper) || lower <= upper) return Object.freeze([]);

  return Object.freeze([
    Object.freeze({
      code: 'full-spectrum-height-bounds-order',
      path: FULL_SPECTRUM_KEYS.heightUpperBound,
      message: `Local-Z upper height bound (${upper}) must be greater than or equal to lower height bound (${lower})`,
      relatedKeys: Object.freeze([
        FULL_SPECTRUM_KEYS.heightLowerBound,
        FULL_SPECTRUM_KEYS.heightUpperBound,
      ]) as FullSpectrumCrossFieldValidationIssue['relatedKeys'],
    }),
  ]);
}

export interface FullSpectrumSpecialEditorRequirement {
  readonly key: typeof FULL_SPECTRUM_KEYS.definitions;
  readonly kind: 'structured-editor-required';
  readonly editorId: 'full-spectrum-recipes';
  readonly genericEditable: false;
  readonly unavailableReason: 'structured-editor:full-spectrum-recipes';
}

const DEFINITIONS_EDITOR_REQUIREMENT: FullSpectrumSpecialEditorRequirement = Object.freeze({
  key: FULL_SPECTRUM_KEYS.definitions,
  kind: 'structured-editor-required',
  editorId: 'full-spectrum-recipes',
  genericEditable: false,
  unavailableReason: 'structured-editor:full-spectrum-recipes',
});

/**
 * Honor `PrintConfig.cpp:4299-4305` (`gui_flags = "serialized"`): the opaque
 * definitions wire value belongs to the structured FullSpectrum recipe editor,
 * never to a generic string input.
 */
export function getFullSpectrumSpecialEditorRequirement(key: string): FullSpectrumSpecialEditorRequirement | undefined {
  return key === FULL_SPECTRUM_KEYS.definitions ? DEFINITIONS_EDITOR_REQUIREMENT : undefined;
}

function isLocalZDependentKey(key: string): key is FullSpectrumLocalZDependentKey {
  return FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS.some((candidate) => candidate === key);
}

function isFiniteNumber(value: EngineOptionValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function cloneValueMap(values: SettingsValueMap): Record<string, EngineOptionValue> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, cloneValue(value)]));
}

function cloneValue(value: EngineOptionValue): EngineOptionValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === 'object') return { ...value };
  return value;
}

function freezeExpansion(
  effectiveValues: Record<string, EngineOptionValue>,
  implicitValues: Partial<Record<FullSpectrumLocalZDependentKey, boolean>>,
): FullSpectrumSettingsTransactionExpansion {
  const frozenImplicitValues = Object.freeze({ ...implicitValues });
  const implicitKeys = Object.freeze(
    FULL_SPECTRUM_LOCAL_Z_DEPENDENT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(implicitValues, key)),
  );
  return Object.freeze({
    effectiveValues: deepFreeze(effectiveValues),
    implicitValues: frozenImplicitValues,
    implicitKeys,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
