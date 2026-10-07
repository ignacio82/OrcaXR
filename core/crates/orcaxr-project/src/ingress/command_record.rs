//! Full command records use explicit bulk-input budgets, never the small intent
//! envelope's limits. Finishing proves typed structure only. References, settings,
//! transforms and paint are validated in the command's destination graph on apply.
//! This is a local staging API; it creates no session handles or wire authority.
use super::json::{JsonInput, JsonInputError, JsonLimits};
use crate::model::{Decode, ProjectInstance, ProjectObject, ShapeError};
use std::{fmt, sync::Arc};

#[derive(Debug)]
pub enum CommandRecordError {
    Json(JsonInputError),
    Shape(ShapeError),
}
impl fmt::Display for CommandRecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl std::error::Error for CommandRecordError {}

macro_rules! input {
    ($name:ident, $record:ty) => {
        #[derive(Debug)]
        pub struct $name {
            json: JsonInput,
        }
        impl $name {
            pub fn new(bytes: usize, limits: JsonLimits) -> Result<Self, JsonInputError> {
                Ok(Self {
                    json: JsonInput::new(bytes, limits)?,
                })
            }
            pub fn received_bytes(&self) -> usize {
                self.json.received_bytes()
            }
            pub fn append(&mut self, offset: usize, bytes: &[u8]) -> Result<(), JsonInputError> {
                self.json.append(offset, bytes)
            }
            /// Consumes staging; no live state is changed, including on failure.
            /// The owning import task must schedule final typed decoding separately
            /// from the UI/authority worker. Dropping input cancels it immediately.
            pub fn finish(self) -> Result<Arc<$record>, CommandRecordError> {
                let value = self.json.finish().map_err(CommandRecordError::Json)?;
                <$record>::from_value(value)
                    .map(Arc::new)
                    .map_err(CommandRecordError::Shape)
            }
        }
    };
}
input!(InstanceInput, ProjectInstance);
input!(ObjectInput, ProjectObject);
