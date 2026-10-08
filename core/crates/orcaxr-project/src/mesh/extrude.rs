//! `extrudeContours` (`extrude.ts`): closed 2-D contours in millimetres
//! raised into a watertight prism from 0 to a depth along +Z, shared by text
//! embossing and SVG parts.
//!
//! Contours are classified by winding direction (the non-zero rule fonts and
//! SVG both use): one wound against the largest contour is a hole in the
//! smallest enclosing outline. Walls follow the triangulated cap's own
//! boundary, so a vertex the triangulator drops cannot leave the solid open.
use super::triangulate::{P2, signed_area, simplify_contour, triangulate};
use crate::js_math;
use std::collections::HashMap;

pub struct Extruded {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    /// Edges of exactly one triangle: a hole in the surface.
    pub open_edges: u64,
    /// Edges of more than two triangles: solids meeting on a face.
    pub coincident_edges: u64,
}

struct Shape {
    outer: Vec<P2>,
    holes: Vec<Vec<P2>>,
}

/// `VertexWelder`: coincident vertices (to 1e-6 mm) merge into one.
#[derive(Default)]
struct Welder {
    positions: Vec<f64>,
    by_key: HashMap<[u64; 3], u32>,
}
impl Welder {
    fn add(&mut self, x: f64, y: f64, z: f64) -> u32 {
        // The browser keys on the decimal spelling of each rounded value, so
        // -0 and 0 (and every NaN) are one key.
        let part = |value: f64| {
            let rounded = js_math::round(value * 1e6);
            if rounded == 0.0 {
                0
            } else if rounded.is_nan() {
                f64::NAN.to_bits()
            } else {
                rounded.to_bits()
            }
        };
        let key = [part(x), part(y), part(z)];
        if let Some(&existing) = self.by_key.get(&key) {
            return existing;
        }
        let index = (self.positions.len() / 3) as u32;
        self.positions.extend([x, y, z]);
        self.by_key.insert(key, index);
        index
    }
}

/// Extrude closed contours from 0 to `depth_mm` along +Z.
pub fn extrude(contours: &[Vec<P2>], depth_mm: f64) -> Extruded {
    let mut welder = Welder::default();
    let mut indices = Vec::new();
    for shape in group(contours) {
        extrude_shape(&shape, depth_mm, &mut welder, &mut indices);
    }
    let (open_edges, coincident_edges) = audit(&indices);
    Extruded {
        positions: welder.positions,
        indices,
        open_edges,
        coincident_edges,
    }
}

/// `groupContoursIntoShapes`: direction decides what is filled; nesting only
/// which outline a counter belongs to.
fn group(contours: &[Vec<P2>]) -> Vec<Shape> {
    let cleaned: Vec<Vec<P2>> = contours
        .iter()
        .map(|contour| simplify_contour(contour))
        .filter(|contour| contour.len() >= 3)
        .collect();
    if cleaned.is_empty() {
        return Vec::new();
    }
    let areas: Vec<f64> = cleaned.iter().map(|contour| signed_area(contour)).collect();
    // The largest contour is an outline by definition.
    let mut dominant = 0.0f64;
    let mut largest = 0.0f64;
    for &area in &areas {
        if area.abs() <= largest {
            continue;
        }
        largest = area.abs();
        dominant = js_math::sign(area);
    }
    let mut shapes: Vec<Shape> = Vec::new();
    // Outline contours by index, in insertion order, with their shapes.
    let mut outlines: Vec<(usize, usize)> = Vec::new();
    for (index, contour) in cleaned.iter().enumerate() {
        if js_math::sign(areas[index]) != dominant {
            continue;
        }
        outlines.push((index, shapes.len()));
        shapes.push(Shape {
            outer: contour.clone(),
            holes: Vec::new(),
        });
    }
    for (index, contour) in cleaned.iter().enumerate() {
        if js_math::sign(areas[index]) == dominant {
            continue;
        }
        // The smallest enclosing outline wins.
        let mut parent: Option<usize> = None;
        let mut parent_area = f64::INFINITY;
        let probe = interior_point(contour);
        for &(candidate, shape) in &outlines {
            if !point_in_polygon(probe, &cleaned[candidate]) {
                continue;
            }
            let enclosed = areas[candidate].abs();
            if enclosed >= parent_area {
                continue;
            }
            parent_area = enclosed;
            parent = Some(shape);
        }
        match parent {
            // Wound like a counter but enclosed by nothing: a solid piece.
            None => shapes.push(Shape {
                outer: contour.clone(),
                holes: Vec::new(),
            }),
            Some(shape) => shapes[shape].holes.push(contour.clone()),
        }
    }
    shapes
}

