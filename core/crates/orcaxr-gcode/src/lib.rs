//! Bounded, UI-independent G-code computation. The TypeScript parser remains
//! the production/reference implementation until cross-host qualification.
mod arc;
mod cancellation;
pub mod layout;
mod lexer;
mod model;
mod packet;
mod parser;
mod path;
pub mod preview;
mod session;
mod text;

pub use cancellation::Cancellation;
pub use model::*;
pub use packet::pack;
pub use parser::{
    index, index_with_cancellation, parse, parse_window, parse_window_with_cancellation,
    parse_with_cancellation,
};
pub use session::{Session, SessionError};
pub use text::Text;

/// Explicit float assignments preserve the pinned processor's operation order.
#[inline]
fn f(value: f64) -> f64 {
    (value as f32) as f64
}

fn finite_f32(value: f64) -> bool {
    value.is_finite() && (value as f32).is_finite()
}

fn number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}
