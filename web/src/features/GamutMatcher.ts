import { GamutRecipe, GamutCandidate } from './FullSpectrumGamut';
import { MixedFilamentEntry } from './MixedFilamentStore';

export enum MatchQuality {
    EXACT, CLOSE, APPROXIMATE, OUT_OF_GAMUT
}

export interface GamutMatch {
    sourceIndex: number;
    sourceHex: string;
    targetHex: string;
    recipe: GamutRecipe;
    deltaE: number;
    quality: MatchQuality;
}

export interface FilamentEntry {
    physicalSlot?: number | null;
    virtualSlot?: number | null;
    colorHex: string;
}

export interface ApplyResult {
    filaments: FilamentEntry[];
    virtualRows: MixedFilamentEntry[];
}

export class GamutMatcher {
    private static DELTA_E_EXACT = 1.0;
    private static DELTA_E_CLOSE = 3.0;
    private static DELTA_E_APPROXIMATE = 8.0;

    static enumerateGamut(
        physicalColors: string[],
        mixStepPercent: number = 10,
        blend: (components: {hex: string, weight: number}[]) => string = GamutMatcher.blendComponentsHex
    ): GamutCandidate[] {
        const out: GamutCandidate[] = [];
        physicalColors.forEach((hex, i) => {
            out.push({ hex: GamutMatcher.normalizeHex(hex), recipe: { type: 'Physical', physicalSlot0: i } });
        });

        const step = Math.max(5, Math.min(50, mixStepPercent));
        const n = physicalColors.length;
        
        for (let a = 0; a < n; a++) {
            const ah = physicalColors[a];
            for (let b = a + 1; b < n; b++) {
                const bh = physicalColors[b];
                let mixB = step;
                while (mixB <= 100 - step) {
                    const wB = mixB / 100.0;
                    const hex = blend([
                        { hex: ah, weight: 1.0 - wB },
                        { hex: bh, weight: wB }
                    ]);
                    out.push({
                        hex: GamutMatcher.normalizeHex(hex),
                        recipe: { type: 'Blend', componentA1: a + 1, componentB1: b + 1, mixBPercent: mixB }
                    });
                    mixB += step;
                }
            }
        }
        return out;
    }

    static matchModelColors(
        sourceColors: string[],
        physicalColors: string[],
        mixStepPercent: number = 10,
        blendDeltaEMargin: number = 0.5,
        blend: (components: {hex: string, weight: number}[]) => string = GamutMatcher.blendComponentsHex
    ): GamutMatch[] {
        const gamut = this.enumerateGamut(physicalColors, mixStepPercent, blend);
        
        return sourceColors.map((src, idx) => {
            if (gamut.length === 0) {
                return {
                    sourceIndex: idx,
                    sourceHex: GamutMatcher.normalizeHex(src),
                    targetHex: GamutMatcher.normalizeHex(src),
                    recipe: { type: 'Keep' },
                    deltaE: Number.MAX_VALUE,
                    quality: MatchQuality.OUT_OF_GAMUT
                };
            }

            let bestPhysical: { cand: GamutCandidate, d: number } | null = null;
            let bestOverall: { cand: GamutCandidate, d: number } | null = null;

            for (const c of gamut) {
                // Mock ciede2000 distance for simplicity in TS if no ColorScience available
                const d = GamutMatcher.mockDistance(src, c.hex);
                
                if (!bestOverall || d < bestOverall.d) {
                    bestOverall = { cand: c, d };
                }
                if (c.recipe.type === 'Physical' && (!bestPhysical || d < bestPhysical.d)) {
                    bestPhysical = { cand: c, d };
                }
            }

            const phys = bestPhysical;
            const overall = bestOverall!;
            let chosen = overall;

            if (phys && overall.cand.recipe.type !== 'Physical') {
                if (phys.d - overall.d <= blendDeltaEMargin) {
                    chosen = phys;
                }
            } else if (!overall) {
                chosen = phys!;
            }

            return {
                sourceIndex: idx,
                sourceHex: GamutMatcher.normalizeHex(src),
                targetHex: chosen.cand.hex,
                recipe: chosen.cand.recipe,
                deltaE: chosen.d,
                quality: this.classify(chosen.d)
            };
        });
    }

