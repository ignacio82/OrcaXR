//! `triangulatePolygon` (`polygonTriangulation.ts`): the browser's ear clipper
//! after Mapbox's `earcut` (ISC), without the z-order hash. A doubly linked
//! ring of vertices; holes spliced in through a visible bridge; ears clipped,
//! recovering from a stall by curing local self-intersections and then by
//! splitting the ring on a valid diagonal. Nodes live in an arena, so a
//! removed node keeps the links it had, as the browser's objects do.
use crate::js_math;

pub type P2 = [f64; 2];

struct Node {
    index: u32,
    x: f64,
    y: f64,
    prev: usize,
    next: usize,
    /// A one-point hole: never dropped as repeated or collinear.
    steiner: bool,
}

struct Ring {
    nodes: Vec<Node>,
}

impl Ring {
    fn prev(&self, n: usize) -> usize {
        self.nodes[n].prev
    }
    fn next(&self, n: usize) -> usize {
        self.nodes[n].next
    }
    fn xy(&self, n: usize) -> (f64, f64) {
        (self.nodes[n].x, self.nodes[n].y)
    }
    fn index(&self, n: usize) -> u32 {
        self.nodes[n].index
    }

    fn insert_after(&mut self, index: u32, point: P2, previous: Option<usize>) -> usize {
        let node = self.nodes.len();
        self.nodes.push(Node {
            index,
            x: point[0],
            y: point[1],
            prev: node,
            next: node,
            steiner: false,
        });
        if let Some(previous) = previous {
            let after = self.nodes[previous].next;
            self.nodes[node].next = after;
            self.nodes[node].prev = previous;
            self.nodes[after].prev = node;
            self.nodes[previous].next = node;
        }
        node
    }

    fn remove(&mut self, n: usize) {
        let (prev, next) = (self.nodes[n].prev, self.nodes[n].next);
        self.nodes[next].prev = prev;
        self.nodes[prev].next = next;
    }

    fn area(&self, p: usize, q: usize, r: usize) -> f64 {
        let ((px, py), (qx, qy), (rx, ry)) = (self.xy(p), self.xy(q), self.xy(r));
        (qy - py) * (rx - qx) - (qx - px) * (ry - qy)
    }

    fn equals(&self, a: usize, b: usize) -> bool {
        let ((ax, ay), (bx, by)) = (self.xy(a), self.xy(b));
        ax == bx && ay == by
    }

    fn build(&mut self, points: &[P2], offset: u32, counter_clockwise: bool) -> Option<usize> {
        let mut last = None;
        let forward = (signed_area(points) > 0.0) == counter_clockwise;
        if forward {
            for (i, point) in points.iter().enumerate() {
                last = Some(self.insert_after(offset + i as u32, *point, last));
            }
        } else {
            for (i, point) in points.iter().enumerate().rev() {
                last = Some(self.insert_after(offset + i as u32, *point, last));
            }
        }
        if let Some(l) = last
            && self.equals(l, self.next(l))
        {
            self.remove(l);
            last = Some(self.next(l));
        }
        self.drop_collinear(last, None)
    }

    /// `dropCollinear`: a removal moves both the cursor and the stop back one.
    fn drop_collinear(&mut self, start: Option<usize>, end: Option<usize>) -> Option<usize> {
        let start = start?;
        let mut stop = end.unwrap_or(start);
        let mut node = start;
        loop {
            let mut again = false;
            if !self.nodes[node].steiner
                && (self.equals(node, self.next(node))
                    || self.area(self.prev(node), node, self.next(node)) == 0.0)
            {
                self.remove(node);
                node = self.prev(node);
                stop = node;
                if node == self.next(node) {
                    return None;
                }
                again = true;
            } else {
                node = self.next(node);
            }
            if !(again || node != stop) {
                break;
            }
        }
        Some(stop)
    }

    fn clip_ears(&mut self, ear: Option<usize>, triangles: &mut Vec<[u32; 3]>, pass: u8) {
        let Some(mut current) = ear else {
            return;
        };
        let mut stop = current;
        while self.prev(current) != self.next(current) {
            let (previous, next) = (self.prev(current), self.next(current));
            if self.is_ear(current) {
                triangles.push([self.index(previous), self.index(current), self.index(next)]);
                self.remove(current);
                current = self.next(next);
                stop = current;
                continue;
            }
            current = next;
            if current != stop {
                continue;
            }
            // A full lap with no ear: repair the ring rather than lap again.
            match pass {
                0 => {
                    let ring = self.drop_collinear(Some(current), None);
                    self.clip_ears(ring, triangles, 1);
                }
                1 => {
                    let ring = self.drop_collinear(Some(current), None);
                    let cured = self.cure_local_intersections(ring, triangles);
                    self.clip_ears(cured, triangles, 2);
                }
                2 => self.split_and_clip(current, triangles),
                _ => {}
            }
            return;
        }
    }

