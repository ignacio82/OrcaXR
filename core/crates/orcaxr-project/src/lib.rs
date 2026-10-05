//! Shared canonical project domain. This crate owns no platform UI, renderer,
//! transport, network client or slicing engine. IDs and immutable assets underpin
//! the project graph/session migration; this is not an editor yet.
pub mod assets;
pub mod facets;
pub mod ids;
pub mod model;
