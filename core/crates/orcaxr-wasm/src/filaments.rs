//! The virtual filament library's author dialog
//! (`orcaxr_project::filaments::library::exchange`): canonical JSON requests
//! over a library document, as `VirtualFilamentExchange.ts` answers them. A
//! malformed request throws `invalid_request`.
use crate::project::error;
use orcaxr_project::filaments::library::exchange;
use wasm_bindgen::prelude::*;

/// The fields an author dialog opens with (`virtualFilamentFormDefaultsExchange`):
/// `{"library","operation","filamentId"}` in, the form out.
#[wasm_bindgen]
pub fn virtual_filament_form_defaults(request: &str) -> Result<String, JsValue> {
    exchange::defaults_json(request).map_err(error)
}

/// What the dialog shows for its fields (`virtualFilamentFormExchange`):
/// `{"library","form","search"}` in, `{"issues","preview",...}` out.
#[wasm_bindgen]
pub fn virtual_filament_form(request: &str) -> Result<String, JsValue> {
    exchange::form_json(request).map_err(error)
}

/// The proportions the triangle picker writes (`virtualFilamentTriangleExchange`):
/// `{"x","y"}` in, `{"weights"}` or `{"error"}` out.
#[wasm_bindgen]
pub fn virtual_filament_triangle(request: &str) -> Result<String, JsValue> {
    exchange::triangle_json(request).map_err(error)
}

/// The pinned Match search's candidates (`virtualFilamentMatchSearchExchange`):
/// `{"library","targetColor","minComponentPercent"}` in, `{"candidates"}` out.
#[wasm_bindgen]
pub fn virtual_filament_match_search(request: &str) -> Result<String, JsValue> {
    exchange::match_search_json(request).map_err(error)
}
