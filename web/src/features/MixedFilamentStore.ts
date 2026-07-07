export interface MixedFilamentEntry {
    id: string;
    componentA: number;
    componentB: number;
    ratioA?: number;
    ratioB?: number;
    mixBPercent?: number;
    biasPercent?: number;
    manualPattern?: string;
    gradientComponentIds?: string;
    gradientComponentWeights?: string;
    distributionMode?: number;
    localZMaxSublayers?: number;
    pointillismAllFilaments?: boolean;
    enabled?: boolean;
    deleted?: boolean;
    custom?: boolean;
    originAuto?: boolean;
    displayColor?: string;
}

export class MixedFilamentStore {
    autoGeneratePairs(physicalCount: number): MixedFilamentEntry[] {
        if (physicalCount < 2) return [];
        const out: MixedFilamentEntry[] = [];
        for (let a = 1; a <= physicalCount; a++) {
            for (let b = a + 1; b <= physicalCount; b++) {
                out.push({
                    id: `auto_${a}_${b}`,
                    componentA: a,
                    componentB: b,
                    custom: false,
                    originAuto: true,
                    enabled: true
                });
            }
        }
        return out;
    }

    serializeMixedFilamentDefinitions(entries: MixedFilamentEntry[]): string {
        if (entries.length === 0) return "";

        const stableId64 = (s: string): number => {
            let hash = 0x811c9dc5; // FNV offset basis
            for (let i = 0; i < s.length; i++) {
                hash ^= s.charCodeAt(i);
                hash = (hash * 0x01000193) >>> 0; // FNV prime
            }
            return Math.max(1, hash);
        };

        const maxBiasMm = 0.35;
        const offsetsForBias = (biasPct: number): [number, number] => {
            const clamp = Math.max(-100, Math.min(100, biasPct));
            const biasMm = (clamp / 100) * maxBiasMm;
            if (biasMm > 1e-6) return [0, biasMm];
            if (biasMm < -1e-6) return [-biasMm, 0];
            return [0, 0];
        };

        const fmtOffset = (v: number): string => {
            let s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
            return s === '' ? '0' : s;
        };

        return entries.map(e => {
            const [aOff, bOff] = offsetsForBias(e.biasPercent || 0);
            const tokens = [
                e.componentA.toString(),
                e.componentB.toString(),
                e.enabled !== false ? "1" : "0",
                e.custom ? "1" : "0",
                Math.max(0, Math.min(100, e.mixBPercent ?? 50)).toString(),
                e.pointillismAllFilaments ? "1" : "0",
                "g" + (e.gradientComponentIds || ""),
                "w" + (e.gradientComponentWeights || ""),
                "m" + Math.max(0, Math.min(2, e.distributionMode ?? 0)).toString(),
                "z" + Math.max(0, e.localZMaxSublayers || 0).toString(),
                "xa" + fmtOffset(aOff),
                "xb" + fmtOffset(bOff),
                "d" + (e.deleted ? "1" : "0"),
                "o" + (e.originAuto ? "1" : "0"),
                "u" + stableId64(e.id).toString()
            ];
            if (e.manualPattern && e.manualPattern.trim() !== '') {
                tokens.push(e.manualPattern);
            }
            return tokens.join(",");
        }).join(";");
    }
}
