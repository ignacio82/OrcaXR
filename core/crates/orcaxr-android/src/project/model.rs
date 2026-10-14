//! Model import tasks for the Kotlin actor: stage source bytes, capture the base
//! on the authority, prepare the browser's preview privately (the upload's slot
//! becomes the preview), then commit with the operator's acknowledgements as one
//! undoable `Import <filename>`. A refused confirmation keeps the candidate.
use super::{Record, Result, Timestamps, capture, index, option_values, range, registry};
use jni::{
    JNIEnv,
    objects::{JByteArray, JCharArray, JDoubleArray, JLongArray, JObject, JString},
    sys::{jboolean, jbyteArray, jint, jlong},
};
use orcaxr_archive::{
    models::{
        Limits,
        host::{self, Base, Ids, Request},
        layout::{self, decode_options},
        stage::Placement,
    },
    staged::ArchiveInput,
};
use orcaxr_contracts::canonical::{self, Value};
use orcaxr_project::{
    import::{ConfirmError, Prepared, check_confirmation},
    session::{ImportCommitError, LocalGuard},
};

pub(super) struct Upload {
    input: ArchiveInput,
    limits: Limits,
    timestamps: Timestamps,
}
pub(super) struct Preview {
    json: Vec<u8>,
    prepared: Option<Prepared>,
    guard: LocalGuard,
}
/// Filenames, timestamps and acknowledgement lists stay small.
const MAX_TEXT_UNITS: usize = 1 << 16;