    fn is_ear(&self, ear: usize) -> bool {
        let (a, b, c) = (self.prev(ear), ear, self.next(ear));
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let ((ax, ay), (bx, by), (cx, cy)) = (self.xy(a), self.xy(b), self.xy(c));
        let mut node = self.next(c);
        while node != a {
            let (px, py) = self.xy(node);
            if point_in_triangle(ax, ay, bx, by, cx, cy, px, py)
                && self.area(self.prev(node), node, self.next(node)) >= 0.0
            {
                return false;
            }
            node = self.next(node);
        }
        true
    }

    fn cure_local_intersections(
        &mut self,
        start: Option<usize>,
        triangles: &mut Vec<[u32; 3]>,
    ) -> Option<usize> {
        let start = start?;
        let mut node = start;
        let mut current = start;
        loop {
            let a = self.prev(current);
            let b = self.next(self.next(current));
            if !self.equals(a, b)
                && self.intersects(a, current, self.next(current), b)
                && self.locally_inside(a, b)
                && self.locally_inside(b, a)
            {
                triangles.push([self.index(a), self.index(current), self.index(b)]);
                let after = self.next(current);
                self.remove(current);
                self.remove(after);
                current = b;
                node = b;
            }
            current = self.next(current);
            if current == node {
                break;
            }
        }
        self.drop_collinear(Some(current), None)
    }

    fn split_and_clip(&mut self, start: usize, triangles: &mut Vec<[u32; 3]>) {
        let mut a = start;
        loop {
            let mut b = self.next(self.next(a));
            while b != self.prev(a) {
                if self.index(a) != self.index(b) && self.is_valid_diagonal(a, b) {
                    let split = self.split_polygon(a, b);
                    let first = self.drop_collinear(Some(a), Some(self.next(a)));
                    self.clip_ears(first, triangles, 0);
                    let second = self.drop_collinear(Some(split), Some(self.next(split)));
                    self.clip_ears(second, triangles, 0);
                    return;
                }
                b = self.next(b);
            }
            a = self.next(a);
            if a == start {
                break;
            }
        }
    }

    fn eliminate_hole(&mut self, hole: usize, outer: usize) -> usize {
        let Some(bridge) = self.find_hole_bridge(hole, outer) else {
            return outer;
        };
        let reverse = self.split_polygon(bridge, hole);
        self.drop_collinear(Some(reverse), Some(self.next(reverse)));
        self.drop_collinear(Some(bridge), Some(self.next(bridge)))
            .unwrap_or(bridge)
    }

    fn find_hole_bridge(&self, hole: usize, outer: usize) -> Option<usize> {
        let mut node = outer;
        let mut best_x = f64::NEG_INFINITY;
        let mut bridge: Option<usize> = None;
        let (hx, hy) = self.xy(hole);
        if (hx, hy) == self.xy(node) {
            return Some(node);
        }
        loop {
            let next = self.next(node);
            let ((nx, ny), (mx, my)) = (self.xy(node), self.xy(next));
            if hx == mx && hy == my {
                return Some(next);
            }
            if hy <= ny && hy >= my && my != ny {
                let x = nx + ((hy - ny) * (mx - nx)) / (my - ny);
                if x <= hx && x > best_x {
                    best_x = x;
                    let candidate = if nx < mx { node } else { next };
                    bridge = Some(candidate);
                    if x == hx {
                        return Some(candidate);
                    }
                }
            }
            node = next;
            if node == outer {
                break;
            }
        }
        let mut bridge = bridge?;
        let stop = bridge;
        let (bridge_x, bridge_y) = self.xy(bridge);
        let mut best_angle = f64::INFINITY;
        node = bridge;
        loop {
            let (x, y) = self.xy(node);
            let inside = hx >= x
                && x >= bridge_x
                && hx != x
                && point_in_triangle(
                    if hy < bridge_y { hx } else { best_x },
                    hy,
                    bridge_x,
                    bridge_y,
                    if hy < bridge_y { best_x } else { hx },
                    hy,
                    x,
                    y,
                );
            if inside {
                let angle = (hy - y).abs() / (hx - x);
                let (current_x, _) = self.xy(bridge);
                if self.locally_inside(node, hole)
                    && (angle < best_angle
                        || (angle == best_angle
                            && (x > current_x
                                || (x == current_x && self.sector_contains_sector(bridge, node)))))
                {
                    bridge = node;
                    best_angle = angle;
                }
            }
            node = self.next(node);
            if node == stop {
                break;
            }
        }
        Some(bridge)
    }

