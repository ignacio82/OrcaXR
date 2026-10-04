use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn core_info() -> String {
    orcaxr_contracts::core_info()
}

#[wasm_bindgen]
pub fn evaluate(request: &str) -> String {
    orcaxr_contracts::evaluate(request)
}
