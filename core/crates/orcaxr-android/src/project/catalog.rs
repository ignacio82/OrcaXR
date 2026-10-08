//! The profile catalog host exchange. A catalog upload streams JSON under
//! explicit budgets; building consumes it in place and the slot then holds the
//! loaded catalog, read one generated contract value at a time.
use super::*;
use orcaxr_contracts::{project_intent_types as wire, project_intents::InvalidIntent};
use orcaxr_project::{
    ingress::json::{JsonInputError, JsonLimits},
    settings::{
        catalog_exchange::{CatalogUpload, HostCatalog, LoadError},
        presets::{AsciiRootCollation, Collation},
    },
};
use std::cmp::Ordering;

pub(super) fn json_code(e: JsonInputError) -> &'static str {
    match e {
        JsonInputError::InvalidLimits => "invalid_limits",
        JsonInputError::Limit => "input_limit",
        JsonInputError::InvalidChunk => "invalid_chunk",
        JsonInputError::InvalidOffset => "invalid_offset",
        JsonInputError::Incomplete => "incomplete_input",
        _ => "invalid_catalog",
    }
}

pub(super) fn char_array<'local>(
    env: &mut JNIEnv<'local>,
    units: &[u16],
) -> Result<JObject<'local>> {
    let array = env
        .new_char_array(units.len() as i32)
        .map_err(|_| "allocation_failed")?;
    env.set_char_array_region(&array, 0, units)
        .map_err(|_| "allocation_failed")?;
    Ok(array.into())
}
/// `dev.orcaxr.core.PresetCollator.compare(char[], char[])`, called on this
/// JNI thread while the build runs.
pub(super) struct JavaCollation<'a, 'env, 'obj> {
    pub(super) env: &'a mut JNIEnv<'env>,
    pub(super) collator: &'a JObject<'obj>,
}
impl Collation for JavaCollation<'_, '_, '_> {
    type Error = &'static str;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering> {
        let a = char_array(self.env, left)?;
        let b = char_array(self.env, right)?;
        let result = self
            .env
            .call_method(
                self.collator,
                "compare",
                "([C[C)I",
                &[(&a).into(), (&b).into()],
            )
            .and_then(|v| v.i());
        let _ = self.env.delete_local_ref(a);
        let _ = self.env.delete_local_ref(b);
        // A callback may throw private text: clear it, report a stable code.
        let value = result.map_err(|_| {
            let _ = self.env.exception_clear();
            "collation_failed"
        })?;
        Ok(value.cmp(&0))
    }
}

