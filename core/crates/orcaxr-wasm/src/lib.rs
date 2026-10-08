use wasm_bindgen::prelude::*;
#[cfg(feature = "project")]
mod archive;
#[cfg(feature = "project")]
mod catalog;
#[cfg(feature = "project")]
mod editor;
#[cfg(feature = "project")]
mod library;
#[cfg(feature = "project")]
mod model;
#[cfg(feature = "project")]
mod project;

#[wasm_bindgen]
pub fn core_info() -> String {
    orcaxr_contracts::core_info()
}

#[wasm_bindgen]
pub fn evaluate(request: &str) -> String {
    orcaxr_contracts::evaluate(request)
}

#[cfg(feature = "gcode")]
fn gcode_error(error: orcaxr_gcode::SessionError) -> JsValue {
    JsValue::from_str(error.code())
}
#[cfg(feature = "gcode")]
fn gcode_index(value: f64) -> Result<usize, JsValue> {
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=u32::MAX as f64).contains(&value) {
        Err(JsValue::from_str("invalid_range"))
    } else {
        Ok(value as usize)
    }
}

/// Own in a task worker. wasm-bindgen copies each input chunk and each output
/// packet; callers transfer the resulting owned buffer, never a borrowed view.
#[cfg(feature = "gcode")]
#[wasm_bindgen]
pub struct GcodeSession {
    inner: orcaxr_gcode::Session,
}
#[cfg(feature = "gcode")]
#[wasm_bindgen]
impl GcodeSession {
    #[wasm_bindgen(constructor)]
    pub fn new(version: f64, source_units: f64, options: &str) -> Result<GcodeSession, JsValue> {
        if version != orcaxr_gcode::layout::VERSION as f64 {
            return Err(JsValue::from_str("unsupported_protocol"));
        }
        Ok(Self {
            inner: orcaxr_gcode::Session::new(
                gcode_index(source_units)?,
                options,
                Default::default(),
            )
            .map_err(gcode_error)?,
        })
    }
    pub fn append(&mut self, offset: f64, units: &[u16]) -> Result<(), JsValue> {
        self.inner
            .append(gcode_index(offset)?, units)
            .map_err(gcode_error)
    }
    pub fn seal(&mut self) -> Result<String, JsValue> {
        self.inner.seal().map_err(gcode_error)
    }
    pub fn page(&self, start: f64, count: f64) -> Result<String, JsValue> {
        self.inner
            .page(gcode_index(start)?, gcode_index(count)?)
            .map_err(gcode_error)
    }
    pub fn window(&mut self, first: f64, last: f64) -> Result<Vec<u8>, JsValue> {
        self.inner
            .window(gcode_index(first)?, gcode_index(last)?)
            .map_err(gcode_error)
    }
    pub fn whole(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.whole().map_err(gcode_error)
    }
    pub fn view(&mut self, request: &str) -> Result<Vec<u8>, JsValue> {
        self.inner.view(request).map_err(gcode_error)
    }
    /// Readable source lines with the browser viewer's clamping; JSON text is
    /// UTF-16 code units. Non-finite or nonpositive counts return no lines.
    #[wasm_bindgen(js_name = textWindow)]
    pub fn text_window(&mut self, from: f64, count: f64) -> Result<String, JsValue> {
        self.inner.text_window(from, count).map_err(gcode_error)
    }
    /// Case-insensitive line search over the sealed source, bounded by `limit`.
    #[wasm_bindgen(js_name = textSearch)]
    pub fn text_search(&mut self, query: &[u16], limit: f64) -> Result<String, JsValue> {
        if query.len() > orcaxr_gcode::layout::MAX_QUERY_UNITS {
            return Err(JsValue::from_str("resource_limit"));
        }
        self.inner
            .text_search(query, gcode_index(limit)?)
            .map_err(gcode_error)
    }
}
