import { PrimitiveKind } from './Primitives';

export enum MagnetShape {
  DISC = 'DISC',
  BLOCK = 'BLOCK',
}

export interface MagnetSpec {
  count: number;
  shape: MagnetShape;
  diameterMm?: number;
  discHeightMm?: number;
  blockXmm?: number;
  blockYmm?: number;
  blockZmm?: number;
  clearanceMm?: number;
  roofThicknessMm?: number;
  edgeMarginMm?: number;
}

export interface MagnetCavity {
  centerXmm: number;
  centerYmm: number;
}

export interface MagnetPlacement {
  cavities: MagnetCavity[];
  primitiveKind: PrimitiveKind;
  primitiveParams: number[];
  floorZmm: number;
  cavityTopZmm: number;
  pauseZmm: number;
  gridCols: number;
  gridRows: number;
  warnings: string[];
}

export class MagnetOp {
  static cavityDims(spec: MagnetSpec): [number, number, number] {
    if (spec.shape === MagnetShape.DISC) {
      const d = (spec.diameterMm || 0) + 2 * (spec.clearanceMm ?? 0.2);
      return [d, d, (spec.discHeightMm || 0) + (spec.clearanceMm ?? 0.2)];
    } else {
      return [
        (spec.blockXmm || 0) + 2 * (spec.clearanceMm ?? 0.2),
        (spec.blockYmm || 0) + 2 * (spec.clearanceMm ?? 0.2),
        (spec.blockZmm || 0) + (spec.clearanceMm ?? 0.2),
      ];
    }
  }

  static primitiveFor(spec: MagnetSpec, cavityHeightMm: number): [PrimitiveKind, number[]] {
    if (spec.shape === MagnetShape.DISC) {
      return [
        PrimitiveKind.CYLINDER,
        [((spec.diameterMm || 0) + 2 * (spec.clearanceMm ?? 0.2)) / 2, cavityHeightMm, 2],
      ];
    } else {
      return [
        PrimitiveKind.CUBE,
        [
          (spec.blockXmm || 0) + 2 * (spec.clearanceMm ?? 0.2),
          (spec.blockYmm || 0) + 2 * (spec.clearanceMm ?? 0.2),
          cavityHeightMm,
        ],
      ];
    }
  }

  static gridDims(n: number): [number, number] {
    const safe = Math.max(1, n);
    const cols = Math.max(1, Math.ceil(Math.sqrt(safe)));
    const rows = Math.max(1, Math.ceil(safe / cols));
    return [cols, rows];
  }

  static pauseZForCavityTop(cavityTopZmm: number, layerHeightMm: number, hostHeightMm: number): number {
    const lh = layerHeightMm > 0 ? layerHeightMm : 0.2;
    let z = Math.ceil(cavityTopZmm / lh) * lh;
    if (z <= cavityTopZmm + 1e-4) z += lh;
    return Math.min(z, hostHeightMm);
  }

  static placeCavities(
    footprintXmm: number,
    footprintYmm: number,
    hostHeightMm: number,
    spec: MagnetSpec,
    resolvedLayerHeightMm: number,
  ): MagnetPlacement {
    const warnings: string[] = [];
    const [cw, cd, chRaw] = MagnetOp.cavityDims(spec);
    const roof = Math.max(0, spec.roofThicknessMm ?? 0.8);

    let ch = chRaw;
    const maxCh = hostHeightMm - 2 * roof;
    if (ch > maxCh) {
      warnings.push(
        `Model too short: magnet pocket (${chRaw.toFixed(2)} mm) + 2×roof (${(2 * roof).toFixed(2)} mm) exceeds model height (${hostHeightMm.toFixed(2)} mm); pocket clamped.`,
      );
      ch = Math.max(0.1, maxCh);
    }
    const floorZ = roof;
    const cavityTopZ = floorZ + ch;

    const edgeMargin = spec.edgeMarginMm ?? 3;
    const rawUsableX = footprintXmm - 2 * edgeMargin - cw;
    const rawUsableY = footprintYmm - 2 * edgeMargin - cd;
    if (rawUsableX < 0 || rawUsableY < 0) {
      warnings.push('Magnet wider than inset footprint; cavities centered and may sit close to a side wall.');
    }
    const usableX = Math.max(0, rawUsableX);
    const usableY = Math.max(0, rawUsableY);

    const [cols, rows] = MagnetOp.gridDims(spec.count);
    const pitchX = cols > 1 ? usableX / (cols - 1) : 0;
    const pitchY = rows > 1 ? usableY / (rows - 1) : 0;
    const spanX = (cols - 1) * pitchX;
    const spanY = (rows - 1) * pitchY;

    const cavities: MagnetCavity[] = [];
    for (let k = 0; k < Math.max(1, spec.count); k++) {
      const r = Math.floor(k / cols);
      const c = k % cols;
      const x = -spanX / 2 + c * pitchX;
      const y = -spanY / 2 + r * pitchY;
      cavities.push({ centerXmm: x, centerYmm: y });
    }

    const [kind, params] = MagnetOp.primitiveFor(spec, ch);
    const pauseZ = MagnetOp.pauseZForCavityTop(cavityTopZ, resolvedLayerHeightMm, hostHeightMm);

    return {
      cavities,
      primitiveKind: kind,
      primitiveParams: params,
      floorZmm: floorZ,
      cavityTopZmm: cavityTopZ,
      pauseZmm: pauseZ,
      gridCols: cols,
      gridRows: rows,
      warnings,
    };
  }
}