fn extrude_shape(shape: &Shape, depth: f64, welder: &mut Welder, indices: &mut Vec<u32>) {
    let triangles = triangulate(&shape.outer, &shape.holes);
    if triangles.is_empty() {
        return;
    }
    let flat: Vec<P2> = shape
        .outer
        .iter()
        .chain(shape.holes.iter().flatten())
        .copied()
        .collect();
    let bottom: Vec<u32> = flat.iter().map(|p| welder.add(p[0], p[1], 0.0)).collect();
    let top: Vec<u32> = flat.iter().map(|p| welder.add(p[0], p[1], depth)).collect();

    // Directed cap edges in welded index space, in first-seen order.
    let mut order: Vec<(u32, u32)> = Vec::new();
    let mut directed: HashMap<(u32, u32), i64> = HashMap::new();
    let mut capped: Vec<[u32; 3]> = Vec::new();
    for [a, b, c] in triangles {
        let triangle = [bottom[a as usize], bottom[b as usize], bottom[c as usize]];
        if triangle[0] == triangle[1] || triangle[1] == triangle[2] || triangle[0] == triangle[2] {
            continue;
        }
        capped.push(triangle);
        for edge in [
            (triangle[0], triangle[1]),
            (triangle[1], triangle[2]),
            (triangle[2], triangle[0]),
        ] {
            let count = directed.entry(edge).or_insert_with(|| {
                order.push(edge);
                0
            });
            *count += 1;
        }
    }
    let top_of: HashMap<u32, u32> = bottom.iter().copied().zip(top.iter().copied()).collect();
    for &[a, b, c] in &capped {
        // The bottom cap faces -Z.
        indices.extend([a, c, b]);
        push_triangle(indices, top_of[&a], top_of[&b], top_of[&c]);
    }
    // An edge with no opposite is on the boundary; walk it upward.
    for (from, to) in order {
        let count = directed[&(from, to)];
        let opposite = directed.get(&(to, from)).copied().unwrap_or(0);
        for _ in 0..(count - opposite).max(0) {
            push_triangle(indices, from, to, top_of[&to]);
            push_triangle(indices, from, top_of[&to], top_of[&from]);
        }
    }
}

fn push_triangle(indices: &mut Vec<u32>, a: u32, b: u32, c: u32) {
    if a == b || b == c || a == c {
        return;
    }
    indices.extend([a, b, c]);
}

/// `auditEdges`: open and coincident undirected edges.
fn audit(indices: &[u32]) -> (u64, u64) {
    let mut uses: HashMap<(u32, u32), u32> = HashMap::new();
    for t in indices.chunks_exact(3) {
        for (first, second) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *uses
                .entry(if first < second {
                    (first, second)
                } else {
                    (second, first)
                })
                .or_default() += 1;
        }
    }
    let open = uses.values().filter(|&&count| count == 1).count() as u64;
    let coincident = uses.values().filter(|&&count| count > 2).count() as u64;
    (open, coincident)
}

/// `interiorPoint`: the centroid of the contour's first own triangle.
fn interior_point(contour: &[P2]) -> P2 {
    let triangles = triangulate(contour, &[]);
    let Some(&[a, b, c]) = triangles.first() else {
        return contour[0];
    };
    let (a, b, c) = (
        contour[a as usize],
        contour[b as usize],
        contour[c as usize],
    );
    [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0]
}

fn point_in_polygon(point: P2, polygon: &[P2]) -> bool {
    let mut inside = false;
    let mut previous = polygon.len() - 1;
    for index in 0..polygon.len() {
        let (a, b) = (polygon[index], polygon[previous]);
        if (a[1] > point[1]) != (b[1] > point[1]) {
            let x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
            if point[0] < x {
                inside = !inside;
            }
        }
        previous = index;
    }
    inside
}
