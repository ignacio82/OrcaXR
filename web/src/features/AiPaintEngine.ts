export interface PrimitiveResult {
    triangleIndices: Int32Array;
    matchedCount: number;
    truncated: boolean;
}

export enum SlabAxis { X, Y, Z }
export enum SlabTest { Centroid, AnyVertex, AllVertices }
export enum ConeSign { Outward, Inward, Both }

export class AiPaintEngine {
    private static readonly EPS_COS = 1e-6;

    public static sphere(
        bvh: any,
        centerX: number, centerY: number, centerZ: number,
        radiusMm: number,
        backFaceFilter: boolean = false
    ): Int32Array {
        if (bvh.triCount === 0 || radiusMm <= 0) return new Int32Array(0);
        const r2 = radiusMm * radiusMm;
        const candidates = bvh.aabbOverlapTriangles(
            centerX - radiusMm, centerY - radiusMm, centerZ - radiusMm,
            centerX + radiusMm, centerY + radiusMm, centerZ + radiusMm
        );
        const out: number[] = [];
        for (const ti of candidates) {
            const c = bvh.triangleCentroid(ti);
            const dx = c.x - centerX, dy = c.y - centerY, dz = c.z - centerZ;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            
            if (backFaceFilter) {
                const n = bvh.triangleNormal(ti);
                const dot = n.x * dx + n.y * dy + n.z * dz;
                if (dot > 0) continue;
            }
            out.push(ti);
        }
        return new Int32Array(out);
    }

    public static slab(
        bvh: any,
        axis: SlabAxis,
        minMm: number, maxMm: number,
        test: SlabTest = SlabTest.Centroid
    ): Int32Array {
        if (bvh.triCount === 0) return new Int32Array(0);
        const lo = Math.min(minMm, maxMm);
        const hi = Math.max(minMm, maxMm);
        const out: number[] = [];
        
        for (let i = 0; i < bvh.triCount; i++) {
            if (test === SlabTest.Centroid) {
                const c = bvh.triangleCentroid(i);
                const a = axis === SlabAxis.X ? c.x : axis === SlabAxis.Y ? c.y : c.z;
                if (a >= lo && a <= hi) out.push(i);
            } else {
                if (this.vertexAxisInRange(bvh, i, axis, lo, hi, test === SlabTest.AllVertices)) {
                    out.push(i);
                }
            }
        }
        return new Int32Array(out);
    }

    public static normalCone(
        bvh: any,
        dirX: number, dirY: number, dirZ: number,
        halfAngleDeg: number,
        sign: ConeSign = ConeSign.Outward
    ): Int32Array {
        if (bvh.triCount === 0) return new Int32Array(0);
        const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
        if (len < 1e-7) return new Int32Array(0);
        
        const nxRef = dirX / len, nyRef = dirY / len, nzRef = dirZ / len;
        const theta = Math.max(0, Math.min(90, halfAngleDeg));
        const cosThreshold = Math.cos(theta * Math.PI / 180) - this.EPS_COS;
        const out: number[] = [];
        
        for (let i = 0; i < bvh.triCount; i++) {
            const n = bvh.triangleNormal(i);
            if (n.x === 0 && n.y === 0 && n.z === 0) continue;
            
            const dot = n.x * nxRef + n.y * nyRef + n.z * nzRef;
            let match = false;
            switch (sign) {
                case ConeSign.Outward: match = dot >= cosThreshold; break;
                case ConeSign.Inward: match = dot <= -cosThreshold; break;
                case ConeSign.Both: match = Math.abs(dot) >= cosThreshold; break;
            }
            if (match) out.push(i);
        }
        return new Int32Array(out);
    }

    public static surfaceRegion(bvh: any, seedTri: number, maxDihedralDeg: number, maxTriangles: number = 65536): Int32Array {
        return bvh.smartFillBfs(seedTri, maxDihedralDeg, maxTriangles);
    }

    public static geodesicDisc(bvh: any, seedTri: number, radiusMm: number, maxDihedralDeg: number = 60, maxTriangles: number = 65536): Int32Array {
        return bvh.geodesicDisc(seedTri, radiusMm, maxDihedralDeg, maxTriangles);
    }

    public static connectedComponent(bvh: any, seedTri: number, maxTriangles: number = 1500000): Int32Array {
        return bvh.connectedComponent(seedTri, maxTriangles);
    }

    public static triangleList(triCount: number, ids: Int32Array): { indices: Int32Array, droppedOutOfRange: number } {
        if (triCount <= 0 || ids.length === 0) return { indices: new Int32Array(0), droppedOutOfRange: ids.length };
        let dropped = 0;
        const seen = new Set<number>();
        for (const id of ids) {
            if (id < 0 || id >= triCount) dropped++;
            else seen.add(id);
        }
        const arr = Array.from(seen).sort((a, b) => a - b);
        return { indices: new Int32Array(arr), droppedOutOfRange: dropped };
    }

    private static vertexAxisInRange(bvh: any, tri: number, axis: SlabAxis, lo: number, hi: number, requireAll: boolean): boolean {
        let anyIn = false;
        let allIn = true;
        for (let v = 0; v < 3; v++) {
            const p = bvh.triangleVertex(tri, v);
            const a = axis === SlabAxis.X ? p.x : axis === SlabAxis.Y ? p.y : p.z;
            const inRange = a >= lo && a <= hi;
            anyIn = anyIn || inRange;
            allIn = allIn && inRange;
        }
        return requireAll ? allIn : anyIn;
    }
}
