use crate::{Cancellation, Limits, Model, Text, kind, layout};

pub(crate) enum PathError {
    Cancelled,
    Invalid(Text),
}
impl From<Text> for PathError {
    fn from(message: Text) -> Self {
        Self::Invalid(message)
    }
}
impl From<&str> for PathError {
    fn from(message: &str) -> Self {
        Self::Invalid(message.into())
    }
}
impl From<String> for PathError {
    fn from(message: String) -> Self {
        Self::Invalid(message.into())
    }
}
pub(crate) fn validate(model: &Model, cancel: &Cancellation) -> Result<(), PathError> {
    let c = &model.columns;
    let p = &model.path_points;
    if !layout::valid_lengths(model) {
        return Err("Rich G-code path columns are missing or differ in length".into());
    }
    if p.count > Limits::default().path_points
        || model.limits.path_points < 1
        || model.limits.path_points > Limits::default().path_points
        || p.count > model.limits.path_points
    {
        return Err("Rich G-code path points are outside their bounded typed-array domain".into());
    }
    let mut running = 0;
    for i in 0..c.count {
        if i.is_multiple_of(4096) && cancel.is_cancelled() {
            return Err(PathError::Cancelled);
        }
        let k = c.path_kind[i];
        let count = c.path_point_count[i] as usize;
        if ![0, 2, 3].contains(&k) {
            return Err(format!("Rich G-code record {i} has an invalid path kind").into());
        }
        if c.path_point_offset[i] as usize != running || count > p.count - running {
            return Err(
                format!("Rich G-code record {i} has a non-canonical path-point slice").into(),
            );
        }
        if k == 0 && count != 0 {
            return Err(
                format!("Rich G-code direct record {i} cannot own interpolation points").into(),
            );
        }
        if k != 0 {
            if ![kind::TRAVEL, kind::EXTRUDE].contains(&c.kind[i]) {
                return Err(format!(
                    "Rich G-code arc record {i} has an invalid semantic move kind"
                )
                .into());
            }
            let e = c.delta_e[i];
            if !e.is_finite()
                || (c.kind[i] == kind::TRAVEL && e != 0.0)
                || (c.kind[i] == kind::EXTRUDE && e == 0.0)
            {
                return Err(format!(
                    "Rich G-code arc record {i} has inconsistent extrusion semantics"
                )
                .into());
            }
        }
        if !c.arc_center_x[i].is_finite() || !c.arc_center_y[i].is_finite() {
            return Err(format!("Rich G-code record {i} has a non-finite arc center").into());
        }
        if k == 0 && (c.arc_center_x[i] != 0.0 || c.arc_center_y[i] != 0.0) {
            return Err(format!(
                "Rich G-code direct record {i} has non-canonical arc-center metadata"
            )
            .into());
        }
        running += count;
    }
    if running != p.count {
        return Err("Rich G-code path-point slices do not cover the dense sidecar exactly".into());
    }
    for i in 0..p.count {
        if i.is_multiple_of(4096) && cancel.is_cancelled() {
            return Err(PathError::Cancelled);
        }
        if !p.x[i].is_finite() || !p.y[i].is_finite() || !p.z[i].is_finite() {
            return Err(
                format!("Rich G-code path point {i} contains a non-finite coordinate").into(),
            );
        }
    }
    Ok(())
}