/// JSON budgets: maximum bytes, nodes, text units, number bytes and depth.
pub(super) fn json_limits(env: &mut JNIEnv<'_>, limits: &JDoubleArray<'_>) -> Result<JsonLimits> {
    let [
        max_bytes,
        max_nodes,
        max_text_units,
        max_number_bytes,
        max_depth,
    ] = option_values::<5>(env, limits)?;
    let count = |v: f64| {
        (v.is_finite() && v.fract() == 0.0 && (0.0..=layout::MAX_BUDGET as f64).contains(&v))
            .then_some(v as usize)
            .ok_or("invalid_options")
    };
    Ok(JsonLimits {
        max_bytes: count(max_bytes)?,
        max_nodes: count(max_nodes)?,
        max_text_units: count(max_text_units)?,
        max_number_bytes: count(max_number_bytes)?,
        max_depth: count(max_depth)?,
    })
}
pub(super) fn catalog_upload_new(
    env: &mut JNIEnv<'_>,
    bytes: jlong,
    limits: JDoubleArray<'_>,
) -> Result<jlong> {
    let limits = json_limits(env, &limits)?;
    let reserved = registry().reserve(true)?;
    let upload = CatalogUpload::new(index(bytes)?, limits).map_err(json_code)?;
    reserved.insert(Record::CatalogUpload(Box::new(upload)))
}
/// A refused chunk is not consumed; offsets make retries explicit.
pub(super) fn catalog_upload_append(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    offset: jlong,
    bytes: JByteArray<'_>,
) -> Result<()> {
    let length = env.get_array_length(&bytes).map_err(|_| "invalid_input")?;
    if length < 0 || length as usize > layout::MAX_CHUNK_BYTES {
        return Err("input_limit");
    }
    let chunk = env
        .convert_byte_array(&bytes)
        .map_err(|_| "invalid_input")?;
    with_catalog_upload(handle, |u| {
        u.append(index(offset)?, &chunk).map_err(json_code)
    })
}
/// Consumes the upload on every outcome. A null collator uses the core's exact
/// ASCII root collation, which refuses other text.
pub(super) fn catalog_build(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    collator: JObject<'_>,
) -> Result<()> {
    if !collator.is_null()
        && !env
            .is_instance_of(&collator, "dev/orcaxr/core/PresetCollator")
            .map_err(|_| "collation_failed")?
    {
        return Err("collation_failed");
    }
    registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::CatalogUpload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::CatalogUpload(upload)) = record.take() else {
            unreachable!()
        };
        let built = if collator.is_null() {
            upload.build(&mut AsciiRootCollation).map_err(|e| match e {
                LoadError::Json(e) => json_code(e),
                LoadError::Collation(_) => "non_ascii_collation",
            })
        } else {
            upload
                .build(&mut JavaCollation {
                    env,
                    collator: &collator,
                })
                .map_err(|e| match e {
                    LoadError::Json(e) => json_code(e),
                    LoadError::Collation(code) => code,
                })
        }?;
        *record = Some(Record::Catalog(Box::new(built)));
        Ok(())
    })
}
fn reply<T>(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    read: impl FnOnce(&HostCatalog) -> Result<Option<T>>,
    encode: fn(&T) -> std::result::Result<String, InvalidIntent>,
) -> Result<jstring> {
    let json = with_catalog(handle, |c| {
        let value = read(c)?.ok_or("invalid_range")?;
        encode(&value).map_err(|_| "output_limit")
    })?;
    string(env, json)
}
pub(super) fn catalog_diagnostic_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_catalog(handle, |c| Ok(c.diagnostic_count() as jlong))
}
pub(super) fn catalog_diagnostic(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |c| Ok(c.diagnostic(position)),
        wire::encode_catalog_diagnostic,
    )
}
pub(super) fn catalog_preset_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_catalog(handle, |c| Ok(c.preset_count() as jlong))
}
pub(super) fn catalog_preset(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |c| Ok(c.preset(position)),
        wire::encode_catalog_preset,
    )
}
pub(super) fn catalog_profile_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_catalog(handle, |c| Ok(c.profile_count() as jlong))
}
pub(super) fn catalog_profile(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |c| Ok(c.profile(position)),
        wire::encode_catalog_profile,
    )
}
pub(super) fn catalog_profile_config(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    reply(
        env,
        handle,
        |c| Ok(c.profile_config(position)),
        wire::encode_catalog_config,
    )
}
pub(super) fn catalog_reconcile(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = intent_text(env, &request)?;
    let request =
        wire::decode_catalog_selection_request(&request).map_err(|_| "invalid_request")?;
    reply(
        env,
        handle,
        |c| Ok(Some(c.reconcile(&request))),
        wire::encode_catalog_selection,
    )
}
pub(super) fn catalog_target(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    max_tools: jlong,
) -> Result<jstring> {
    let request = intent_text(env, &request)?;
    let request = wire::decode_catalog_target_request(&request).map_err(|_| "invalid_request")?;
    let max_tools = index(max_tools)?;
    reply(
        env,
        handle,
        |c| {
            c.preflight_target(&request, max_tools)
                .map(Some)
                .map_err(|e| e.code())
        },
        wire::encode_catalog_preflight_target,
    )
}
