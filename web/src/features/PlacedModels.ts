export interface PlacedVolume {
  id: string;
  source: string;
  type: number;
  translateXmm: number;
  translateYmm: number;
  translateZmm: number;
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
  scaleXPct: number;
  scaleYPct: number;
  scaleZPct: number;
}

export interface PlacedModel {
  id: string;
  label: string;
  translateXmm: number;
  translateYmm: number;
  translateZmm: number;
  rotXDeg: number;
  rotYDeg: number;
  rotZDeg: number;
  scaleXPct: number;
  scaleYPct: number;
  scaleZPct: number;
  volumes: PlacedVolume[];
  plateId: number;
  needsRepair?: boolean;
}

export function autoArrangeModels(models: PlacedModel[], gapMm: number = 5): PlacedModel[] {
  if (models.length === 0) return models;
  if (models.length === 1) {
    if (models[0].translateXmm === 0 && models[0].translateYmm === 0) return models;
    return [{ ...models[0], translateXmm: 0, translateYmm: 0 }];
  }
  const widths = models.map((m) => 50 * (m.scaleXPct / 100));
  const total = widths.reduce((a, b) => a + b, 0) + gapMm * (models.length - 1);
  let cursor = -total / 2;
  return models.map((m, i) => {
    const w = widths[i];
    const centerX = cursor + w / 2;
    cursor += w + gapMm;
    return { ...m, translateXmm: centerX, translateYmm: 0 };
  });
}
