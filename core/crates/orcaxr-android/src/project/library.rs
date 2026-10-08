//! The preset library host exchange. Creating a library consumes a catalog
//! upload in place; the slot then holds the library. Operations and replies
//! are generated contract JSON; bundles and stored state cross as bytes.
use super::*;
use jni::objects::GlobalRef;
use orcaxr_contracts::{project_intent_types as wire, project_intents::InvalidIntent};
use orcaxr_project::settings::{
    catalog_exchange::CatalogUpload,
    library::LibraryHost,
    library_exchange::{self, ExchangeError, HostLibrary},
    presets::{AsciiRootCollation, Collation},
};
use std::cmp::Ordering;

/// A library with the host policies it was created with.
pub(super) struct Library {
    inner: HostLibrary,
    collator: Option<GlobalRef>,
    timestamps: Timestamps,
}
/// The policies of one call: the stored collator on this JNI thread (or the
/// exact ASCII root order) and the host's timestamp resolver.
struct Policies<'a, 'env> {
    env: &'a mut JNIEnv<'env>,
    collator: Option<&'a GlobalRef>,
    timestamps: &'a mut Timestamps,
}
impl LibraryHost for Policies<'_, '_> {
    type Error = &'static str;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering> {
        match self.collator {
            Some(collator) => JavaCollation {
                env: self.env,
                collator: collator.as_obj(),
            }
            .compare(left, right),
            None => AsciiRootCollation
                .compare(left, right)
                .map_err(|_| "non_ascii_collation"),
        }
    }
    fn now(&mut self) -> Vec<u16> {
        Vec::new()
    }
    fn timestamp(&mut self, text: &[u16]) -> Result<bool> {
        orcaxr_project::validation::TimestampPolicy::is_valid(self.timestamps, text)
    }
}
fn refused(e: ExchangeError<&'static str>) -> &'static str {
    match e {
        ExchangeError::Json(e) => json_code(e),
        ExchangeError::InvalidCatalog => "invalid_catalog",
        ExchangeError::InvalidRequest => "invalid_request",
        ExchangeError::OutputLimit => "output_limit",
        ExchangeError::Host(code) => code,
    }
}
fn encoded<T>(
    value: &T,
    encode: fn(&T) -> std::result::Result<String, InvalidIntent>,
) -> Result<String> {
    encode(value).map_err(|_| "output_limit")
}
/// Run `call` against the library with this thread's policies.
fn with_library<R>(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    call: impl FnOnce(&mut HostLibrary, &mut Policies<'_, '_>) -> Result<R>,
) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::Library(library)) => {
            let Library {
                inner,
                collator,
                timestamps,
            } = &mut **library;
            let mut policies = Policies {
                env,
                collator: collator.as_ref(),
                timestamps,
            };
            call(inner, &mut policies)
        }
        _ => Err("invalid_handle_kind"),
    })
}
fn take_catalog_upload(handle: jlong) -> Result<CatalogUpload> {
    let upload = registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::CatalogUpload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::CatalogUpload(upload)) = record.take() else {
            unreachable!()
        };
        Ok(*upload)
    })?;
    registry().close(handle)?;
    Ok(upload)
}
fn optional_bytes(env: &mut JNIEnv<'_>, bytes: &JByteArray<'_>) -> Result<Option<Vec<u8>>> {
    if bytes.is_null() {
        return Ok(None);
    }
    env.convert_byte_array(bytes)
        .map(Some)
        .map_err(|_| "invalid_input")
}
fn byte_array(env: &mut JNIEnv<'_>, bytes: &[u8]) -> Result<jbyteArray> {
    env.byte_array_from_slice(bytes)
        .map(|a| a.into_raw())
        .map_err(|_| "allocation_failed")
}

