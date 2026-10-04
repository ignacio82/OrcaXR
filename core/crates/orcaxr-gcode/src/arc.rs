use crate::{Cancellation, ParseError, PathPoints, Text, f, finite_f32};
use std::f64::consts::PI;

pub(crate) struct Plan {
    pub count: usize,
    radians: f64,
    z: f64,
}
pub(crate) fn length(x: f64, y: f64) -> f64 {
    f(f(f(x * x) + f(y * y)).sqrt())
}

pub(crate) fn radians(start: [f64; 2], end: [f64; 2], center: [f64; 2], ccw: bool) -> f64 {
    let sx = f(center[0] - start[0]);
    let sy = f(center[1] - start[1]);
    let ex = f(center[0] - end[0]);
    let ey = f(center[1] - end[1]);
    if length(f(sx - ex), f(sy - ey)) < 1e-6 {
        return f(2.0 * PI);
    }
    let dot = f(f(sx * ex) + f(sy * ey));
    let cross = sx * ey - sy * ex;
    let angle = f(cross.atan2(dot));
    if ccw {
        f(if angle < 0.0 { 2.0 * PI + angle } else { angle })
    } else {
        f(if angle < 0.0 {
            angle.abs()
        } else {
            2.0 * PI - angle
        })
    }
}

pub(crate) fn plan(radius: f64, angle: f64, delta_z: f64) -> Option<Plan> {
    let tolerance = f(0.0125);
    if radius <= tolerance {
        return Some(Plan {
            count: 0,
            radians: 0.0,
            z: delta_z,
        });
    }
    let ratio = f(f(radius - tolerance) / radius);
    let step = f(2.0 * f(ratio.acos()));
    if !step.is_finite() || step <= 0.0 {
        return None;
    }
    let ratio = f(angle / step);
    if !ratio.is_finite() || ratio < 0.0 || ratio.floor() > 9_007_199_254_740_991.0 {
        return None;
    }
    // All supported retained arcs are capped at 8M points before allocation.
    if ratio.floor() > usize::MAX as f64 {
        return None;
    }
    let z = f(if ratio < 1.0 {
        delta_z
    } else {
        f(delta_z / ratio)
    });
    z.is_finite().then_some(Plan {
        count: ratio.floor() as usize,
        radians: step,
        z,
    })
}

pub(crate) fn points(
    plan: Plan,
    start: [f64; 3],
    center: [f64; 2],
    ccw: bool,
    retain: bool,
    cancellation: &Cancellation,
) -> Result<Option<PathPoints>, ParseError> {
    let capacity = if retain { plan.count } else { 0 };
    let mut points = PathPoints {
        count: plan.count,
        x: Vec::with_capacity(capacity),
        y: Vec::with_capacity(capacity),
        z: Vec::with_capacity(capacity),
    };
    let dx = f(start[0] - center[0]);
    let dy = f(start[1] - center[1]);
    let step = f(if ccw { plan.radians } else { -plan.radians });
    for index in 0..plan.count {
        if index % 256 == 0 && cancellation.is_cancelled() {
            return Err(ParseError::Cancelled);
        }
        let radians = f((index + 1) as f64 * step);
        let cos = f(radians.cos());
        let sin = f(radians.sin());
        let x = f(f(center[0] + f(dx * cos)) - f(dy * sin));
        let y = f(f(center[1] + f(dx * sin)) + f(dy * cos));
        let z = f(start[2] + f((index + 1) as f64 * plan.z));
        if ![x, y, z].into_iter().all(finite_f32) {
            return Ok(None);
        }
        if retain {
            points.x.push(x as f32);
            points.y.push(y as f32);
            points.z.push(z as f32);
        }
    }
    Ok(Some(points))
}

pub(crate) fn width(role: &Text, diameter: f64, delta_e: f64, distance: f64, height: f64) -> f64 {
    if distance <= 0.0 || delta_e <= 0.0 || height <= 0.0 {
        return 0.4;
    }
    let radius = diameter * 0.5;
    let mut width = match () {
        _ if role.equals("Outer wall") => {
            delta_e * PI * (1.05 * radius).powi(2) / (distance * height)
        }
        _ if role.equals("Bridge")
            || role.equals("Internal Bridge")
            || role.equals("Undefined") =>
        {
            diameter * (delta_e / distance).sqrt()
        }
        _ => delta_e * PI * radius.powi(2) / (distance * height) + (1.0 - 0.25 * PI) * height,
    };
    if !width.is_finite() || width == 0.0 {
        width = 0.4;
    }
    width.min(2.0_f64.max(4.0 * height))
}

pub(crate) fn arc_width(
    role: &Text,
    diameter: f64,
    radius: f64,
    delta_e: f64,
    distance: f64,
    height: f64,
    forced: f64,
) -> f64 {
    let mut width = if forced > 0.0 {
        forced
    } else if delta_e <= 0.0 || distance <= 0.0 || height <= 0.0 {
        f(0.4)
    } else {
        match () {
            _ if role.equals("Outer wall") => {
                let scaled = f(f(1.05) * radius);
                let cross_section = f(PI * f(scaled * scaled));
                f(delta_e * cross_section / f(distance * height))
            }
            _ if role.equals("Bridge")
                || role.equals("Internal Bridge")
                || role.equals("Undefined") =>
            {
                f(diameter * (delta_e / distance).sqrt())
            }
            _ => {
                let cross_section = f(PI * f(radius * radius));
                let rectangular = delta_e * cross_section / f(distance * height);
                f(rectangular + f(f(1.0 - 0.25 * PI) * height))
            }
        }
    };
    if width.is_nan() || width == 0.0 {
        width = f(0.4);
    }
    f(width.min(f(2.0).max(f(4.0 * height))))
}
