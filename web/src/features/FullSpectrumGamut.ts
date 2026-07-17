import { MixedFilamentEntry } from './MixedFilamentStore';

export const MAX_PAINT_SLOTS = 16; // Typically OrcaSlicer limit

export interface PaletteSlot {
  id: number;
  hex: string;
}

export type GamutRecipe =
  | { type: 'Physical'; physicalSlot0: number }
  | { type: 'Blend'; componentA1: number; componentB1: number; mixBPercent: number }
  | { type: 'Keep' };

export interface GamutCandidate {
  hex: string;
  recipe: GamutRecipe;
}

export interface BuiltGamut {
  paletteSlots: PaletteSlot[];
  recipeOf: Map<number, GamutRecipe>;
  predictedHexOf: Map<number, string>;
  fallbackPhysicalOf: Map<number, number>;
  physicalCount: number;
}

export interface MaterializedGamut {
  remap: Map<number, number>;
  rows: MixedFilamentEntry[];
  overflowed: Set<number>;
}

export class FullSpectrumGamut {
  static build(physicalHex: string[], _mixStepPercent: number = 10, _maxSlots: number = MAX_PAINT_SLOTS): BuiltGamut {
    const physicalCount = physicalHex.length;
    const paletteSlots: PaletteSlot[] = [];
    const recipeOf = new Map<number, GamutRecipe>();
    const predictedHexOf = new Map<number, string>();
    const fallbackPhysicalOf = new Map<number, number>();

    if (physicalCount === 0) {
      return { paletteSlots, recipeOf, predictedHexOf, fallbackPhysicalOf, physicalCount };
    }

    physicalHex.forEach((hex, i) => {
      paletteSlots.push({ id: i + 1, hex });
    });

    // Mock enumerateGamut here since we don't have GamutMatcher loaded yet
    // GamutMatcher should actually provide candidates
    return { paletteSlots, recipeOf, predictedHexOf, fallbackPhysicalOf, physicalCount };
  }

  static materialize(
    usedSlots: Set<number>,
    built: BuiltGamut,
    existingRows: MixedFilamentEntry[],
    maxSlots: number = MAX_PAINT_SLOTS,
  ): MaterializedGamut {
    const rows = [...existingRows];
    const remap = new Map<number, number>();
    const overflowed = new Set<number>();

    const ensureBlendRow = (a1: number, b1: number, mixB: number): number => {
      const existing = rows.findIndex(
        (it) =>
          !it.deleted &&
          (!it.gradientComponentIds || it.gradientComponentIds === '') &&
          (!it.manualPattern || it.manualPattern === '') &&
          it.componentA === a1 &&
          it.componentB === b1 &&
          it.mixBPercent === mixB,
      );
      if (existing >= 0) return existing + 1;

      rows.push({
        id: `match_${a1}_${b1}_${mixB}`,
        componentA: a1,
        componentB: b1,
        mixBPercent: mixB,
        distributionMode: 0,
        enabled: true,
        custom: true,
      });
      return rows.length;
    };

    const sortedSlots = Array.from(usedSlots).sort((a, b) => a - b);
    for (const slot of sortedSlots) {
      const recipe = built.recipeOf.get(slot);
      if (!recipe || recipe.type !== 'Blend') continue;

      const rowIndex1 = ensureBlendRow(recipe.componentA1, recipe.componentB1, recipe.mixBPercent);
      const realId = built.physicalCount + rowIndex1;

      if (realId >= 1 && realId <= maxSlots) {
        remap.set(slot, realId);
      } else {
        remap.set(slot, built.fallbackPhysicalOf.get(slot) || 1);
        overflowed.add(slot);
      }
    }

    return { remap, rows, overflowed };
  }

  static remapPaint(slots: Uint8Array, built: BuiltGamut, m: MaterializedGamut): Uint8Array {
    const out = new Uint8Array(slots.length);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const recipe = built.recipeOf.get(s);
      if (!recipe || recipe.type !== 'Blend') {
        out[i] = s;
      } else if (m.remap.has(s)) {
        out[i] = m.remap.get(s)!;
      } else {
        out[i] = built.fallbackPhysicalOf.get(s) || s;
      }
    }
    return out;
  }
}
