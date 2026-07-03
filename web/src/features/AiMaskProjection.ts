export enum DepthMode {
    FrontFacingOnly,
    AllHits,
    AnyFacing,
    FrontPlusThin
}

export interface CameraSpec {
    widthPx: number;
    heightPx: number;
    projMatrixRowMajor: Float32Array;
    viewMatrixRowMajor: Float32Array;
}

export class AiMaskProjection {
    public static project(
        bvh: any,
        camera: CameraSpec,
        mask: boolean[],
        depthMode: DepthMode | { type: 'FrontPlusThin', thicknessMm: number } = DepthMode.FrontFacingOnly,
        backFaceFilter: boolean = true
    ): Int32Array {
        const w = camera.widthPx;
        const h = camera.heightPx;
        if (mask.length !== w * h) throw new Error("mask must be width*height booleans");
        
        const mvp = this.matMulRowMajor(camera.projMatrixRowMajor, camera.viewMatrixRowMajor);
        const invMVP = this.invert4x4(mvp);
        if (!invMVP) return new Int32Array(0);
        
        const invView = this.invert4x4(camera.viewMatrixRowMajor);
        if (!invView) return new Int32Array(0);
        
        const camOrigin = { x: invView[3], y: invView[7], z: invView[11] };
        const hits = new Set<number>();
        
        let idx = 0;
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                if (mask[idx]) {
                    this.castRay(bvh, invMVP, camOrigin, px, py, w, h, depthMode, backFaceFilter, hits);
                }
                idx++;
            }
        }
        
        const out = Array.from(hits).sort((a, b) => a - b);
        return new Int32Array(out);
    }

    private static castRay(
        bvh: any,
        invMVP: Float32Array,
        camOrigin: any,
        px: number, py: number,
        width: number, height: number,
        depthMode: any,
        backFaceFilter: boolean,
        out: Set<number>
    ) {
        const ndcX = 2 * (px + 0.5) / width - 1;
        const ndcY = 1 - 2 * (py + 0.5) / height;
        const far = this.unprojectNdc(invMVP, ndcX, ndcY, 1);
        if (!far) return;
        
        const dx = far.x - camOrigin.x;
        const dy = far.y - camOrigin.y;
        const dz = far.z - camOrigin.z;
        const dir = { x: dx, y: dy, z: dz };
        
        if (depthMode === DepthMode.FrontFacingOnly) {
            const tri = bvh.intersect(camOrigin, dir);
            if (tri === null) return;
            if (backFaceFilter) {
                const n = bvh.triangleNormal(tri);
                const dot = n.x * dx + n.y * dy + n.z * dz;
                if (dot >= 0) return;
            }
            out.add(tri);
        } else if (depthMode === DepthMode.AllHits || depthMode === DepthMode.AnyFacing) {
            const tris = bvh.intersectAll(camOrigin, dir);
            for (const t of tris) {
                if (depthMode === DepthMode.AllHits && backFaceFilter) {
                    const n = bvh.triangleNormal(t);
                    if (n.x * dx + n.y * dy + n.z * dz >= 0) continue;
                }
                if (depthMode === DepthMode.AnyFacing) {
                    const n = bvh.triangleNormal(t);
                    if (n.x * dx + n.y * dy + n.z * dz >= 0) continue;
                }
                out.add(t);
            }
        } else if (typeof depthMode === 'object' && depthMode.type === 'FrontPlusThin') {
            const tris = bvh.intersectAll(camOrigin, dir);
            if (tris.length === 0) return;
            
            const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dirLen < 1e-7) return;
            const invDirLen = 1 / dirLen;
            
            const distance = (tri: number) => {
                const c = bvh.triangleCentroid(tri);
                const cx = c.x - camOrigin.x, cy = c.y - camOrigin.y, cz = c.z - camOrigin.z;
                return (cx * dx + cy * dy + cz * dz) * invDirLen;
            };
            
            let frontDist = Infinity;
            let frontTri = -1;
            
            for (const t of tris) {
                if (backFaceFilter) {
                    const n = bvh.triangleNormal(t);
                    if (n.x * dx + n.y * dy + n.z * dz >= 0) continue;
                }
                const d = distance(t);
                if (d < frontDist) {
                    frontDist = d;
                    frontTri = t;
                }
            }
            
            if (frontTri < 0) return;
            out.add(frontTri);
            
            const limit = frontDist + depthMode.thicknessMm;
            for (const t of tris) {
                if (t === frontTri) continue;
                const d = distance(t);
                if (d >= frontDist && d <= limit) out.add(t);
            }
        }
    }

    public static rasterizePolygons(
        polygons: Float32Array[],
        width: number, height: number
    ): boolean[] {
        const mask = new Array(width * height).fill(false);
        if (polygons.length === 0) return mask;
        
        for (let py = 0; py < height; py++) {
            const y = py + 0.5;
            const xs: number[] = [];
            
            for (const poly of polygons) {
                const n = Math.floor(poly.length / 2);
                if (n < 2) continue;
                let i = n - 1;
                for (let j = 0; j < n; j++) {
                    const xi = poly[i * 2], yi = poly[i * 2 + 1];
                    const xj = poly[j * 2], yj = poly[j * 2 + 1];
                    
                    const crosses = (yi <= y && yj > y) || (yj <= y && yi > y);
                    if (crosses) {
                        const t = (y - yi) / (yj - yi);
                        xs.push(xi + t * (xj - xi));
                    }
                    i = j;
                }
            }
            
            xs.sort((a, b) => a - b);
            
            let k = 0;
            while (k + 1 < xs.length) {
                const xLo = Math.max(0, xs[k]);
                const xHi = Math.min(width, xs[k + 1]);
                const ixLo = Math.floor(xLo);
                const ixHi = Math.floor(xHi);
                
                for (let px = ixLo; px <= Math.min(width - 1, ixHi); px++) {
                    mask[py * width + px] = true;
                }
                k += 2;
            }
        }
        return mask;
    }

    private static matMulRowMajor(a: Float32Array, b: Float32Array): Float32Array {
        const out = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let s = 0;
                for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
                out[i * 4 + j] = s;
            }
        }
        return out;
    }

    private static invert4x4(m: Float32Array): Float32Array | null {
        const a = m;
        const inv = new Float32Array(16);
        inv[0] = a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10];
        inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10];
        inv[8] = a[4]*a[9]*a[15] - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9];
        inv[12] = -a[4]*a[9]*a[14] + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9];
        inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10];
        inv[5] = a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10];
        inv[9] = -a[0]*a[9]*a[15] + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9];
        inv[13] = a[0]*a[9]*a[14] - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9];
        inv[2] = a[1]*a[6]*a[15] - a[1]*a[7]*a[14] - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7] - a[13]*a[3]*a[6];
        inv[6] = -a[0]*a[6]*a[15] + a[0]*a[7]*a[14] + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7] + a[12]*a[3]*a[6];
        inv[10] = a[0]*a[5]*a[15] - a[0]*a[7]*a[13] - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7] - a[12]*a[3]*a[5];
        inv[14] = -a[0]*a[5]*a[14] + a[0]*a[6]*a[13] + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6] + a[12]*a[2]*a[5];
        inv[3] = -a[1]*a[6]*a[11] + a[1]*a[7]*a[10] + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7] + a[9]*a[3]*a[6];
        inv[7] = a[0]*a[6]*a[11] - a[0]*a[7]*a[10] - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7] - a[8]*a[3]*a[6];
        inv[11] = -a[0]*a[5]*a[11] + a[0]*a[7]*a[9] + a[4]*a[1]*a[11] - a[4]*a[3]*a[9] - a[8]*a[1]*a[7] + a[8]*a[3]*a[5];
        inv[15] = a[0]*a[5]*a[10] - a[0]*a[6]*a[9] - a[4]*a[1]*a[10] + a[4]*a[2]*a[9] + a[8]*a[1]*a[6] - a[8]*a[2]*a[5];
        
        const det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12];
        if (Math.abs(det) < 1e-10) return null;
        
        const invDet = 1 / det;
        for (let i = 0; i < 16; i++) inv[i] *= invDet;
        return inv;
    }

    private static unprojectNdc(invMVP: Float32Array, ndcX: number, ndcY: number, ndcZ: number) {
        const x = invMVP[0] * ndcX + invMVP[1] * ndcY + invMVP[2] * ndcZ + invMVP[3];
        const y = invMVP[4] * ndcX + invMVP[5] * ndcY + invMVP[6] * ndcZ + invMVP[7];
        const z = invMVP[8] * ndcX + invMVP[9] * ndcY + invMVP[10] * ndcZ + invMVP[11];
        const w = invMVP[12] * ndcX + invMVP[13] * ndcY + invMVP[14] * ndcZ + invMVP[15];
        if (Math.abs(w) < 1e-7) return null;
        return { x: x / w, y: y / w, z: z / w };
    }
}
