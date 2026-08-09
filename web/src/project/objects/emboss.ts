/**
 * Canonical text embossing (P5.3.3).
 *
 * Two independent halves, deliberately separated:
 *
 * 1. `EmbossTextConfiguration` mirrors the pinned `TextConfiguration` /
 *    `EmbossShape` fields that BBS 3MF stores on a volume, so a saved project
 *    reopens with the text still editable.
 * 2. `buildEmbossedMesh` turns glyph outlines into an extruded indexed mesh.
 *    It consumes contours through a port rather than reading a font itself, so
 *    the geometry is exercised without any font dependency and a browser font
 *    reader stays a replaceable adapter.
 *
 * A browser cannot enumerate installed fonts the way the pinned desktop GUI
 * does, so the font is always something the operator supplies. That is a
 * platform adaptation, recorded in the register — never a silent substitution
 * of some other typeface.
 */

import type { Vec3 } from '../domain/model';
import type { Contour } from './polygonTriangulation';
import { extrudeContours, extrudedBounds } from './extrude';

export const PINNED_EMBOSS_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  configuration: 'src/libslic3r/TextConfiguration.hpp',
  shape: 'src/libslic3r/EmbossShape.hpp',
  persistence: 'src/libslic3r/Format/bbs_3mf.cpp',
});

/** Pinned `FontProp::HorizontalAlign` / `VerticalAlign`. */
export type EmbossHorizontalAlign = 'left' | 'center' | 'right';
export type EmbossVerticalAlign = 'top' | 'center' | 'bottom';

/** Pinned `TextConfiguration::FontProperty`, in the units upstream stores. */
export interface EmbossFontProperty {
  /** Extra space between characters, in millimetres. */
  readonly charGapMm: number;
  /** Extra space between lines, in millimetres. */
  readonly lineGapMm: number;
  /** Cap height of one line, in millimetres. */
  readonly lineHeightMm: number;
  /** Outline expansion; 0 leaves the glyph as designed. */
  readonly boldnessMm: number;
  /** Italic shear as a ratio, not degrees, exactly as upstream stores it. */
  readonly skew: number;
  /** Emboss each glyph separately instead of the whole string as one shape. */
  readonly perGlyph: boolean;
  readonly horizontal: EmbossHorizontalAlign;
  readonly vertical: EmbossVerticalAlign;
  /** Font-collection index for a .ttc; 0 for an ordinary font. */
  readonly collection: number;
}

/** Pinned `EmbossProjection`. */
export interface EmbossProjection {
  /** Extrusion depth in millimetres. */
  readonly depthMm: number;
  /** Project the glyphs onto the model surface instead of a flat plane. */
  readonly useSurface: boolean;
}

/** Pinned `TextConfiguration::EmbossStyle` plus the text itself. */
export interface EmbossTextConfiguration {
  readonly text: string;
  readonly styleName: string;
  /** Opaque platform font handle exactly as stored; never parsed for meaning. */
  readonly fontDescriptor: string;
  readonly fontDescriptorType: string;
  readonly font: EmbossFontProperty;
  readonly projection: EmbossProjection;
  /** Optional face facts upstream records alongside the descriptor. */
  readonly family?: string;
  readonly faceName?: string;
  readonly style?: string;
  readonly weight?: string;
}

export const DEFAULT_EMBOSS_FONT_PROPERTY: EmbossFontProperty = Object.freeze({
  charGapMm: 0,
  lineGapMm: 0,
  lineHeightMm: 10,
  boldnessMm: 0,
  skew: 0,
  perGlyph: false,
  horizontal: 'center',
  vertical: 'center',
  collection: 0,
});

export const DEFAULT_EMBOSS_PROJECTION: EmbossProjection = Object.freeze({ depthMm: 1, useSurface: false });

export class EmbossError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-configuration' | 'no-glyphs' | 'degenerate-outline' | 'unsupported-font',
  ) {
    super(message);
    this.name = 'EmbossError';
  }
}

/** One closed contour in font units, already flattened to line segments. */
export interface GlyphContour {
  /** Ordered points; the closing edge back to the first point is implicit. */
  readonly points: readonly (readonly [number, number])[];
}

export interface GlyphOutline {
  /** Horizontal advance in font units. */
  readonly advance: number;
  readonly contours: readonly GlyphContour[];
}

/**
 * Supplies glyph outlines for a font the operator chose. Units are the font's
 * own; `unitsPerEm` normalizes them.
 */
export interface GlyphOutlineSource {
  readonly unitsPerEm: number;
  /** Undefined when the font has no glyph for this code point. */
  outline(codePoint: number): GlyphOutline | undefined;
}

