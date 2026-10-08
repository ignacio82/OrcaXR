//! The profile catalog host exchange (`settings::catalog_exchange`). Catalog
//! JSON streams in under explicit budgets; reads return generated contract JSON.
use crate::project::{error, index};
use orcaxr_contracts::{project_intent_types as wire, project_intents::InvalidIntent};
use orcaxr_project::{
    ingress::json::{JsonInputError, JsonLimits},
    settings::{
        catalog_exchange::{CatalogUpload, HostCatalog},
        presets::{AsciiRootCollation, Collation},
    },
};
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// Any object with `compare(left: Uint16Array, right: Uint16Array): number`
    /// ordering preset text like `localeCompare(…, 'en')`.
    pub type PresetCollator;
    #[wasm_bindgen(method, catch)]
    fn compare(this: &PresetCollator, left: &[u16], right: &[u16]) -> Result<f64, JsValue>;
}
struct HostCollation<'a>(&'a PresetCollator);
impl Collation for HostCollation<'_> {
    type Error = JsValue;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, JsValue> {
        // A sort comparator's NaN orders as equal.
        let n = self.0.compare(left, right)?;
        Ok(if n < 0.0 {
            Ordering::Less
        } else if n > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        })
    }
}
fn json_error(e: JsonInputError) -> JsValue {
    error(match e {
        JsonInputError::InvalidLimits => "invalid_limits",
        JsonInputError::Limit => "input_limit",
        JsonInputError::InvalidChunk => "invalid_chunk",
        JsonInputError::InvalidOffset => "invalid_offset",
        JsonInputError::Incomplete => "incomplete_input",
        _ => "invalid_catalog",
    })
}
fn contract<T>(
    value: Option<T>,
    encode: fn(&T) -> Result<String, InvalidIntent>,
) -> Result<String, JsValue> {
    encode(&value.ok_or_else(|| error("invalid_range"))?).map_err(|_| error("output_limit"))
}
fn request<T>(text: &str, decode: fn(&str) -> Result<T, InvalidIntent>) -> Result<T, JsValue> {
    if text.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    decode(text).map_err(|_| error("invalid_request"))
}

/// Own in a task worker; `build` consumes it.
#[wasm_bindgen]
pub struct ProfileCatalogUpload {
    inner: Option<CatalogUpload>,
}
#[wasm_bindgen]
impl ProfileCatalogUpload {
    /// `limits`: maximum bytes, nodes, text units, number bytes and depth.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: f64, limits: &[f64]) -> Result<ProfileCatalogUpload, JsValue> {
        let [
            max_bytes,
            max_nodes,
            max_text_units,
            max_number_bytes,
            max_depth,
        ] = limits
        else {
            return Err(error("invalid_limits"));
        };
        let limits = JsonLimits {
            max_bytes: index(*max_bytes)?,
            max_nodes: index(*max_nodes)?,
            max_text_units: index(*max_text_units)?,
            max_number_bytes: index(*max_number_bytes)?,
            max_depth: index(*max_depth)?,
        };
        Ok(Self {
            inner: Some(CatalogUpload::new(index(bytes)?, limits).map_err(json_error)?),
        })
    }
    pub fn append(&mut self, offset: f64, bytes: &[u8]) -> Result<(), JsValue> {
        let upload = self.inner.as_mut().ok_or_else(|| error("consumed"))?;
        upload.append(index(offset)?, bytes).map_err(json_error)
    }
    /// Build the catalog. Without a collator the core's exact ASCII root
    /// collation orders presets and refuses any other text.
    pub fn build(&mut self, collator: Option<PresetCollator>) -> Result<ProfileCatalog, JsValue> {
        let upload = self.inner.take().ok_or_else(|| error("consumed"))?;
        let inner = match &collator {
            Some(host) => upload
                .build(&mut HostCollation(host))
                .map_err(|e| match e {
                    orcaxr_project::settings::catalog_exchange::LoadError::Json(e) => json_error(e),
                    orcaxr_project::settings::catalog_exchange::LoadError::Collation(_) => {
                        error("collation_failed")
                    }
                })?,
            None => upload
                .build(&mut AsciiRootCollation)
                .map_err(|e| error(&e.to_string()))?,
        };
        Ok(ProfileCatalog { inner })
    }
}

/// A loaded catalog: compiled, or refused with its diagnostics.
#[wasm_bindgen]
pub struct ProfileCatalog {
    inner: HostCatalog,
}
#[wasm_bindgen]
impl ProfileCatalog {
    pub fn diagnostic_count(&self) -> usize {
        self.inner.diagnostic_count()
    }
    pub fn diagnostic(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.diagnostic(index(position)?),
            wire::encode_catalog_diagnostic,
        )
    }
    pub fn preset_count(&self) -> usize {
        self.inner.preset_count()
    }
    pub fn preset(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.preset(index(position)?),
            wire::encode_catalog_preset,
        )
    }
    pub fn profile_count(&self) -> usize {
        self.inner.profile_count()
    }
    pub fn profile(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.profile(index(position)?),
            wire::encode_catalog_profile,
        )
    }
    pub fn profile_config(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.profile_config(index(position)?),
            wire::encode_catalog_config,
        )
    }
    /// `CatalogSelectionRequest` in, `CatalogSelection` out.
    pub fn reconcile(&self, selection: &str) -> Result<String, JsValue> {
        let selection = request(selection, wire::decode_catalog_selection_request)?;
        contract(
            Some(self.inner.reconcile(&selection)),
            wire::encode_catalog_selection,
        )
    }
    /// `CatalogTargetRequest` in, the `CatalogPreflightTarget` of a
    /// `PreflightRequest` out. More than `max_tools` tools is refused.
    pub fn preflight_target(&self, target: &str, max_tools: f64) -> Result<String, JsValue> {
        let target = request(target, wire::decode_catalog_target_request)?;
        let result = self
            .inner
            .preflight_target(&target, index(max_tools)?)
            .map_err(|e| error(e.code()))?;
        contract(Some(result), wire::encode_catalog_preflight_target)
    }
}
