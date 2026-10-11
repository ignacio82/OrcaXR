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
    slicing::configuration_exchange as slicing,
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
pub(crate) struct HostCollation<'a>(pub(crate) &'a PresetCollator);
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
pub(crate) fn json_error(e: JsonInputError) -> JsValue {
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
        Ok(Self {
            inner: Some(
                CatalogUpload::new(index(bytes)?, self::limits(limits)?).map_err(json_error)?,
            ),
        })
    }
    pub fn append(&mut self, offset: f64, bytes: &[u8]) -> Result<(), JsValue> {
        let upload = self.inner.as_mut().ok_or_else(|| error("consumed"))?;
        upload.append(index(offset)?, bytes).map_err(json_error)
    }
    /// Build the catalog. Without a collator the core's exact ASCII root
    /// collation orders presets and refuses any other text.
    pub fn build(&mut self, collator: Option<PresetCollator>) -> Result<ProfileCatalog, JsValue> {
        let upload = self.take()?;
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

impl ProfileCatalogUpload {
    /// The complete upload, once; a consumed upload refuses.
    pub(crate) fn take(&mut self) -> Result<CatalogUpload, JsValue> {
        self.inner.take().ok_or_else(|| error("consumed"))
    }
}
/// JSON budgets: maximum bytes, nodes, text units, number bytes and depth.
pub(crate) fn limits(limits: &[f64]) -> Result<JsonLimits, JsValue> {
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
    Ok(JsonLimits {
        max_bytes: index(*max_bytes)?,
        max_nodes: index(*max_nodes)?,
        max_text_units: index(*max_text_units)?,
        max_number_bytes: index(*max_number_bytes)?,
        max_depth: index(*max_depth)?,
    })
}

/// A loaded catalog: compiled, or refused with its diagnostics.
#[wasm_bindgen]
pub struct ProfileCatalog {
    pub(crate) inner: HostCatalog,
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
    /// The pickers' choices (`slicingChoicesExchange`): canonical JSON
    /// `{"machinePresetId"?, "processPresetId"?}` in, `{"machines",
    /// "processes","filaments"}` of `{"id","label","name"}` out.
    pub fn slicing_choices(&self, request: &str) -> Result<String, JsValue> {
        slicing::choices_json(self.inner.catalog(), request).map_err(error)
    }
    /// A selection by preset ID from a live choice (`profileSelectionExchange`):
    /// `{"live","request"}` in, `{"feedback","live"?}` out.
    pub fn slicing_select(&self, request: &str) -> Result<String, JsValue> {
        slicing::select_json(self.inner.catalog(), request).map_err(error)
    }
    /// A selection by typed names (`profileSelectionByNamesExchange`).
    pub fn slicing_select_by_names(&self, request: &str) -> Result<String, JsValue> {
        slicing::select_by_names_json(self.inner.catalog(), request).map_err(error)
    }
    /// The catalog's default triple selected (`defaultProfileSelectionExchange`).
    pub fn slicing_default(&self, request: &str) -> Result<String, JsValue> {
        slicing::default_selection_json(self.inner.catalog(), request).map_err(error)
    }
    /// One edit of a live choice's filament slots (`filamentSlotsExchange`):
    /// `{"edit","live"}` in, `{"live"}`, `{"unchanged":true}` or
    /// `{"error":"slot-limit","message"}` out.
    pub fn slicing_slots(&self, request: &str) -> Result<String, JsValue> {
        slicing::slots_json(self.inner.catalog(), request).map_err(error)
    }
    /// A live choice's slicing configuration against a state document,
    /// admitted under the host's `Date.parse` (`slicingConfigurationExchange`).
    pub fn slicing_configuration(&self, request: &str) -> Result<String, JsValue> {
        let mut policy = crate::project::timestamps as crate::project::Timestamps;
        slicing::configuration_json(self.inner.catalog(), request, &mut policy).map_err(error)
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

/// The one option a typed name means among `options` (`presetMatchExchange`):
/// `{"options","query"}` in, `{"option": option | null}` out.
#[wasm_bindgen]
pub fn slicing_match(request: &str) -> Result<String, JsValue> {
    slicing::match_json(request).map_err(error)
}
/// The state a slicing configuration leads to (`nextSlicingStateExchange`):
/// `{"autoPairs","configurationJson","stateJson"}` and the random words new
/// pair identities draw (sixteen each) in; `{"stateJson"}`,
/// `{"unchanged":true}` or `{"error","message"}` out, admitted under the
/// host's `Date.parse`.
#[wasm_bindgen]
pub fn slicing_next_state(request: &str, words: &[f64]) -> Result<String, JsValue> {
    let mut policy = crate::project::timestamps as crate::project::Timestamps;
    slicing::next_state_json(request, words, &mut policy).map_err(error)
}