    static classify(deltaE: number): MatchQuality {
        if (deltaE <= this.DELTA_E_EXACT) return MatchQuality.EXACT;
        if (deltaE <= this.DELTA_E_CLOSE) return MatchQuality.CLOSE;
        if (deltaE <= this.DELTA_E_APPROXIMATE) return MatchQuality.APPROXIMATE;
        return MatchQuality.OUT_OF_GAMUT;
    }

    static applyGamutMatches(
        filaments: FilamentEntry[],
        virtualRows: MixedFilamentEntry[],
        matches: GamutMatch[],
        distributionMode: number = 0
    ): ApplyResult {
        const rows = [...virtualRows];

        const ensureBlendRow = (a1: number, b1: number, mixB: number): number => {
            const existing = rows.findIndex(it => 
                !it.deleted && 
                (!it.gradientComponentIds || it.gradientComponentIds === '') && 
                (!it.manualPattern || it.manualPattern === '') &&
                it.componentA === a1 && 
                it.componentB === b1 && 
                it.mixBPercent === mixB
            );
            if (existing >= 0) return existing + 1;
            
            rows.push({
                id: `match_${a1}_${b1}_${mixB}`,
                componentA: a1,
                componentB: b1,
                mixBPercent: mixB,
                distributionMode: distributionMode,
                enabled: true,
                custom: true
            });
            return rows.length;
        };

        const byIndex = new Map(matches.map(m => [m.sourceIndex, m]));
        const updated = filaments.map((f, i) => {
            const recipe = byIndex.get(i)?.recipe;
            if (recipe?.type === 'Physical') {
                return { ...f, physicalSlot: recipe.physicalSlot0, virtualSlot: null };
            } else if (recipe?.type === 'Blend') {
                const slot1 = ensureBlendRow(recipe.componentA1, recipe.componentB1, recipe.mixBPercent);
                return { ...f, physicalSlot: null, virtualSlot: slot1 };
            }
            return { ...f };
        });

        return { filaments: updated, virtualRows: rows };
    }

    static normalizeHex(s: string): string {
        let h = s.trim().replace(/^#/, '').padStart(6, '0').substring(0, 6);
        return `#${h.toUpperCase()}`;
    }

    static blendComponentsHex(components: {hex: string, weight: number}[]): string {
        const srgbToLinearByte = (c: number) => {
            const s = c / 255.0;
            return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        const linearToSrgbByte = (l: number) => {
            const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1.0 / 2.4) - 0.055;
            return Math.round(Math.max(0, Math.min(1, s)) * 255);
        };
        
        let rLin = 0, gLin = 0, bLin = 0;
        let totalWeight = 0;
        for (const c of components) {
            if (c.weight > 0) totalWeight += c.weight;
        }
        if (totalWeight <= 0) return "#FFFFFF";

        for (const c of components) {
            if (c.weight <= 0) continue;
            const w = c.weight / totalWeight;
            const h = GamutMatcher.normalizeHex(c.hex).substring(1);
            rLin += srgbToLinearByte(parseInt(h.substring(0, 2), 16)) * w;
            gLin += srgbToLinearByte(parseInt(h.substring(2, 4), 16)) * w;
            bLin += srgbToLinearByte(parseInt(h.substring(4, 6), 16)) * w;
        }

        const r = linearToSrgbByte(rLin).toString(16).padStart(2, '0');
        const g = linearToSrgbByte(gLin).toString(16).padStart(2, '0');
        const b = linearToSrgbByte(bLin).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`.toUpperCase();
    }

    static mockDistance(hex1: string, hex2: string): number {
        // Very basic Euclidean distance in RGB just for the TS implementation
        const c1 = GamutMatcher.normalizeHex(hex1).substring(1);
        const c2 = GamutMatcher.normalizeHex(hex2).substring(1);
        const r1 = parseInt(c1.substring(0, 2), 16);
        const g1 = parseInt(c1.substring(2, 4), 16);
        const b1 = parseInt(c1.substring(4, 6), 16);
        const r2 = parseInt(c2.substring(0, 2), 16);
        const g2 = parseInt(c2.substring(2, 4), 16);
        const b2 = parseInt(c2.substring(4, 6), 16);
        
        return Math.sqrt(Math.pow(r1-r2, 2) + Math.pow(g1-g2, 2) + Math.pow(b1-b2, 2)) / 25.5; // Roughly scale to 0-10
    }
}
