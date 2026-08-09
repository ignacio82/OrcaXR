/**
 * Extruding closed 2D contours into a printable solid (P5.3.3, P5.3.4).
 *
 * Shared by text embossing and SVG parts: both arrive as a set of closed
 * contours in millimetres and need the same thing done to them — work out
 * which contours are holes, subtract those, and raise the result into a
 * watertight prism. Keeping one implementation means the SVG path inherits
 * every correctness property the font sweep proved, rather than growing a
 * second, less-tested extruder beside it.
 */

import type { Vec3 } from '../domain/model';
import { type Contour, signedArea, simplifyContour, triangulatePolygon } from './polygonTriangulation';

export interface ExtrudedMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly triangleCount: number;
  /**
   * Edges belonging to exactly one triangle: an actual hole in the surface.
   *
   * A contour that touches itself in a way no ear clipper can resolve comes
   * out open, and a slicer will either repair it silently or print something
   * wrong. Reporting the count lets the caller say so instead.
   */
  readonly openEdgeCount: number;
  /**
   * Edges shared by more than two triangles.
   *
   * Distinct from an open edge and much less serious: two shapes whose
   * outlines touch exactly meet along a coincident face. The solid is still
   * closed, so this is reported apart from `openEdgeCount`.
   */
  readonly coincidentEdgeCount: number;
}

/**
 * Extrude closed contours from 0 to `depthMm` along +Z.
 *
 * Contours are classified by winding direction, which is the rule both fonts
 * and SVG's non-zero fill use: a contour wound against the dominant direction
 * is a hole in the shape enclosing it, and one wound with it is another solid
 * piece. Nesting alone misreads shapes whose parts merely touch.
 */
export function extrudeContours(contours: readonly Contour[], depthMm: number): ExtrudedMesh {
  const welder = new VertexWelder();
  const indices: number[] = [];
  for (const shape of groupContoursIntoShapes(contours)) {
    extrudeShape(shape, depthMm, welder, indices);
  }
  return Object.freeze({
    positions: Object.freeze(welder.positions),
    indices: Object.freeze(indices),
    triangleCount: indices.length / 3,
    ...auditEdges(indices),
  });
}

/** Axis-aligned bounds of an extruded mesh, in millimetres. */
export function extrudedBounds(mesh: { positions: readonly number[] }): { readonly min: Vec3; readonly max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min: Object.freeze(min) as Vec3, max: Object.freeze(max) as Vec3 };
}

export { groupContoursIntoShapes as __groupContoursIntoShapes };

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
