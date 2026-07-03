export interface Stop {
    tLo: number;
    tHi: number;
    tag: number;
}

export class AiProceduralPaint {
    public static gradient(
        bvh: any, // Placeholder for MeshBvh
        dirX: number, dirY: number, dirZ: number,
        stops: Stop[]
    ): Int32Array[] {
        const triCount = bvh.triCount;
        if (triCount === 0 || stops.length === 0) return stops.map(() => new Int32Array(0));
        const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
        if (len < 1e-7) return stops.map(() => new Int32Array(0));
        
        const nx = dirX / len, ny = dirY / len, nz = dirZ / len;
        let tMin = Infinity;
        let tMax = -Infinity;
        
        for (let i = 0; i < triCount; i++) {
            const c = bvh.triangleCentroid(i);
            const t = c.x * nx + c.y * ny + c.z * nz;
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
        }
        
        if (!(tMax > tMin)) {
            return this.matchAtConstantT(triCount, stops, 0);
        }
        
        const invSpan = 1 / (tMax - tMin);
        const buckets: number[][] = stops.map(() => []);
        
        for (let i = 0; i < triCount; i++) {
            const c = bvh.triangleCentroid(i);
            const tRaw = c.x * nx + c.y * ny + c.z * nz;
            let t = (tRaw - tMin) * invSpan;
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            
            const bucket = stops.findIndex(stop => this.tInBand(t, stop));
            if (bucket >= 0) buckets[bucket].push(i);
        }
        
        return buckets.map(b => new Int32Array(b));
    }

    public static valueNoise(
        bvh: any,
        frequencyPerMm: number,
        seed: number,
        stops: Stop[]
    ): Int32Array[] {
        const triCount = bvh.triCount;
        if (triCount === 0 || stops.length === 0) return stops.map(() => new Int32Array(0));
        
        const freq = frequencyPerMm <= 0 ? 0.05 : frequencyPerMm;
        const buckets: number[][] = stops.map(() => []);
        
        for (let i = 0; i < triCount; i++) {
            const c = bvh.triangleCentroid(i);
            const n = this.sampleNoise(c.x * freq, c.y * freq, c.z * freq, seed);
            const bucket = stops.findIndex(stop => this.tInBand(n, stop));
            if (bucket >= 0) buckets[bucket].push(i);
        }
        
        return buckets.map(b => new Int32Array(b));
    }

    private static tInBand(t: number, stop: Stop): boolean {
        if (stop.tHi >= 1) return t >= stop.tLo && t <= stop.tHi;
        return t >= stop.tLo && t < stop.tHi;
    }

    private static matchAtConstantT(triCount: number, stops: Stop[], t: number): Int32Array[] {
        const buckets: number[][] = stops.map(() => []);
        const winner = stops.findIndex(s => this.tInBand(t, s));
        if (winner >= 0) {
            for (let i = 0; i < triCount; i++) {
                buckets[winner].push(i);
            }
        }
        return buckets.map(b => new Int32Array(b));
    }

    private static sampleNoise(x: number, y: number, z: number, seed: number): number {
        const xi = Math.floor(x) | 0;
        const yi = Math.floor(y) | 0;
        const zi = Math.floor(z) | 0;
        const fx = x - xi;
        const fy = y - yi;
        const fz = z - zi;
        
        const sx = this.smoothstep(fx);
        const sy = this.smoothstep(fy);
        const sz = this.smoothstep(fz);
        
        const c000 = this.corner(xi, yi, zi, seed);
        const c100 = this.corner(xi + 1, yi, zi, seed);
        const c010 = this.corner(xi, yi + 1, zi, seed);
        const c110 = this.corner(xi + 1, yi + 1, zi, seed);
        const c001 = this.corner(xi, yi, zi + 1, seed);
        const c101 = this.corner(xi + 1, yi, zi + 1, seed);
        const c011 = this.corner(xi, yi + 1, zi + 1, seed);
        const c111 = this.corner(xi + 1, yi + 1, zi + 1, seed);
        
        const ix00 = this.lerp(c000, c100, sx);
        const ix10 = this.lerp(c010, c110, sx);
        const ix01 = this.lerp(c001, c101, sx);
        const ix11 = this.lerp(c011, c111, sx);
        const iy0 = this.lerp(ix00, ix10, sy);
        const iy1 = this.lerp(ix01, ix11, sy);
        return this.lerp(iy0, iy1, sz);
    }

    private static smoothstep(t: number): number {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    private static lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    private static corner(x: number, y: number, z: number, seed: number): number {
        let h = seed | 0;
        h = this.mix(h, x);
        h = this.mix(h, y);
        h = this.mix(h, z);
        const u = (h >>> 8) & 0xFFFFFF;
        return u / 16777216;
    }

    private static mix(state: number, k: number): number {
        let s = state | 0;
        s = s ^ k;
        s = Math.imul(s, 0x5bd1e995);
        s = s ^ (s >>> 13);
        s = Math.imul(s, 0x27d4eb2f);
        s = s ^ (s >>> 15);
        return s;
    }
}
