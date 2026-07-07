export enum EmbossMode {
    ADD = 0,
    SUB = 1,
}

export interface EmbossSpec {
    sizeMm: number;
    depthMm: number;
    type: 'text' | 'svg';
    fontFile?: string;
    text?: string;
    svgFile?: string;
}

export class EmbossOp {
    static identityTransform(): number[] {
        return [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ];
    }

    static transformForTopOfBbox(
        hostBboxMaxZmm: number,
        embossDepthMm: number,
        sinkDepthMm: number = 0,
        translateXmm: number = 0,
        translateYmm: number = 0,
    ): number[] {
        const tz = hostBboxMaxZmm - sinkDepthMm;
        return [
            1, 0, 0, translateXmm,
            0, 1, 0, translateYmm,
            0, 0, 1, tz,
            0, 0, 0, 1,
        ];
    }

    static compose(a: number[], b: number[]): number[] {
        if (a.length !== 16 || b.length !== 16) {
            throw new Error('compose expects two 16-float matrices');
        }
        const out = new Array(16).fill(0);
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
                let s = 0;
                for (let k = 0; k < 4; k++) {
                    s += a[row * 4 + k] * b[k * 4 + col];
                }
                out[row * 4 + col] = s;
            }
        }
        return out;
    }

    static rotationZ(degrees: number): number[] {
        const r = (degrees * Math.PI) / 180.0;
        const c = Math.cos(r);
        const s = Math.sin(r);
        return [
            c, -s, 0, 0,
            s,  c, 0, 0,
            0,  0, 1, 0,
            0,  0, 0, 1,
        ];
    }
}
