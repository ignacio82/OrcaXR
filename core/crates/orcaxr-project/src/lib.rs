//! Shared canonical project domain. This crate owns no platform UI, renderer,
//! transport, network client or slicing engine. IDs and immutable assets underpin
//! the project graph/session migration; this is not an editor yet.
/// A closed set of browser string codes as a Rust enum with `as_str` and `ALL`.
macro_rules! names {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }
    };
}
pub mod assets;
pub mod capabilities;
pub mod clipboard;
pub mod commands;
pub mod export;
pub mod facets;
pub mod filaments;
pub mod history;
pub mod host_layout;
pub mod ids;
pub mod import;
pub mod ingress;
pub mod js_math;
pub mod layer_heights;
pub mod mesh;
pub mod model;
pub mod query;
pub mod selection;
pub mod session;
pub mod settings;
pub mod slicing;
pub mod staging_layout;
pub mod store;
pub mod validation;