    fn sector_contains_sector(&self, m: usize, p: usize) -> bool {
        self.area(self.prev(m), m, self.prev(p)) < 0.0
            && self.area(self.next(p), m, self.next(m)) < 0.0
    }

    fn is_valid_diagonal(&self, a: usize, b: usize) -> bool {
        self.index(self.next(a)) != self.index(b)
            && self.index(self.prev(a)) != self.index(b)
            && !self.intersects_polygon(a, b)
            && ((self.locally_inside(a, b)
                && self.locally_inside(b, a)
                && self.middle_inside(a, b)
                && (self.area(self.prev(a), a, self.prev(b)) != 0.0
                    || self.area(a, self.prev(b), b) != 0.0))
                || (self.equals(a, b)
                    && self.area(self.prev(a), a, self.next(a)) > 0.0
                    && self.area(self.prev(b), b, self.next(b)) > 0.0))
    }

    /// Link `a` and `b`, splitting one ring into two; returns the new ring.
    fn split_polygon(&mut self, a: usize, b: usize) -> usize {
        let a2 = self.nodes.len();
        let (ai, ax, ay) = (self.nodes[a].index, self.nodes[a].x, self.nodes[a].y);
        self.nodes.push(Node {
            index: ai,
            x: ax,
            y: ay,
            prev: a2,
            next: a2,
            steiner: false,
        });
        let b2 = self.nodes.len();
        let (bi, bx, by) = (self.nodes[b].index, self.nodes[b].x, self.nodes[b].y);
        self.nodes.push(Node {
            index: bi,
            x: bx,
            y: by,
            prev: b2,
            next: b2,
            steiner: false,
        });
        let an = self.next(a);
        let bp = self.prev(b);
        self.nodes[a].next = b;
        self.nodes[b].prev = a;
        self.nodes[a2].next = an;
        self.nodes[an].prev = a2;
        self.nodes[b2].next = a2;
        self.nodes[a2].prev = b2;
        self.nodes[bp].next = b2;
        self.nodes[b2].prev = bp;
        b2
    }

    fn leftmost(&self, start: usize) -> usize {
        let mut node = start;
        let mut best = start;
        loop {
            let ((x, y), (bx, by)) = (self.xy(node), self.xy(best));
            if x < bx || (x == bx && y < by) {
                best = node;
            }
            node = self.next(node);
            if node == start {
                break;
            }
        }
        best
    }

    fn intersects_polygon(&self, a: usize, b: usize) -> bool {
        let mut node = a;
        loop {
            let next = self.next(node);
            if self.index(node) != self.index(a)
                && self.index(next) != self.index(a)
                && self.index(node) != self.index(b)
                && self.index(next) != self.index(b)
                && self.intersects(node, next, a, b)
            {
                return true;
            }
            node = next;
            if node == a {
                break;
            }
        }
        false
    }

    fn intersects(&self, p1: usize, q1: usize, p2: usize, q2: usize) -> bool {
        let o1 = sign(self.area(p1, q1, p2));
        let o2 = sign(self.area(p1, q1, q2));
        let o3 = sign(self.area(p2, q2, p1));
        let o4 = sign(self.area(p2, q2, q1));
        (o1 != o2 && o3 != o4)
            || (o1 == 0 && self.on_segment(p1, p2, q1))
            || (o2 == 0 && self.on_segment(p1, q2, q1))
            || (o3 == 0 && self.on_segment(p2, p1, q2))
            || (o4 == 0 && self.on_segment(p2, q1, q2))
    }

    fn on_segment(&self, p: usize, q: usize, r: usize) -> bool {
        let ((px, py), (qx, qy), (rx, ry)) = (self.xy(p), self.xy(q), self.xy(r));
        qx <= js_math::max(px, rx)
            && qx >= js_math::min(px, rx)
            && qy <= js_math::max(py, ry)
            && qy >= js_math::min(py, ry)
    }