export interface EmbossedMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly triangleCount: number;
  /** Code points the font had no glyph for, in first-seen order. */
  readonly missingCodePoints: readonly number[];
  /**
   * Edges belonging to exactly one triangle: an actual hole in the surface.
   *
   * A rare glyph — a contour that touches itself in a way no ear clipper can
   * resolve — comes out open, and a slicer will either repair it silently or
   * print something wrong. Reporting the count lets the caller say so instead.
   */
  readonly openEdgeCount: number;
  /**
   * Edges shared by more than two triangles.
   *
   * Distinct from an open edge and much less serious: two glyphs whose
   * outlines touch exactly — which a monospaced or zero-bearing face does —
   * meet along a coincident face. The solid is still closed, so this is
   * reported apart from `openEdgeCount` rather than lumped in with it.
   */
  readonly coincidentEdgeCount: number;
}

export function assertEmbossConfiguration(configuration: EmbossTextConfiguration): void {
  if (!configuration.text.length) throw new EmbossError('Embossed text cannot be empty', 'invalid-configuration');
  const font = configuration.font;
  for (const [field, value] of [
    ['lineHeightMm', font.lineHeightMm],
    ['charGapMm', font.charGapMm],
    ['lineGapMm', font.lineGapMm],
    ['boldnessMm', font.boldnessMm],
    ['skew', font.skew],
  ] as const) {
    if (!Number.isFinite(value)) throw new EmbossError(`${field} must be finite`, 'invalid-configuration');
  }
  if (font.lineHeightMm <= 0) throw new EmbossError('Line height must be greater than zero', 'invalid-configuration');
  if (!Number.isSafeInteger(font.collection) || font.collection < 0) {
    throw new EmbossError('Font collection index must be a non-negative integer', 'invalid-configuration');
  }
  if (!Number.isFinite(configuration.projection.depthMm) || configuration.projection.depthMm <= 0) {
    throw new EmbossError('Emboss depth must be greater than zero', 'invalid-configuration');
  }
}

/**
 * Lay the text out and extrude it. The result is centred on the origin in X/Y
 * according to the configured alignment and extruded along +Z from 0 to depth.
 */
export function buildEmbossedMesh(configuration: EmbossTextConfiguration, source: GlyphOutlineSource): EmbossedMesh {
  assertEmbossConfiguration(configuration);
  if (!Number.isFinite(source.unitsPerEm) || source.unitsPerEm <= 0) {
    throw new EmbossError('The font declares no usable units per em', 'unsupported-font');
  }
  const font = configuration.font;
  const scale = font.lineHeightMm / source.unitsPerEm;
  const missing: number[] = [];
  const seenMissing = new Set<number>();

  // Lay out lines of glyph contours in millimetres.
  const lines = configuration.text.split('\n');
  const placed: { contours: GlyphContour[]; widthMm: number }[] = [];
  for (const line of lines) {
    const contours: GlyphContour[] = [];
    let penMm = 0;
    for (const character of [...line]) {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) continue;
      const glyph = source.outline(codePoint);
      if (!glyph) {
        if (!seenMissing.has(codePoint)) {
          seenMissing.add(codePoint);
          missing.push(codePoint);
        }
        continue;
      }
      for (const contour of glyph.contours) {
        const points = contour.points.map(([x, y]): readonly [number, number] => {
          const scaledY = y * scale;
          // Upstream stores skew as a ratio applied along X by height.
          return [penMm + x * scale + scaledY * font.skew, scaledY];
        });
        if (points.length >= 3) contours.push({ points });
      }
      penMm += glyph.advance * scale + font.charGapMm;
    }
    placed.push({ contours, widthMm: Math.max(0, penMm - font.charGapMm) });
  }

  const lineStepMm = font.lineHeightMm + font.lineGapMm;
  const totalHeightMm = lines.length * font.lineHeightMm + Math.max(0, lines.length - 1) * font.lineGapMm;
  const widest = Math.max(0, ...placed.map((line) => line.widthMm));

  const placedContours: Contour[] = [];
  const depth = configuration.projection.depthMm;
  for (const [lineIndex, line] of placed.entries()) {
    const dx =
      font.horizontal === 'left'
        ? 0
        : font.horizontal === 'right'
          ? widest - line.widthMm
          : (widest - line.widthMm) / 2;
    const originX = font.horizontal === 'left' ? 0 : -widest / 2 + dx;
    // Lines run downward from the first one.
    const topOfBlock = font.vertical === 'top' ? 0 : font.vertical === 'bottom' ? totalHeightMm : totalHeightMm / 2;
    const baseline = topOfBlock - lineIndex * lineStepMm - font.lineHeightMm;
    for (const contour of line.contours) {
      placedContours.push(contour.points.map(([x, y]): readonly [number, number] => [x + originX, y + baseline]));
    }
  }

  const mesh = extrudeContours(placedContours, depth);
  if (mesh.triangleCount === 0) {
    throw new EmbossError(
      missing.length > 0
        ? 'The chosen font has no glyph for any character in this text'
        : 'This text produced no outline to emboss',
      'no-glyphs',
    );
  }
  return Object.freeze({ ...mesh, missingCodePoints: Object.freeze(missing) });
}

/** Axis-aligned bounds of an embossed mesh, in millimetres. */
export function embossedBounds(mesh: EmbossedMesh): { readonly min: Vec3; readonly max: Vec3 } {
  return extrudedBounds(mesh);
}
