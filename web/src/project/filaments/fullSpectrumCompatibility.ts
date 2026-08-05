/**
 * Exact material-category table and symmetric compatibility matrix from
 * Snapmaker Orca v2.3.4 `MixedColorMatchHelpers.cpp` plus
 * `resources/profiles/Snapmaker/filament/filament_compatibility.json`.
 */

import type { PhysicalFilamentId } from '../domain/ids';
import type { PhysicalFilament } from '../domain/model';

export type FullSpectrumMaterialCategory = 'PLA' | 'ABS' | 'ASA' | 'PETG' | 'TPU' | 'PET' | 'PA' | 'PC' | 'SUPPORT';

export type FullSpectrumCompatibilityDecision =
  | { readonly allowed: true; readonly categories: readonly FullSpectrumMaterialCategory[] }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly firstId: PhysicalFilamentId;
      readonly secondId?: PhysicalFilamentId;
    };

const MATERIAL_CATEGORIES: Readonly<Record<string, FullSpectrumMaterialCategory>> = {
  PLA: 'PLA',
  'PLA-CF': 'PLA',
  ABS: 'ABS',
  ASA: 'ASA',
  PETG: 'PETG',
  'PETG-CF': 'PETG',
  PCTG: 'PETG',
  TPU: 'TPU',
  PET: 'PET',
  PA: 'PA',
  'PA-CF': 'PA',
  PC: 'PC',
  BVOH: 'SUPPORT',
  PVA: 'SUPPORT',
};

const PARTNERS: Readonly<Record<FullSpectrumMaterialCategory, readonly FullSpectrumMaterialCategory[]>> = {
  PLA: ['PC'],
  PETG: ['TPU', 'PET', 'ABS', 'ASA', 'PC'],
  TPU: ['PETG', 'PET'],
  PET: ['PETG', 'TPU', 'ABS', 'ASA', 'PC'],
  ABS: ['PETG', 'PET', 'ASA', 'PC', 'PA'],
  ASA: ['PETG', 'PET', 'ABS', 'PC', 'PA'],
  PC: ['PLA', 'PETG', 'PET', 'ABS', 'ASA', 'PA'],
  PA: ['ABS', 'ASA', 'PC'],
  SUPPORT: [],
};

export function fullSpectrumMaterialCategory(material: string): FullSpectrumMaterialCategory | undefined {
  return MATERIAL_CATEGORIES[material.trim().toUpperCase()];
}

export function inspectFullSpectrumCompatibility(
  physicalFilaments: readonly PhysicalFilament[],
  componentIds: readonly PhysicalFilamentId[],
): FullSpectrumCompatibilityDecision {
  const byId = new Map(physicalFilaments.map((filament) => [filament.id, filament]));
  const uniqueIds = componentIds.filter((id, index) => componentIds.indexOf(id) === index);
  const resolved: Array<{
    id: PhysicalFilamentId;
    category: FullSpectrumMaterialCategory;
  }> = [];
  for (const id of uniqueIds) {
    const filament = byId.get(id);
    if (!filament) {
      return { allowed: false, reason: `Physical component ${id} is missing.`, firstId: id };
    }
    const category = fullSpectrumMaterialCategory(filament.material);
    if (!category) {
      return {
        allowed: false,
        reason: `Material ${filament.material || '(empty)'} on ${filament.name} is not in the pinned compatibility table.`,
        firstId: id,
      };
    }
    resolved.push({ id, category });
  }
  for (let first = 0; first < resolved.length; first += 1) {
    for (let second = first + 1; second < resolved.length; second += 1) {
      const left = resolved[first];
      const right = resolved[second];
      if (left.category === right.category || PARTNERS[left.category].includes(right.category)) continue;
      return {
        allowed: false,
        reason: `${left.category} and ${right.category} cannot be mixed by the pinned Snapmaker compatibility matrix.`,
        firstId: left.id,
        secondId: right.id,
      };
    }
  }
  return { allowed: true, categories: Object.freeze(resolved.map((entry) => entry.category)) };
}

export function requireFullSpectrumCompatibility(
  physicalFilaments: readonly PhysicalFilament[],
  componentIds: readonly PhysicalFilamentId[],
): void {
  const decision = inspectFullSpectrumCompatibility(physicalFilaments, componentIds);
  if (!decision.allowed) throw new Error(decision.reason);
}
