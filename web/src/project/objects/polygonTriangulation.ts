/**
 * Polygon-with-holes triangulation for the canonical layer.
 *
 * A TypeScript implementation of the ear-clipping algorithm Mapbox's `earcut`
 * describes (ISC): build a doubly linked vertex ring, splice each hole in
 * through a visible bridge, clip ears, and recover from a stall in two passes —
 * first by curing local self-intersections, then by splitting the ring on a
 * valid diagonal. Written here rather than taken as a dependency because
 * `src/project/` may not import Three, whose bundled copy would otherwise do.
 *
 * The recovery passes are the whole point. A naive ear clipper stalls on the
 * seam a hole bridge leaves behind, and a letter with two counters — B, 8, % —
 * comes out with holes in its cap and an open, unprintable mesh.
 *
 * The z-order hash earcut uses to stay fast on very large rings is omitted:
 * glyph and SVG contours are hundreds of points, not millions, and plain ear
 * lookup is exact.
 */

/** A closed contour; the edge from the last point back to the first is implicit. */
export type Contour = readonly (readonly [number, number])[];

class Node {
  prev: Node = this;
  next: Node = this;
  /** Removed vertices stay reachable through `prev`/`next` until relinked. */
  steiner = false;

  constructor(
    readonly index: number,
    readonly x: number,
    readonly y: number,
  ) {}
}

/**
 * Triangulate `outer` with `holes` removed. Indices address a flat vertex list
 * that is `outer` followed by each hole in order — the same order the caller
 * passed them in.
 */
export function triangulatePolygon(outer: Contour, holes: readonly Contour[] = []): [number, number, number][] {
  const triangles: [number, number, number][] = [];
  if (outer.length < 3) return triangles;

  let vertexIndex = 0;
  let ring = buildRing(outer, vertexIndex, true);
  vertexIndex += outer.length;
  if (!ring || ring.next === ring.prev) return triangles;

  if (holes.length > 0) {
    const queue: Node[] = [];
    for (const hole of holes) {
      const list = buildRing(hole, vertexIndex, false);
      vertexIndex += hole.length;
      if (!list) continue;
      if (list === list.next) list.steiner = true;
      queue.push(leftmost(list));
    }
    queue.sort((left, right) => left.x - right.x || left.y - right.y);
    for (const hole of queue) ring = eliminateHole(hole, ring);
  }

  clipEars(ring, triangles, 0);
  return triangles;
}

function buildRing(points: Contour, offset: number, counterClockwise: boolean): Node | undefined {
  let last: Node | undefined;
  const forward = signedArea(points) > 0 === counterClockwise;
  if (forward) {
    for (let index = 0; index < points.length; index += 1) last = insertAfter(offset + index, points[index], last);
  } else {
    for (let index = points.length - 1; index >= 0; index -= 1) last = insertAfter(offset + index, points[index], last);
  }
  if (last && equals(last, last.next)) {
    remove(last);
    last = last.next;
  }
  return dropCollinear(last);
}

function insertAfter(index: number, point: readonly [number, number], previous: Node | undefined): Node {
  const node = new Node(index, point[0], point[1]);
  if (!previous) return node;
  node.next = previous.next;
  node.prev = previous;
  previous.next.prev = node;
  previous.next = node;
  return node;
}

function remove(node: Node): void {
  node.next.prev = node.prev;
  node.prev.next = node.next;
}

/**
 * Drop repeated and collinear vertices, which no ear clipper can consume.
 *
 * The walk starts at `start` and terminates on `end`, and a removal moves
 * *both* the cursor and `end` back one node. Anchoring on the wrong one makes
 * the termination test unreachable and the whole triangulation hangs.
 */
function dropCollinear(start: Node | undefined, end?: Node): Node | undefined {
  if (!start) return start;
  let stop = end ?? start;
  let node: Node = start;
  let again: boolean;
  do {
    again = false;
    if (!node.steiner && (equals(node, node.next) || area(node.prev, node, node.next) === 0)) {
      remove(node);
      node = stop = node.prev;
      if (node === node.next) return undefined;
      again = true;
    } else {
      node = node.next;
    }
  } while (again || node !== stop);
  return stop;
}