    fn locally_inside(&self, a: usize, b: usize) -> bool {
        if self.area(self.prev(a), a, self.next(a)) < 0.0 {
            self.area(a, b, self.next(a)) >= 0.0 && self.area(a, self.prev(a), b) >= 0.0
        } else {
            self.area(a, b, self.prev(a)) < 0.0 || self.area(a, self.next(a), b) < 0.0
        }
    }

    fn middle_inside(&self, a: usize, b: usize) -> bool {
        let mut node = a;
        let mut inside = false;
        let ((ax, ay), (bx, by)) = (self.xy(a), self.xy(b));
        let (px, py) = ((ax + bx) / 2.0, (ay + by) / 2.0);
        loop {
            let next = self.next(node);
            let ((nx, ny), (mx, my)) = (self.xy(node), self.xy(next));
            if (ny > py) != (my > py) && my != ny && px < ((mx - nx) * (py - ny)) / (my - ny) + nx {
                inside = !inside;
            }
            node = next;
            if node == a {
                break;
            }
        }
        inside
    }
}

fn sign(value: f64) -> i8 {
    if value > 0.0 {
        1
    } else if value < 0.0 {
        -1
    } else {
        0
    }
}

#[allow(clippy::too_many_arguments)]
fn point_in_triangle(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    cx: f64,
    cy: f64,
    px: f64,
    py: f64,
) -> bool {
    (cx - px) * (ay - py) >= (ax - px) * (cy - py)
        && (ax - px) * (by - py) >= (bx - px) * (ay - py)
        && (bx - px) * (cy - py) >= (cx - px) * (by - py)
}

/// Triangles of `outer` with `holes` removed, indexing `outer` then each hole.
pub fn triangulate(outer: &[P2], holes: &[Vec<P2>]) -> Vec<[u32; 3]> {
    let mut triangles = Vec::new();
    if outer.len() < 3 {
        return triangles;
    }
    let mut ring = Ring { nodes: Vec::new() };
    let mut vertex = outer.len() as u32;
    let Some(mut outer_ring) = ring.build(outer, 0, true) else {
        return triangles;
    };
    if ring.next(outer_ring) == ring.prev(outer_ring) {
        return triangles;
    }
    if !holes.is_empty() {
        let mut queue = Vec::new();
        for hole in holes {
            let list = ring.build(hole, vertex, false);
            vertex += hole.len() as u32;
            let Some(list) = list else {
                continue;
            };
            if list == ring.next(list) {
                ring.nodes[list].steiner = true;
            }
            queue.push(ring.leftmost(list));
        }
        // `left.x - right.x || left.y - right.y`, as a stable sort.
        queue.sort_by(|&l, &r| {
            let ((lx, ly), (rx, ry)) = (ring.xy(l), ring.xy(r));
            let step = |d: f64| {
                if d > 0.0 {
                    Some(std::cmp::Ordering::Greater)
                } else if d < 0.0 {
                    Some(std::cmp::Ordering::Less)
                } else {
                    None
                }
            };
            step(lx - rx)
                .or_else(|| step(ly - ry))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for hole in queue {
            outer_ring = ring.eliminate_hole(hole, outer_ring);
        }
    }
    ring.clip_ears(Some(outer_ring), &mut triangles, 0);
    triangles
}

/// `simplifyContour`: repeated and collinear points removed until none are.
pub fn simplify_contour(points: &[P2]) -> Vec<P2> {
    let mut out = points.to_vec();
    let mut changed = true;
    while changed && out.len() >= 3 {
        changed = false;
        let mut index = 0;
        while index < out.len() && out.len() >= 3 {
            let n = out.len();
            let previous = out[(index + n - 1) % n];
            let current = out[index];
            let next = out[(index + 1) % n];
            let repeated = current[0] == next[0] && current[1] == next[1];
            let collinear = (current[1] - previous[1]) * (next[0] - current[0])
                - (current[0] - previous[0]) * (next[1] - current[1])
                == 0.0;
            if repeated || collinear {
                out.remove(index);
                changed = true;
            } else {
                index += 1;
            }
        }
    }
    out
}

/// `signedArea`: positive counter-clockwise.
pub fn signed_area(points: &[P2]) -> f64 {
    let mut total = 0.0;
    for index in 0..points.len() {
        let (current, next) = (points[index], points[(index + 1) % points.len()]);
        total += current[0] * next[1] - next[0] * current[1];
    }
    total / 2.0
}
