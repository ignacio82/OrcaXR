//! The workspace's bed, the transform inspector's fields and gizmo, and how
//! the shells arrange catalogue actions (`orcaxr_project::placement::{bed, fields, gizmo}`,
//! `orcaxr_project::action_presentation`): canonical JSON requests and replies,
//! as `WorkspaceBedExchange.ts`, `TransformFieldsExchange.ts` and
//! `ActionPresentationExchange.ts` answer them. A malformed request throws
//! `invalid_request`.
use crate::project::error;
use orcaxr_project::placement::{bed, fields, gizmo};
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

/// The transform gizmo attached to a proxy pose (`orcaxr_project::placement::gizmo`):
/// `{"proxy"}` in, the gizmo's state out.
#[wasm_bindgen]
pub fn transform_gizmo_attach(request: &str) -> Result<String, JsValue> {
    gizmo::attach_json(request).map_err(error)
}

/// One pointer event (`transformGizmoExchange`'s steps):
/// `{"camera","event","mode","root","space","state"}` in, the next state out.
#[wasm_bindgen]
pub fn transform_gizmo_step(request: &str) -> Result<String, JsValue> {
    gizmo::step_json(request).map_err(error)
}

/// What the gizmo shows: `{"camera","mode","root","space","state"}` in,
/// `{"axis","dragging","handles","proxy"}` out.
#[wasm_bindgen]
pub fn transform_gizmo_present(request: &str) -> Result<String, JsValue> {
    gizmo::present_json(request).map_err(error)
}

/// Every gizmo handle's baked geometry and the drag plane's
/// (`transformGizmoGeometryExchange`).
#[wasm_bindgen]
pub fn transform_gizmo_geometry() -> Result<String, JsValue> {
    gizmo::geometry_json().map_err(error)
}

/// What a gizmo drag submits (`transformGizmoChangesExchange`):
/// `{"initialProxy","mode","origins","proxy"}` in, `{"changes"}` or
/// `{"error":"invalid_drag","message"}` out.
#[wasm_bindgen]
pub fn transform_gizmo_changes(request: &str) -> Result<String, JsValue> {
    gizmo::changes_json(request).map_err(error)
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

/// The command palette's search (`commandPaletteExchange`):
/// `{"actions":[{"hint"?,"id","label"}],"query"}` in, `{"matches":[index]}` out.
#[wasm_bindgen]
pub fn command_palette(request: &str) -> Result<String, JsValue> {
    orcaxr_project::action_presentation::palette_json(request).map_err(error)
}

/// A context menu's sections or the model toolbar's runs (`actionGroupsExchange`):
/// `{"actions":[id],"layout"}` in, `{"groups":[{"actions","group","label"}]}` out.
#[wasm_bindgen]
pub fn action_groups(request: &str) -> Result<String, JsValue> {
    orcaxr_project::action_presentation::groups_json(request).map_err(error)
}

/// What a printer's `thumbnails` value asks for (`thumbnailListExchange`):
/// `{"value"?}` in, `{"problems","requests"}` out.
#[wasm_bindgen]
pub fn slice_thumbnail_list(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::thumbnails::list_json(request).map_err(error)
}

/// One thumbnail in the engine's wire format (`thumbnailBlockExchange`):
/// `{"image","request"}` in, the block's text as a JSON string out.
#[wasm_bindgen]
pub fn slice_thumbnail_block(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::thumbnails::block_json(request).map_err(error)
}

/// A G-code with its thumbnail blocks (`thumbnailInjectExchange`):
/// `{"blocks","gcode"}` in, the G-code as a JSON string out.
#[wasm_bindgen]
pub fn slice_thumbnail_inject(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::thumbnails::inject_json(request).map_err(error)
}

/// The thumbnail camera (`thumbnailViewExchange`): `{"aspect","max","min"}`
/// in, `{"fovDeg","position","target"}` out.
#[wasm_bindgen]
pub fn slice_thumbnail_view(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::thumbnails::view_json(request).map_err(error)
}

/// The plates a slice slices (`slicePlanExchange`): `{"scope","stateJson"}`
/// in, `{"plateIds"}` or `{"refusal"}` out.
#[wasm_bindgen]
pub fn slice_plan(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::plate::plan_json(request).map_err(error)
}

/// The profile snapshot a plate is sliced with (`sliceProfilesExchange`):
/// `{"plateId","stateJson"}` in, `{"effectiveConfigHash","references"}` or
/// `{"error"}` out.
#[wasm_bindgen]
pub fn slice_profiles(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::sidecar::profiles_json(request).map_err(error)
}

/// An output binding checked (`sliceBindingExchange`): `{"binding"}` in,
/// `{"valid":true}` or `{"error"}` out.
#[wasm_bindgen]
pub fn slice_binding(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::sidecar::binding_json(request).map_err(error)
}

/// This device's route (`orcaxr_project::slicing::sidecar::Route::android_native`):
/// `{"engine":{"artifactHash","commit"}}` in, the route's metadata or
/// `{"error"}` out.
#[wasm_bindgen]
pub fn slice_native_route(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::sidecar::native_route_json(request).map_err(error)
}

/// The sidecar published beside a plate's G-code:
/// `{"binding","gcodeBytes","profiles","route","summary","warnings"}` in, the
/// `orcaxr.slice-output` document or `{"error"}` out.
#[wasm_bindgen]
pub fn slice_sidecar(request: &str) -> Result<String, JsValue> {
    orcaxr_project::slicing::sidecar::sidecar_json(request).map_err(error)
}
