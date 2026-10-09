//! Printer workflow policy shared by every host (`web/src/printer`): what a
//! Moonraker printer's replies and events mean, independent of how a host
//! moves them. This crate performs no I/O; hosts own transports, clocks and
//! credentials, and feed it the text they received.
pub mod control;
pub mod status;
pub mod summary;
