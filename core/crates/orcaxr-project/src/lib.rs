//! Shared canonical project domain. This crate owns no platform UI, renderer,
//! transport, network client or slicing engine. IDs and immutable assets underpin
//! the project graph/session migration; this is not an editor yet.
pub mod assets;
pub mod clipboard;
pub mod commands;
pub mod export;
pub mod facets;
pub mod history;
pub mod host_layout;
pub mod ids;
pub mod import;
pub mod ingress;
pub mod mesh;
pub mod model;
pub mod query;
pub mod selection;
pub mod session;
pub mod settings;
pub mod staging_layout;
pub mod store;
pub mod validation;
