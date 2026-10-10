//! The workspace's bed and the transform inspector's fields
//! (`orcaxr_project::placement::{bed, fields}`): canonical JSON requests and
//! replies, as `WorkspaceBedExchange.ts` and `TransformFieldsExchange.ts`
//! answer them. A malformed request throws `invalid_request`.
use crate::project::error;
use orcaxr_project::placement::{bed, fields};
use wasm_bindgen::prelude::*;

/// A project configuration's bed and a plate tower's keep-out
/// (`workspaceBedExchange`): `{"config","wipeTower"}` in,
/// `{"keepOut","printableArea","printableHeightMm","sizeMm"}` out.
#[wasm_bindgen]
pub fn workspace_bed(request: &str) -> Result<String, JsValue> {
    bed::bed_json(request).map_err(error)
}

/// What a tool's three fields show (`transformFieldsExchange`):
/// `{"tool","transform"}` in, `{"texts","values"}` out.
#[wasm_bindgen]
pub fn transform_fields(request: &str) -> Result<String, JsValue> {
    fields::fields_json(request).map_err(error)
}

/// What an edit of the three fields submits (`transformFieldEditExchange`):
/// `{"origins","primaryInstanceId","texts","tool"}` in, `{"changes"}` or
/// `{"error":"invalid_edit","message"}` out.
#[wasm_bindgen]
pub fn transform_field_edit(request: &str) -> Result<String, JsValue> {
    fields::edit_json(request).map_err(error)
}

/// three's Euler ↔ quaternion conversion (`transformRotationExchange`):
/// `{"rotation"}` → `{"eulerRadians"}`, or `{"eulerRadians"}` → `{"rotation"}`.
#[wasm_bindgen]
pub fn transform_rotation(request: &str) -> Result<String, JsValue> {
    fields::rotation_json(request).map_err(error)
}
