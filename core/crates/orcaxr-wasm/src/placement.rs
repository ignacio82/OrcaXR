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

/// A primitive's or the helper cube's canonical mesh payload
/// (`orcaxr_project::primitives::payload_json`): `{"kind","sizeMm"}` in, the
/// bytes the browser stores out.
#[wasm_bindgen]
pub fn primitive_payload(request: &str) -> Result<Vec<u8>, JsValue> {
    orcaxr_project::primitives::payload_json(request).map_err(error)
}

/// three's Euler ↔ quaternion conversion (`transformRotationExchange`):
/// `{"rotation"}` → `{"eulerRadians"}`, or `{"eulerRadians"}` → `{"rotation"}`.
#[wasm_bindgen]
pub fn transform_rotation(request: &str) -> Result<String, JsValue> {
    fields::rotation_json(request).map_err(error)
}

/// The paint stroke sample a pointer hit makes with the painter's settings
/// (`paintToolSampleExchange`): `{"channel","hit","settings","stateOrder"}`
/// in, `{"sample"}` or `{"error","message"}` out.
#[wasm_bindgen]
pub fn paint_tool_sample(request: &str) -> Result<String, JsValue> {
    orcaxr_project::facets::paint_tool::sample_json(request).map_err(error)
}

/// The colours a filament library paints states in (`paintFacetColorsExchange`):
/// `{"channel","filaments","states"}` in, `{"colors"}` out.
#[wasm_bindgen]
pub fn paint_facet_colors(request: &str) -> Result<String, JsValue> {
    orcaxr_project::facets::paint_facets::colors_json(request).map_err(error)
}