/**
 * Clip ears off the ring. `pass` escalates through the two recovery strategies
 * rather than giving up on a ring that momentarily has no ear.
 */
function clipEars(ear: Node | undefined, triangles: [number, number, number][], pass: number): void {
  if (!ear) return;
  let current = ear;
  let stop = current;

  while (current.prev !== current.next) {
    const previous = current.prev;
    const next = current.next;
    if (isEar(current)) {
      triangles.push([previous.index, current.index, next.index]);
      remove(current);
      current = next.next;
      stop = next.next;
      continue;
    }
    current = next;
    if (current !== stop) continue;

    // A full lap with no ear taken: the ring needs repair, not more laps.
    if (pass === 0) {
      clipEars(dropCollinear(current), triangles, 1);
      return;
    }
    if (pass === 1) {
      clipEars(cureLocalIntersections(dropCollinear(current), triangles), triangles, 2);
      return;
    }
    if (pass === 2) splitAndClip(current, triangles);
    return;
  }
}

function isEar(ear: Node): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  if (area(a, b, c) >= 0) return false; // A reflex corner is never an ear.

  // No other vertex of the ring may fall inside the candidate triangle.
  let node = c.next;
  while (node !== a) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, node.x, node.y) && area(node.prev, node, node.next) >= 0) {
      return false;
    }
    node = node.next;
  }
  return true;
}