/// Consumes the catalog upload in place on success and failure. A null
/// collator uses the exact ASCII root collation.
pub(super) fn library_create(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    stored: JByteArray<'_>,
    limits: JDoubleArray<'_>,
    collator: JObject<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<()> {
    let limits = json_limits(env, &limits)?;
    let stored = optional_bytes(env, &stored)?;
    let mut timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let collator = if collator.is_null() {
        None
    } else {
        if !env
            .is_instance_of(&collator, "dev/orcaxr/core/PresetCollator")
            .map_err(|_| "collation_failed")?
        {
            return Err("collation_failed");
        }
        Some(
            env.new_global_ref(&collator)
                .map_err(|_| "collation_failed")?,
        )
    };
    registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::CatalogUpload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::CatalogUpload(upload)) = record.take() else {
            unreachable!()
        };
        let mut policies = Policies {
            env,
            collator: collator.as_ref(),
            timestamps: &mut timestamps,
        };
        let inner = HostLibrary::create(*upload, stored.as_deref(), limits, &mut policies)
            .map_err(refused)?;
        *record = Some(Record::Library(Box::new(Library {
            inner,
            collator,
            timestamps,
        })));
        Ok(())
    })
}
pub(super) fn library_apply(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    operation: JString<'_>,
) -> Result<jstring> {
    let operation = intent_text(env, &operation)?;
    let operation = wire::decode_library_operation(&operation).map_err(|_| "invalid_request")?;
    let json = with_library(env, handle, |l, p| {
        encoded(
            &l.apply(&operation, p).map_err(refused)?,
            wire::encode_library_outcome,
        )
    })?;
    string(env, json)
}
pub(super) fn library_import(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    bundle: JByteArray<'_>,
    limits: JDoubleArray<'_>,
) -> Result<jstring> {
    let limits = json_limits(env, &limits)?;
    let bundle = optional_bytes(env, &bundle)?.ok_or("invalid_input")?;
    let json = with_library(env, handle, |l, p| {
        encoded(
            &l.import(&bundle, limits, p).map_err(refused)?,
            wire::encode_library_outcome,
        )
    })?;
    string(env, json)
}
pub(super) fn library_issue_count(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_library(env, handle, |l, _| Ok(l.issue_count() as jlong))
}
pub(super) fn library_issue(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    let json = with_library(env, handle, |l, _| {
        encoded(
            &l.issue(position).ok_or("invalid_range")?,
            wire::encode_library_issue,
        )
    })?;
    string(env, json)
}
pub(super) fn library_export(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    exported_at: JString<'_>,
    max_bytes: jlong,
) -> Result<jbyteArray> {
    let at: Vec<u16> = intent_text(env, &exported_at)?.encode_utf16().collect();
    let max_bytes = index(max_bytes)?;
    let bytes = with_library(env, handle, |l, _| {
        l.export(&at, max_bytes).map_err(refused)
    })?;
    byte_array(env, &bytes)
}
pub(super) fn library_state(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    max_bytes: jlong,
) -> Result<jbyteArray> {
    let max_bytes = index(max_bytes)?;
    let bytes = with_library(env, handle, |l, _| l.state(max_bytes).map_err(refused))?;
    byte_array(env, &bytes)
}
pub(super) fn library_view(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_library(env, handle, |l, _| {
        encoded(&l.view(), wire::encode_library_view)
    })?;
    string(env, json)
}
pub(super) fn library_custom_preset(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    let json = with_library(env, handle, |l, _| {
        encoded(
            &l.custom_preset(position).ok_or("invalid_range")?,
            wire::encode_library_custom_preset,
        )
    })?;
    string(env, json)
}
pub(super) fn library_inventory(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_library(env, handle, |l, p| {
        encoded(
            &l.inventory(p).map_err(refused)?,
            wire::encode_library_inventory,
        )
    })?;
    string(env, json)
}
pub(super) fn library_bases(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = intent_text(env, &request)?;
    let request = wire::decode_library_base_request(&request).map_err(|_| "invalid_request")?;
    let json = with_library(env, handle, |l, _| {
        encoded(&l.bases(&request), wire::encode_library_bases)
    })?;
    string(env, json)
}
/// The composed catalog as a new profile catalog handle.
pub(super) fn library_catalog(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    let catalog = with_library(env, handle, |l, p| l.catalog(p).map_err(refused))?;
    reserved.insert(Record::Catalog(Box::new(catalog)))
}
/// Consumes the upload handle on every outcome.
pub(super) fn library_plan_update(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    upload: jlong,
) -> Result<jstring> {
    let upload = take_catalog_upload(upload)?;
    let json = with_library(env, handle, |l, p| {
        encoded(
            &l.plan_update(upload, p).map_err(refused)?,
            wire::encode_library_update_plan,
        )
    })?;
    string(env, json)
}
/// Consumes the upload handle on every outcome.
pub(super) fn library_apply_update(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    upload: jlong,
) -> Result<jstring> {
    let upload = take_catalog_upload(upload)?;
    let json = with_library(env, handle, |l, p| {
        encoded(
            &l.apply_update(upload, p).map_err(refused)?,
            wire::encode_library_outcome,
        )
    })?;
    string(env, json)
}
pub(super) fn library_coerce(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = intent_text(env, &request)?;
    let request = wire::decode_library_coerce_request(&request).map_err(|_| "invalid_request")?;
    let value = library_exchange::coerce(&request).map_err(refused)?;
    let json = encoded(&value, wire::encode_library_coerced_value)?;
    string(env, json)
}
pub(super) fn library_format(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = intent_text(env, &request)?;
    let request = wire::decode_library_format_request(&request).map_err(|_| "invalid_request")?;
    let value = library_exchange::format(&request).map_err(refused)?;
    let json = encoded(&value, wire::encode_library_formatted_value)?;
    string(env, json)
}
