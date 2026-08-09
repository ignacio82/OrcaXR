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
import { type Contour, signedArea, simplifyContour, triangulatePolygon } from './polygonTriangulation';

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

  const welder = new VertexWelder();
  const indices: number[] = [];
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
    const moved = line.contours.map((contour) =>
      contour.points.map(([x, y]): readonly [number, number] => [x + originX, y + baseline]),
    );
    for (const shape of groupContoursIntoShapes(moved)) {
      extrudeShape(shape, depth, welder, indices);
    }
  }

  if (indices.length === 0) {
    throw new EmbossError(
      missing.length > 0
        ? 'The chosen font has no glyph for any character in this text'
        : 'This text produced no outline to emboss',
      'no-glyphs',
    );
  }
  return Object.freeze({
    positions: Object.freeze(welder.positions),
    indices: Object.freeze(indices),
    triangleCount: indices.length / 3,
    missingCodePoints: Object.freeze(missing),
    ...auditEdges(indices),
  });
}

/** One filled outline with the counters that must stay open inside it. */
interface GlyphShape {
  readonly outer: Contour;
  readonly holes: Contour[];
}

/**
 * Sort a line's contours into filled shapes and their counters.
 *
 * TrueType fills by winding direction, not by nesting: an outline and its
 * counters run opposite ways. Classifying by nesting alone misreads glyphs
 * whose parts merely touch — the cedilla of ç, the bars of # — turning a
 * second solid piece into a hole and leaving the mesh open where it was cut.
 * So direction decides what is filled, and nesting only decides which shape a
 * counter belongs to.
 */
function groupContoursIntoShapes(contours: readonly Contour[]): GlyphShape[] {
  const cleaned = contours.map(simplifyContour).filter((contour) => contour.length >= 3);
  if (cleaned.length === 0) return [];
  const areas = cleaned.map(signedArea);

  // The largest contour is an outline by definition; its direction is "filled".
  let dominant = 0;
  let largest = 0;
  for (const area of areas) {
    if (Math.abs(area) <= largest) continue;
    largest = Math.abs(area);
    dominant = Math.sign(area);
  }

  const shapes: GlyphShape[] = [];
  const shapeIndexByContour = new Map<number, number>();
  for (const [index, contour] of cleaned.entries()) {
    if (Math.sign(areas[index]) !== dominant) continue;
    shapeIndexByContour.set(index, shapes.length);
    shapes.push({ outer: contour, holes: [] });
  }

  for (const [index, contour] of cleaned.entries()) {
    if (Math.sign(areas[index]) === dominant) continue;
    // Smallest enclosing outline wins, so a counter inside a counter's parent
    // attaches to the nearest one.
    let parent = -1;
    let parentArea = Infinity;
    const probe = interiorPoint(contour);
    for (const candidate of shapeIndexByContour.keys()) {
      if (!pointInPolygon(probe, cleaned[candidate])) continue;
      const enclosed = Math.abs(areas[candidate]);
      if (enclosed >= parentArea) continue;
      parentArea = enclosed;
      parent = candidate;
    }
    if (parent === -1) {
      // Wound like a counter but enclosed by nothing: the font is inconsistent,
      // so treat it as a solid piece rather than discarding it.
      shapes.push({ outer: contour, holes: [] });
      continue;
    }
    shapes[shapeIndexByContour.get(parent)!].holes.push(contour);
  }
  return shapes;
}

/**
 * Extrude one shape into a closed prism.
 *
 * The walls follow the *cap's own boundary*, not the contours that were fed
 * in. The triangulator is entitled to drop a collinear or coincident vertex,
 * and a wall built from the original outline would then run along edges the
 * cap no longer has, leaving the solid open. Deriving one from the other makes
 * the mesh watertight by construction.
 */
