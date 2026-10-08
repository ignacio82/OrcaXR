//! The preset library host exchange (`settings::library_exchange`). A library
//! is created from a catalog upload and the bytes the host stored; operations
//! and replies are generated contract JSON, bundles and state cross as bytes.
use crate::{
    catalog::{
        self, HostCollation, PresetCollator, ProfileCatalog, ProfileCatalogUpload, json_error,
    },
    project::{error, index, timestamps},
};
use orcaxr_contracts::{project_intent_types as wire, project_intents::InvalidIntent};
use orcaxr_project::settings::{
    library::LibraryHost,
    library_exchange::{self, ExchangeError, HostLibrary},
    presets::{AsciiRootCollation, Collation},
};
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

/// The browser's policies: its collator (or the exact ASCII root order) and
/// its own `Date.parse`. Requests carry their own `now`.
struct Policies<'a>(Option<&'a PresetCollator>);
impl LibraryHost for Policies<'_> {
    type Error = &'static str;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, &'static str> {
        match self.0 {
            Some(host) => HostCollation(host)
                .compare(left, right)
                .map_err(|_| "collation_failed"),
            None => AsciiRootCollation
                .compare(left, right)
                .map_err(|_| "non_ascii_collation"),
        }
    }
    fn now(&mut self) -> Vec<u16> {
        Vec::new()
    }
    fn timestamp(&mut self, text: &[u16]) -> Result<bool, &'static str> {
        timestamps(text).map_err(|_| "timestamp_service")
    }
}
fn refused(e: ExchangeError<&'static str>) -> JsValue {
    match e {
        ExchangeError::Json(e) => json_error(e),
        ExchangeError::Host(code) => error(code),
        other => error(&other.to_string()),
    }
}
fn encode<T>(
    value: &T,
    encode: fn(&T) -> Result<String, InvalidIntent>,
) -> Result<String, JsValue> {
    encode(value).map_err(|_| error("output_limit"))
}
fn request<T>(text: &str, decode: fn(&str) -> Result<T, InvalidIntent>) -> Result<T, JsValue> {
    if text.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    decode(text).map_err(|_| error("invalid_request"))
}