pub(super) fn model_upload_new(
    env: &mut JNIEnv<'_>,
    version: jint,
    model_bytes: jlong,
    options: JDoubleArray<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jlong> {
    let limits = decode_options(
        f64::from(version),
        &option_values::<{ layout::OPTION_COUNT }>(env, &options)?,
    )
    .ok_or("invalid_options")?;
    let expected = match model_bytes {
        -1 => None,
        value => Some(index(value)?),
    };
    let reserved = registry().reserve(true)?;
    let timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let input = ArchiveInput::bounded(expected, limits.max_bytes)?;
    reserved.insert(Record::ModelUpload(Box::new(Upload {
        input,
        limits,
        timestamps,
    })))
}
pub(super) fn model_upload_append(
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
    super::with_model_upload(handle, |u| u.input.append(index(offset)?, &chunk))
}
pub(super) fn import_base(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| {
        super::with_session(handle, |s| {
            Base::capture(s)
                .map(|base| Record::ImportBase(Box::new(base)))
                .map_err(|_| "disposed")
        })
    })
}
pub(super) fn chars(env: &mut JNIEnv<'_>, array: &JCharArray<'_>) -> Result<Vec<u16>> {
    let length = env.get_array_length(array).map_err(|_| "invalid_input")?;
    if length < 0 || length as usize > MAX_TEXT_UNITS {
        return Err("input_limit");
    }
    let mut units = vec![0u16; length as usize];
    env.get_char_array_region(array, 0, &mut units)
        .map_err(|_| "invalid_input")?;
    Ok(units)
}
/// Consumes the upload on every outcome; its slot then holds the preview.
#[allow(clippy::too_many_arguments)]
fn unpack_and_prepare<F>(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    base: jlong,
    filename: JCharArray<'_>,
    imported_at: JCharArray<'_>,
    bed: JDoubleArray<'_>,
    drop_to_bed: jboolean,
    id_seed: JLongArray<'_>,
    id_namespace: JString<'_>,
    prepare_fn: F,
) -> Result<()>
where
    F: FnOnce(
        &[u8],
        &Request,
        &orcaxr_archive::models::Limits,
        &Base,
        &mut Timestamps,
        &mut dyn FnMut() -> bool,
    ) -> std::result::Result<orcaxr_project::import::Prepared, host::Failure>,
{
    let filename = chars(env, &filename)?;
    let imported_at = chars(env, &imported_at)?;
    // The printable area `[x_min, y_min, x_max, y_max]`, or none.
    let bed_area_mm = match env.get_array_length(&bed).map_err(|_| "invalid_options")? {
        0 => None,
        4 => {
            let mut values = [0.0; 4];
            env.get_double_array_region(&bed, 0, &mut values)
                .map_err(|_| "invalid_options")?;
            if !values.iter().all(|v| v.is_finite()) {
                return Err("invalid_options");
            }
            Some(values)
        }
        _ => return Err("invalid_options"),
    };
    let seed_length = env
        .get_array_length(&id_seed)
        .map_err(|_| "invalid_options")?;
    let ids = if id_namespace.is_null() {
        if seed_length != 4 {
            return Err("invalid_options");
        }
        let mut words = [0i64; 4];
        env.get_long_array_region(&id_seed, 0, &mut words)
            .map_err(|_| "invalid_options")?;
        Ids::Uuid(words.map(|w| w as u64))
    } else {
        if seed_length != 0 {
            return Err("invalid_options");
        }
        let namespace: String = env
            .get_string(&id_namespace)
            .map_err(|_| "invalid_options")?
            .into();
        if namespace.is_empty() || namespace.len() > 256 {
            return Err("invalid_options");
        }
        Ids::Counter(namespace)
    };
    let base = registry().slot(base)?.with(|record| match record {
        Some(Record::ImportBase(base)) => Ok(base.as_ref().clone()),
        _ => Err("invalid_handle_kind"),
    })?;
    let slot = registry().slot(handle)?;
    let mut cancelled = || slot.is_closed();
    slot.with(|record| {
        if !matches!(record, Some(Record::ModelUpload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::ModelUpload(upload)) = record.take() else {
            unreachable!()
        };
        let Upload {
            input,
            limits,
            mut timestamps,
        } = *upload;
        let bytes = input.finish()?;
        let request = Request {
            filename,
            imported_at,
            placement: Placement {
                bed_area_mm,
                drop_to_bed: drop_to_bed != 0,
            },
            ids,
        };
        let prepared = prepare_fn(&bytes, &request, &limits, &base, &mut timestamps, &mut cancelled)
            .map_err(failure_code)?;
        let mut json = Vec::new();
        prepared
            .preview
            .write_canonical(&mut json)
            .map_err(|_| "encoding")?;
        *record = Some(Record::ImportPreview(Box::new(Preview {
            json,
            prepared: Some(prepared),
            guard: base.guard,
        })));
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn import_prepare_model(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    base: jlong,
    filename: JCharArray<'_>,
    imported_at: JCharArray<'_>,
    bed: JDoubleArray<'_>,
    drop_to_bed: jboolean,
    id_seed: JLongArray<'_>,
    id_namespace: JString<'_>,
) -> Result<()> {
    unpack_and_prepare(
        env,
        handle,
        base,
        filename,
        imported_at,
        bed,
        drop_to_bed,
        id_seed,
        id_namespace,
        |bytes, req, limits, base, timestamps, cancelled| {
            host::prepare(bytes, req, limits, base, timestamps, cancelled)
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn import_prepare_geometry(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    base: jlong,
    filename: JCharArray<'_>,
    imported_at: JCharArray<'_>,
    bed: JDoubleArray<'_>,
    drop_to_bed: jboolean,
    id_seed: JLongArray<'_>,
    id_namespace: JString<'_>,
) -> Result<()> {
    unpack_and_prepare(
        env,
        handle,
        base,
        filename,
        imported_at,
        bed,
        drop_to_bed,
        id_seed,
        id_namespace,
        |bytes, req, limits, base, timestamps, cancelled| {
            host::prepare_geometry(bytes, req, limits, base, timestamps, cancelled)
        },
    )
}
/// Bounded static codes for the JNI exception message.
fn failure_code(failure: host::Failure) -> &'static str {
    use orcaxr_archive::models::{Malformed, Unsupported};
    match failure {
        host::Failure::Unsupported(reason) => match reason {
            Unsupported::EmptyInput => "unsupported-format:empty-input",
            Unsupported::UnknownSignature => "unsupported-format:unknown-signature",
            Unsupported::ExtensionSignatureMismatch => {
                "unsupported-format:extension-signature-mismatch"
            }
            Unsupported::RequiresProjectImport => "unsupported-format:requires-project-import",
            Unsupported::RequiresNativeKernel => "unsupported-format:requires-native-kernel",
            Unsupported::RequiresEmbossWorkflow => "unsupported-format:requires-emboss-workflow",
            Unsupported::NotAModelFormat => "unsupported-format:not-a-model-format",
        },
        host::Failure::Malformed(reason) => match reason {
            Malformed::Truncated => "malformed-model:truncated",
            Malformed::InvalidSyntax => "malformed-model:invalid-syntax",
            Malformed::InvalidGeometry => "malformed-model:invalid-geometry",
            Malformed::NoGeometry => "malformed-model:no-geometry",
            Malformed::LimitExceeded => "malformed-model:limit-exceeded",
            Malformed::UnsafeArchive => "malformed-model:unsafe-archive",
        },
        host::Failure::Encoding => "unencodable-mesh",
        host::Failure::State => "invalid-import-state",
        host::Failure::Timestamp => "timestamp_service",
        host::Failure::Cancelled => "cancelled",
    }
}
pub(super) fn import_preview_length(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    super::with_import_preview(handle, |p| Ok(p.json.len() as jlong))
}
pub(super) fn import_preview_read(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let bytes = super::with_import_preview(handle, |p| {
        Ok(p.json[range(start, count, p.json.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    })?;
    env.byte_array_from_slice(&bytes)
        .map(|b| b.into_raw())
        .map_err(|_| "allocation_failed")
}
pub(super) fn import_preview_blocked(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jboolean> {
    super::with_import_preview(handle, |p| {
        Ok(p.prepared
            .as_ref()
            .ok_or("invalid_state")?
            .is_blocked()
            .into())
    })
}
fn acknowledgements(env: &mut JNIEnv<'_>, text: &JString<'_>) -> Result<Vec<Vec<u16>>> {
    let length = env
        .call_method(text, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|_| "invalid_request")?;
    if length < 0 || length as usize > MAX_TEXT_UNITS {
        return Err("input_limit");
    }
    let json: String = env.get_string(text).map_err(|_| "invalid_request")?.into();
    match canonical::parse(&json).map_err(|_| "invalid_request")? {
        Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Value::String(units) => Ok(units),
                _ => Err("invalid_request"),
            })
            .collect(),
        _ => Err("invalid_request"),
    }
}
/// Dispatch the returned effects before reporting success.
pub(super) fn commit_import(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    preview: jlong,
    acknowledged: JString<'_>,
) -> Result<jlong> {
    let acknowledged = acknowledgements(env, &acknowledged)?;
    let reserved = registry().reserve(false)?;
    let confirmation = |e: ConfirmError| match e {
        ConfirmError::Blocked => "import_blocked",
        ConfirmError::Missing(_) => "missing_acknowledgements",
        ConfirmError::Stale => "stale",
    };
    let (guard, prepared) = registry().slot(preview)?.with(|record| {
        let Some(Record::ImportPreview(preview)) = record else {
            return Err("invalid_handle_kind");
        };
        let prepared = preview.prepared.as_ref().ok_or("invalid_state")?;
        let current = super::with_session(handle, |s| Ok(s.is_export_current(&preview.guard)))?;
        check_confirmation(prepared, &acknowledged, current).map_err(confirmation)?;
        Ok((
            preview.guard.clone(),
            preview.prepared.take().ok_or("invalid_state")?,
        ))
    })?;
    let outcome = super::with_session(handle, |s| {
        s.commit_import(&guard, prepared, &acknowledged)
            .map_err(|e| match e {
                ImportCommitError::Disposed => "disposed",
                ImportCommitError::Confirmation(e) => confirmation(e),
            })
    })?;
    match outcome.result {
        Ok(_) => reserved.insert(Record::Effects(outcome.events)),
        Err(_) => Err("import_failed"),
    }
}