function extrudeShape(shape: GlyphShape, depth: number, welder: VertexWelder, indices: number[]): void {
  const triangles = triangulatePolygon(shape.outer, shape.holes);
  if (triangles.length === 0) return;
  // The triangulator indexes a flat list of the outer contour then each hole.
  const flat = [...shape.outer, ...shape.holes.flat()];
  const bottom = flat.map(([x, y]) => welder.add(x, y, 0));
  const top = flat.map(([x, y]) => welder.add(x, y, depth));

  // Count directed cap edges in welded index space, so coincident vertices
  // cancel out before the boundary is read off.
  const directed = new Map<string, number>();
  const capped: [number, number, number][] = [];
  for (const [a, b, c] of triangles) {
    const triangle: [number, number, number] = [bottom[a], bottom[b], bottom[c]];
    if (triangle[0] === triangle[1] || triangle[1] === triangle[2] || triangle[0] === triangle[2]) continue;
    capped.push(triangle);
    for (const [from, to] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ]) {
      const key = `${from}_${to}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }

  // The bottom cap faces -Z, so its winding is reversed relative to the top.
  const topOf = new Map<number, number>();
  for (const [index, welded] of bottom.entries()) topOf.set(welded, top[index]);
  for (const [a, b, c] of capped) {
    indices.push(a, c, b);
    pushTriangle(indices, topOf.get(a)!, topOf.get(b)!, topOf.get(c)!);
  }

  // An edge with no opposite is on the boundary; walk it upward.
  for (const [key, count] of directed) {
    const [fromText, toText] = key.split('_');
    const from = Number(fromText);
    const to = Number(toText);
    const opposite = directed.get(`${to}_${from}`) ?? 0;
    for (let repeat = 0; repeat < count - opposite; repeat += 1) {
      // Interior lies to the left of a cap edge, so the wall's outward face is
      // to its right — which is the winding below.
      pushTriangle(indices, from, to, topOf.get(to)!);
      pushTriangle(indices, from, topOf.get(to)!, topOf.get(from)!);
    }
  }
}

/** Separate a hole in the surface from two solids that merely meet on a face. */
function auditEdges(indices: readonly number[]): { openEdgeCount: number; coincidentEdgeCount: number } {
  const uses = new Map<string, number>();
  for (let index = 0; index < indices.length; index += 3) {
    for (const [first, second] of [
      [indices[index], indices[index + 1]],
      [indices[index + 1], indices[index + 2]],
      [indices[index + 2], indices[index]],
    ]) {
      const key = first < second ? `${first}_${second}` : `${second}_${first}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let openEdgeCount = 0;
  let coincidentEdgeCount = 0;
  for (const count of uses.values()) {
    if (count === 1) openEdgeCount += 1;
    else if (count > 2) coincidentEdgeCount += 1;
  }
  return { openEdgeCount, coincidentEdgeCount };
}

/** Drop triangles that collapsed onto a single welded vertex. */
function pushTriangle(indices: number[], a: number, b: number, c: number): void {
  if (a === b || b === c || a === c) return;
  indices.push(a, b, c);
}

/**
 * Merges coincident vertices. Capping and walling both revisit the same
 * corners, and a slicer needs those to be one vertex: an unwelded prism has
 * doubled boundary edges and is not a closed solid.
 */
class VertexWelder {
  readonly positions: number[] = [];
  private readonly byKey = new Map<string, number>();

  add(x: number, y: number, z: number): number {
    // 1e-6 mm is far below any printable feature and far above float noise.
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.byKey.set(key, index);
    return index;
  }
}

/**
 * A point strictly inside the contour, taken from the centroid of one of its
 * own triangles.
 *
 * A raw vertex will not do: a counter's corner often sits exactly on the
 * outline's own coordinate grid — the centre of a # is the standard case — and
 * a crossing test evaluated on the boundary answers arbitrarily, which strands
 * the counter outside its parent and fills it back in.
 */
function interiorPoint(contour: Contour): readonly [number, number] {
  const triangles = triangulatePolygon(contour);
  if (triangles.length === 0) return contour[0];
  const [a, b, c] = triangles[0];
  return [(contour[a][0] + contour[b][0] + contour[c][0]) / 3, (contour[a][1] + contour[b][1] + contour[c][1]) / 3];
}

function pointInPolygon(point: readonly [number, number], polygon: Contour): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if (a[1] > point[1] !== b[1] > point[1]) {
      const x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

export function embossedBounds(mesh: EmbossedMesh): { readonly min: Vec3; readonly max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return Object.freeze({ min: Object.freeze(min) as Vec3, max: Object.freeze(max) as Vec3 });
}