/// Installed printers and custom presets over a pinned catalog.
#[wasm_bindgen]
pub struct PresetLibrary {
    inner: HostLibrary,
    collator: Option<PresetCollator>,
}
#[wasm_bindgen]
impl PresetLibrary {
    /// Consume `upload` as the system catalog. `stored` is the text the host
    /// saved, if any; `limits` (bytes, nodes, text units, number bytes, depth)
    /// bound reading it. Without a collator the exact ASCII root order applies.
    pub fn create(
        upload: &mut ProfileCatalogUpload,
        stored: Option<Vec<u8>>,
        limits: &[f64],
        collator: Option<PresetCollator>,
    ) -> Result<PresetLibrary, JsValue> {
        let upload = upload.take()?;
        let limits = catalog::limits(limits)?;
        let inner = HostLibrary::create(
            upload,
            stored.as_deref(),
            limits,
            &mut Policies(collator.as_ref()),
        )
        .map_err(refused)?;
        Ok(PresetLibrary { inner, collator })
    }
    /// A `LibraryOperation`; returns its `LibraryOutcome`.
    pub fn apply(&mut self, operation: &str) -> Result<String, JsValue> {
        let operation = request(operation, wire::decode_library_operation)?;
        let outcome = self
            .inner
            .apply(&operation, &mut Policies(self.collator.as_ref()))
            .map_err(refused)?;
        encode(&outcome, wire::encode_library_outcome)
    }
    /// A bundle's bytes; returns its `LibraryOutcome`.
    pub fn import_bundle(&mut self, bundle: &[u8], limits: &[f64]) -> Result<String, JsValue> {
        let limits = catalog::limits(limits)?;
        let outcome = self
            .inner
            .import(bundle, limits, &mut Policies(self.collator.as_ref()))
            .map_err(refused)?;
        encode(&outcome, wire::encode_library_outcome)
    }
    pub fn issue_count(&self) -> usize {
        self.inner.issue_count()
    }
    /// The latest outcome's issue at `position`, as a `LibraryIssue`.
    pub fn issue(&self, position: f64) -> Result<String, JsValue> {
        let issue = self
            .inner
            .issue(index(position)?)
            .ok_or_else(|| error("invalid_range"))?;
        encode(&issue, wire::encode_library_issue)
    }
    /// The bundle to hand the operator, as UTF-8.
    pub fn export_bundle(&self, exported_at: &str, max_bytes: f64) -> Result<Vec<u8>, JsValue> {
        let at: Vec<u16> = exported_at.encode_utf16().collect();
        self.inner.export(&at, index(max_bytes)?).map_err(refused)
    }
    /// The text to store, as UTF-8.
    pub fn state(&self, max_bytes: f64) -> Result<Vec<u8>, JsValue> {
        self.inner.state(index(max_bytes)?).map_err(refused)
    }
    pub fn view(&self) -> Result<String, JsValue> {
        encode(&self.inner.view(), wire::encode_library_view)
    }
    pub fn custom_preset(&self, position: f64) -> Result<String, JsValue> {
        let preset = self
            .inner
            .custom_preset(index(position)?)
            .ok_or_else(|| error("invalid_range"))?;
        encode(&preset, wire::encode_library_custom_preset)
    }
    pub fn inventory(&self) -> Result<String, JsValue> {
        let inventory = self
            .inner
            .inventory(&mut Policies(self.collator.as_ref()))
            .map_err(refused)?;
        encode(&inventory, wire::encode_library_inventory)
    }
    /// A `LibraryBaseRequest`; returns `LibraryBases`.
    pub fn bases(&self, request: &str) -> Result<String, JsValue> {
        let request = self::request(request, wire::decode_library_base_request)?;
        encode(&self.inner.bases(&request), wire::encode_library_bases)
    }
    /// The composed catalog, as the profile catalog the app reads.
    pub fn catalog(&self) -> Result<ProfileCatalog, JsValue> {
        let inner = self
            .inner
            .catalog(&mut Policies(self.collator.as_ref()))
            .map_err(refused)?;
        Ok(ProfileCatalog { inner })
    }
    /// Consume an upload of a newer catalog; returns a `LibraryUpdatePlan`.
    pub fn plan_update(&mut self, next: &mut ProfileCatalogUpload) -> Result<String, JsValue> {
        let next = next.take()?;
        let plan = self
            .inner
            .plan_update(next, &mut Policies(self.collator.as_ref()))
            .map_err(refused)?;
        encode(&plan, wire::encode_library_update_plan)
    }
    /// Consume an upload and move onto it; returns a `LibraryOutcome`.
    pub fn apply_update(&mut self, next: &mut ProfileCatalogUpload) -> Result<String, JsValue> {
        let next = next.take()?;
        let outcome = self
            .inner
            .apply_update(next, &mut Policies(self.collator.as_ref()))
            .map_err(refused)?;
        encode(&outcome, wire::encode_library_outcome)
    }
}

/// `coerceOverrideValue`: a `LibraryCoerceRequest` to a `LibraryCoercedValue`.
#[wasm_bindgen]
pub fn coerce_override_value(request: &str) -> Result<String, JsValue> {
    let request = self::request(request, wire::decode_library_coerce_request)?;
    let value = library_exchange::coerce(&request).map_err(refused)?;
    encode(&value, wire::encode_library_coerced_value)
}
/// `formatOverrideValue`: a `LibraryFormatRequest` to a `LibraryFormattedValue`.
#[wasm_bindgen]
pub fn format_override_value(request: &str) -> Result<String, JsValue> {
    let request = self::request(request, wire::decode_library_format_request)?;
    let value = library_exchange::format(&request).map_err(refused)?;
    encode(&value, wire::encode_library_formatted_value)
}