/** Cut away pairs of vertices whose edges cross, which unblocks the clipper. */
function cureLocalIntersections(start: Node | undefined, triangles: [number, number, number][]): Node | undefined {
  if (!start) return undefined;
  let node = start;
  let current = start;
  do {
    const a = current.prev;
    const b = current.next.next;
    if (!equals(a, b) && intersects(a, current, current.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push([a.index, current.index, b.index]);
      remove(current);
      remove(current.next);
      current = node = b;
    }
    current = current.next;
  } while (current !== node);
  return dropCollinear(current);
}

/** Split the ring on a valid diagonal and clip both halves independently. */
function splitAndClip(start: Node, triangles: [number, number, number][]): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.index !== b.index && isValidDiagonal(a, b)) {
        const split = splitPolygon(a, b);
        // Repeat the whole search on each half; either may still be pinched.
        clipEars(dropCollinear(a, a.next), triangles, 0);
        clipEars(dropCollinear(split, split.next), triangles, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function eliminateHole(hole: Node, outer: Node): Node {
  const bridge = findHoleBridge(hole, outer);
  if (!bridge) return outer;
  const reverse = splitPolygon(bridge, hole);
  dropCollinear(reverse, reverse.next);
  // Filter from the bridge, not the original head: the head may have just been
  // removed, and continuing from a detached node walks a ring that no longer
  // exists.
  return dropCollinear(bridge, bridge.next) ?? bridge;
}

/**
 * Find an outer vertex the hole's leftmost point can see, by casting a ray to
 * the left and then walking the candidates the ray's edge exposes.
 */
function findHoleBridge(hole: Node, outer: Node): Node | undefined {
  let node = outer;
  let bestX = -Infinity;
  let bridge: Node | undefined;
  const hx = hole.x;
  const hy = hole.y;
  // A hole that already touches the outer contour needs no bridge at all.
  if (hx === node.x && hy === node.y) return node;

  do {
    if (hx === node.next.x && hy === node.next.y) return node.next;
    // Only edges the horizontal ray actually crosses can host the bridge.
    if (hy <= node.y && hy >= node.next.y && node.next.y !== node.y) {
      const x = node.x + ((hy - node.y) * (node.next.x - node.x)) / (node.next.y - node.y);
      if (x <= hx && x > bestX) {
        bestX = x;
        bridge = node.x < node.next.x ? node : node.next;
        if (x === hx) return bridge; // The hole touches the outer contour.
      }
    }
    node = node.next;
  } while (node !== outer);

  if (!bridge) return undefined;

  // Walk the vertices inside the ray's triangle and keep the most visible one.
  const stop = bridge;
  const bridgeX = bridge.x;
  const bridgeY = bridge.y;
  let bestAngle = Infinity;
  node = bridge;
  do {
    const inside =
      hx >= node.x &&
      node.x >= bridgeX &&
      hx !== node.x &&
      pointInTriangle(hy < bridgeY ? hx : bestX, hy, bridgeX, bridgeY, hy < bridgeY ? bestX : hx, hy, node.x, node.y);
    if (inside) {
      const angle = Math.abs(hy - node.y) / (hx - node.x);
      if (
        locallyInside(node, hole) &&
        (angle < bestAngle ||
          (angle === bestAngle && (node.x > bridge.x || (node.x === bridge.x && sectorContainsSector(bridge, node)))))
      ) {
        bridge = node;
        bestAngle = angle;
      }
    }
    node = node.next;
  } while (node !== stop);

  return bridge;
}

/** Whether one vertex's interior sector fully contains another's. */
function sectorContainsSector(m: Node, p: Node): boolean {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.index !== b.index &&
    a.prev.index !== b.index &&
    !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) &&
      locallyInside(b, a) &&
      middleInside(a, b) &&
      // The diagonal must have some width, or it is the seam itself.
      (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
      // Two coincident vertices may be split only where both corners are
      // convex. Without this guard the split lands on a hole bridge and the
      // counter it opened is filled straight back in.
      (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
  );
}

/** Link `a` and `b`, splitting one ring into two; returns the new ring. */
function splitPolygon(a: Node, b: Node): Node {
  const a2 = new Node(a.index, a.x, a.y);
  const b2 = new Node(b.index, b.x, b.y);
  const an = a.next;
  const bp = b.prev;

  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
  return b2;
}

function leftmost(start: Node): Node {
  let node = start;
  let best = start;
  do {
    if (node.x < best.x || (node.x === best.x && node.y < best.y)) best = node;
    node = node.next;
  } while (node !== start);
  return best;
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let node = a;
  do {
    if (
      node.index !== a.index &&
      node.next.index !== a.index &&
      node.index !== b.index &&
      node.next.index !== b.index &&
      intersects(node, node.next, a, b)
    ) {
      return true;
    }
    node = node.next;
  } while (node !== a);
  return false;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2));
  const o2 = sign(area(p1, q1, q2));
  const o3 = sign(area(p2, q2, p1));
  const o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function onSegment(p: Node, q: Node, r: Node): boolean {
  return (
    q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
  );
}

function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Does the segment a→b leave `a` on the inside of the ring? */
function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

/** Is the midpoint of a→b inside the ring? */
function middleInside(a: Node, b: Node): boolean {
  let node = a;
  let inside = false;
  const px = (a.x + b.x) / 2;
  const py = (a.y + b.y) / 2;
  do {
    if (
      node.y > py !== node.next.y > py &&
      node.next.y !== node.y &&
      px < ((node.next.x - node.x) * (py - node.y)) / (node.next.y - node.y) + node.x
    ) {
      inside = !inside;
    }
    node = node.next;
  } while (node !== a);
  return inside;
}

function pointInTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

function area(p: Node, q: Node, r: Node): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(a: Node, b: Node): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Remove repeated and collinear points, exactly as the triangulator does
 * internally.
 *
 * Callers that build walls along a contour *must* apply this first. The
 * triangulator drops such points from the cap, and a cap boundary that no
 * longer matches the wall edges leaves the solid open along every stretch of
 * collinear outline — which is what a flattened curve is full of.
 */
export function simplifyContour(points: Contour): (readonly [number, number])[] {
  const out = [...points];
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let index = 0; index < out.length && out.length >= 3;) {
      const previous = out[(index - 1 + out.length) % out.length];
      const current = out[index];
      const next = out[(index + 1) % out.length];
      const repeated = current[0] === next[0] && current[1] === next[1];
      const collinear =
        (current[1] - previous[1]) * (next[0] - current[0]) - (current[0] - previous[0]) * (next[1] - current[1]) === 0;
      if (repeated || collinear) {
        out.splice(index, 1);
        changed = true;
      } else {
        index += 1;
      }
    }
  }
  return out;
}

export function signedArea(points: Contour): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current[0] * next[1] - next[0] * current[1];
  }
  return total / 2;
}
