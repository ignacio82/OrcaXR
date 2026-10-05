//! Shared canonical project domain. This crate owns no platform UI, renderer,
//! transport, network client or slicing engine. The identifier port is the first
//! dependency of the project graph/session migration; it is not an editor yet.
pub mod ids;
