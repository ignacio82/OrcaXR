//! Semantic validation of canonical typed candidates. Timestamp interpretation
//! belongs to an explicit host policy; no native store or session is published.
mod annotations;
mod graph;
mod mixed;
mod report;
pub(crate) use annotations::has_assignments;
pub use graph::validate_project;
pub use report::*;
pub mod timestamp;

use crate::model::Number;

/// The exact `topZMm.toFixed(4)` collision key used by project validation, even
/// for finite heights outside the authoring range. Multiplying a binary64 by
/// 10_000 first or Rust's fixed formatting would introduce different rounding.
pub fn layer_event_height_key(height: Number) -> String {
    crate::js_math::convert::to_fixed(height.get(), 4)
}
