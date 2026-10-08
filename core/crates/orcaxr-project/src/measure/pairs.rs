//! `measureSurfaceFeatures` (`measure.ts`), after the pinned `get_measurement`:
//! operands swapped so the lower feature type comes first, every distance and
//! angle in the browser's evaluation order, the ends swapped back after.
use super::{Feature, V};
use crate::js_math;

/// Pinned `libslic3r.h` EPSILON.
pub const EPSILON: f64 = 1e-4;

pub(super) fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub(super) fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub(super) fn scale(a: V, factor: f64) -> V {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}
pub(super) fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub(super) fn cross(a: V, b: V) -> V {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub(super) fn norm(a: V) -> f64 {
    js_math::hypot(&a)
}
pub(super) fn squared_norm(a: V) -> f64 {
    dot(a, a)
}
pub(super) fn normalized(a: V) -> V {
    let length = norm(a);
    if !length.is_finite() || length == 0.0 {
        return [0.0; 3];
    }
    [a[0] / length, a[1] / length, a[2] / length]
}
pub(super) fn is_approx(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() < tolerance
}
fn is_approx_vec(a: V, b: V) -> bool {
    (0..3).all(|k| is_approx(a[k], b[k], EPSILON))
}
fn are_parallel(a: V, b: V) -> bool {
    (dot(a, b).abs() - 1.0).abs() < EPSILON
}
fn are_perpendicular(a: V, b: V) -> bool {
    dot(a, b).abs() < EPSILON
}
fn plane_signed_distance(normal: V, origin: V, point: V) -> f64 {
    dot(normalized(normal), sub(point, origin))
}
fn plane_projection(normal: V, origin: V, point: V) -> V {
    let unit = normalized(normal);
    sub(point, scale(unit, dot(unit, sub(point, origin))))
}
fn line_projection(from: V, direction: V, point: V) -> V {
    let unit = normalized(direction);
    add(from, scale(unit, dot(unit, sub(point, from))))
}
/// `get_orthogonal(n, true)`.
pub(super) fn orthogonal_unit(v: V) -> V {
    let axis = if v[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    normalized(cross(v, axis))
}
/// `Math.min(1, Math.max(-1, x))` clamped, then `Math.acos`.
fn clamped_acos(x: f64) -> f64 {
    js_math::acos(js_math::min(1.0, js_math::max(-1.0, x)))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Distance {
    pub distance: f64,
    pub from: V,
    pub to: V,
}
impl Distance {
    fn swapped(self) -> Self {
        Self {
            distance: self.distance,
            from: self.to,
            to: self.from,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Angle {
    /// Radians.
    pub angle: f64,
    pub center: V,
    pub radius: f64,
    pub coplanar: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Measurement {
    pub angle: Option<Angle>,
    /// Distance to the infinite line or plane the feature lies on.
    pub infinite: Option<Distance>,
    /// Distance to the bounded feature itself.
    pub strict: Option<Distance>,
    pub xyz: Option<V>,
    /// Two circles in non-parallel planes: the pinned degree-8 solver the
    /// browser does not carry.
    pub unsupported: bool,
}

fn order(feature: &Feature) -> u8 {
    match feature {
        Feature::Point(_) => 1,
        Feature::Edge { .. } => 2,
        Feature::Circle { .. } => 4,
        Feature::Plane { .. } => 8,
    }
}

/// `measureSurfaceFeatures`.
pub fn measure(a: &Feature, b: &Feature) -> Measurement {
    let swap = order(a) > order(b);
    let (first, second) = if swap { (b, a) } else { (a, b) };
    let mut result = ordered(first, second);
    if swap {
        result.infinite = result.infinite.map(Distance::swapped);
        result.strict = result.strict.map(Distance::swapped);
    }
    result
}

fn infinite(distance: Distance) -> Measurement {
    Measurement {
        infinite: Some(distance),
        ..Measurement::default()
    }
}
fn strict(distance: Distance) -> Measurement {
    Measurement {
        strict: Some(distance),
        ..Measurement::default()
    }
}
fn angled(angle: Option<Angle>) -> Measurement {
    Measurement {
        angle,
        ..Measurement::default()
    }
}
fn to_plane(point: V, normal: V, origin: V) -> Distance {
    Distance {
        distance: plane_signed_distance(normal, origin, point).abs(),
        from: point,
        to: plane_projection(normal, origin, point),
    }
}
/// `reduce`: the first strictly smallest distance.
fn nearest(candidates: &[Distance]) -> Distance {
    candidates[1..].iter().fold(candidates[0], |best, item| {
        if item.distance < best.distance {
            *item
        } else {
            best
        }
    })
}

fn ordered(f1: &Feature, f2: &Feature) -> Measurement {
    match (*f1, *f2) {
        (Feature::Point(p1), Feature::Point(p2)) => {
            let diff = sub(p2, p1);
            Measurement {
                strict: Some(Distance {
                    distance: norm(diff),
                    from: p1,
                    to: p2,
                }),
                xyz: Some(diff),
                ..Measurement::default()
            }
        }
        (Feature::Point(point), Feature::Edge { from, to, .. }) => point_to_edge(point, from, to),
        (
            Feature::Point(point),
            Feature::Circle {
                center,
                normal,
                radius,
            },
        ) => strict(point_to_circle(point, center, normal, radius)),
        (Feature::Point(point), Feature::Plane { normal, origin, .. }) => {
            infinite(to_plane(point, normal, origin))
        }
        (Feature::Edge { from: a, to: b, .. }, Feature::Edge { from: c, to: d, .. }) => {
            edge_to_edge([a, b], [c, d])
        }
        (
            Feature::Edge { from, to, .. },
            Feature::Circle {
                center,
                normal,
                radius,
            },
        ) => edge_to_circle(from, to, center, normal, radius),
        (Feature::Edge { from, to, .. }, Feature::Plane { normal, origin, .. }) => {
            edge_to_plane(from, to, normal, origin)
        }
        (
            Feature::Circle {
                center: c1,
                normal: n1,
                radius: r1,
            },
            Feature::Circle {
                center: c2,
                normal: n2,
                radius: r2,
            },
        ) => circle_to_circle(c1, n1, r1, c2, n2, r2),
        (
            Feature::Circle { center, normal, .. },
            Feature::Plane {
                normal: pn, origin, ..
            },
        ) => circle_to_plane(center, normal, pn, origin),
        (
            Feature::Plane {
                normal: n1,
                origin: o1,
                ..
            },
            Feature::Plane {
                normal: n2,
                origin: o2,
                ..
            },
        ) => {
            if are_parallel(normalized(n1), normalized(n2)) {
                infinite(to_plane(o1, n2, o2))
            } else {
                angled(angle_plane_plane(n1, o1, n2))
            }
        }
        _ => unreachable!("feature pairs are ordered before measuring"),
    }
}

fn point_to_edge(point: V, from: V, to: V) -> Measurement {
    let direction = sub(to, from);
    let projection = line_projection(from, direction, point);
    let distance_infinite = norm(sub(point, projection));
    let length_sq = squared_norm(direction);
    let start_sq = squared_norm(sub(projection, from));
    let end_sq = squared_norm(sub(projection, to));
    let strict = if start_sq < length_sq && end_sq < length_sq {
        Distance {
            distance: distance_infinite,
            from: point,
            to: projection,
        }
    } else {
        Distance {
            distance: (js_math::min(start_sq, end_sq) + distance_infinite * distance_infinite)
                .sqrt(),
            from: point,
            to: if start_sq < end_sq { from } else { to },
        }
    };
    Measurement {
        strict: Some(strict),
        infinite: Some(Distance {
            distance: distance_infinite,
            from: point,
            to: projection,
        }),
        ..Measurement::default()
    }
}

fn point_to_circle(point: V, center: V, normal: V, radius: f64) -> Distance {
    let projection = plane_projection(normal, center, point);
    if is_approx_vec(projection, center) {
        let on_circle = add(center, scale(orthogonal_unit(normalized(normal)), radius));
        return Distance {
            distance: radius,
            from: center,
            to: on_circle,
        };
    }
    let radial = sub(projection, center);
    let gap = norm(radial) - radius;
    let distance = (gap * gap + squared_norm(sub(point, projection))).sqrt();
    Distance {
        distance,
        from: point,
        to: add(center, scale(normalized(radial), radius)),
    }
}

fn point_edge_strict(point: V, from: V, to: V) -> Distance {
    point_to_edge(point, from, to)
        .strict
        .expect("a point-edge strict distance")
}

fn edge_to_edge(e1: [V; 2], e2: [V; 2]) -> Measurement {
    let mut candidates = vec![
        Distance {
            distance: norm(sub(e2[0], e1[0])),
            from: e1[0],
            to: e2[0],
        },
        Distance {
            distance: norm(sub(e2[1], e1[0])),
            from: e1[0],
            to: e2[1],
        },
        Distance {
            distance: norm(sub(e2[0], e1[1])),
            from: e1[1],
            to: e2[0],
        },
        Distance {
            distance: norm(sub(e2[1], e1[1])),
            from: e1[1],
            to: e2[1],
        },
    ];
    // Only a point-to-edge candidate whose foot lies strictly inside the edge.
    let mut point_edge = |v: V, edge: [V; 2]| {
        let strict = point_edge_strict(v, edge[0], edge[1]);
        let span = sub(edge[1], edge[0]);
        let to_foot = sub(strict.to, edge[0]);
        if dot(to_foot, span) >= 0.0 && norm(to_foot) < norm(span) {
            candidates.push(Distance {
                distance: strict.distance,
                from: v,
                to: strict.to,
            });
        }
    };
    point_edge(e1[0], e2);
    point_edge(e1[1], e2);
    point_edge(e2[0], e1);
    point_edge(e2[1], e1);
    Measurement {
        infinite: Some(nearest(&candidates)),
        angle: angle_edge_edge(e1, e2),
        ..Measurement::default()
    }
}

fn edge_to_circle(from: V, to: V, center: V, normal: V, radius: f64) -> Measurement {
    let span = sub(to, from);
    let unit = normalized(span);
    let mut candidates = vec![
        point_to_circle(from, center, normal, radius),
        point_to_circle(to, center, normal, radius),
    ];
    let denominator = dot(unit, unit);
    if denominator.abs() > 0.0 {
        let t = dot(unit, sub(center, from)) / denominator;
        let intersection = add(from, scale(unit, t));
        let to_intersection = sub(intersection, from);
        if dot(to_intersection, span) >= 0.0 && norm(to_intersection) < norm(span) {
            candidates.push(point_to_circle(intersection, center, normal, radius));
        }
    }
    infinite(nearest(&candidates))
}

fn edge_to_plane(from: V, to: V, normal: V, origin: V) -> Measurement {
    let unit = normalized(sub(to, from));
    let plane_normal = normalized(normal);
    let angle = angle_edge_plane(from, to, normal);
    if !are_perpendicular(unit, plane_normal) {
        return angled(angle);
    }
    let candidates = [to_plane(from, normal, origin), to_plane(to, normal, origin)];
    Measurement {
        infinite: Some(nearest(&candidates)),
        angle,
        ..Measurement::default()
    }
}

fn circle_to_circle(c1: V, n1: V, r1: f64, c2: V, n2: V, r2: f64) -> Measurement {
    let (n1, n2) = (normalized(n1), normalized(n2));
    if !are_parallel(n1, n2) {
        return Measurement {
            unsupported: true,
            ..Measurement::default()
        };
    }
    let axis_offset = sub(c2, c1);
    let along = dot(n1, axis_offset);
    let radial = sub(axis_offset, scale(n1, along));
    if norm(radial) < EPSILON {
        // Coaxial: the closest points differ by the radii and the axial offset.
        let direction = orthogonal_unit(n1);
        let from = add(c1, scale(direction, r1));
        let to = add(c2, scale(direction, r2));
        return infinite(Distance {
            distance: norm(sub(to, from)),
            from,
            to,
        });
    }
    let direction = normalized(radial);
    let from = add(c1, scale(direction, r1));
    let to = sub(c2, scale(direction, r2));
    infinite(Distance {
        distance: norm(sub(to, from)),
        from,
        to,
    })
}

fn circle_to_plane(center: V, normal: V, plane_normal: V, origin: V) -> Measurement {
    if !are_parallel(normalized(normal), normalized(plane_normal)) {
        return infinite(to_plane(center, plane_normal, origin));
    }
    let distance = plane_signed_distance(plane_normal, origin, center).abs();
    if distance < EPSILON {
        return strict(Distance {
            distance: 0.0,
            from: center,
            to: origin,
        });
    }
    infinite(Distance {
        distance,
        from: center,
        to: plane_projection(plane_normal, origin, center),
    })
}

fn angle_edge_edge(e1: [V; 2], e2: [V; 2]) -> Option<Angle> {
    let u1 = normalized(sub(e1[1], e1[0]));
    let u2 = normalized(sub(e2[1], e2[0]));
    if are_parallel(u1, u2) {
        return None;
    }
    let angle = clamped_acos(dot(u1, u2).abs());
    let center = scale(add(e1[0], e2[0]), 0.5);
    let coplanar = dot(normalized(cross(u1, u2)), sub(e2[0], e1[0])).abs() < EPSILON;
    Some(Angle {
        angle: if std::f64::consts::PI / 2.0 - angle > 0.0 {
            clamped_acos(dot(u1, u2))
        } else {
            angle
        },
        center,
        radius: 0.0,
        coplanar,
    })
}

fn angle_edge_plane(from: V, to: V, normal: V) -> Option<Angle> {
    let unit = normalized(sub(to, from));
    let plane_normal = normalized(normal);
    if are_perpendicular(unit, plane_normal) {
        return None;
    }
    // The complement of the angle between the edge and the plane's normal.
    let to_normal = clamped_acos(dot(unit, plane_normal).abs());
    Some(Angle {
        angle: std::f64::consts::PI / 2.0 - to_normal,
        center: from,
        radius: 0.0,
        coplanar: false,
    })
}

fn angle_plane_plane(n1: V, o1: V, n2: V) -> Option<Angle> {
    let (n1, n2) = (normalized(n1), normalized(n2));
    if are_parallel(n1, n2) {
        return None;
    }
    let angle = clamped_acos(dot(n1, n2).abs());
    Some(Angle {
        angle: std::f64::consts::PI - angle,
        center: o1,
        radius: 0.0,
        coplanar: false,
    })
}
