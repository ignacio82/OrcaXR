//! Archive Open and Save tasks for the Kotlin actor. Open stages exact archive
//! bytes; `prepare` completes canonical or foreign import privately and leaves a
//! prepared document that only the session's guarded `finish_open` or
//! `reset_document` may adopt. Save packages an immutable export capture, so no
//! session gate is held while writing; only a confirmed host handoff may
//! acknowledge the capture's guard. Closing the working handle cancels either.
use super::{Record, Result, Timestamps, index, option_values, range, registry, text, text_slice};
use jni::{
    JNIEnv,
    objects::{JByteArray, JDoubleArray, JObject},
    sys::{jbyteArray, jcharArray, jint, jlong},
};
use orcaxr_archive::{
    Archive,
    archive_layout::{self as layout, decode_options},
    open, package,
    policy::{Policy, archive_code, open_code, save_code},
    text as messages,
};
use orcaxr_project::session::PreparedDocument;
use std::io::Cursor;

pub(super) struct Upload {
    bytes: Vec<u8>,
    expected: usize,
    policy: Policy,
    timestamps: Timestamps,
}
pub(super) struct Import {
    document: PreparedDocument,
    format: u32,
    warnings: Vec<Vec<u16>>,
}
pub(super) struct Output {
    bytes: Vec<u8>,
    warnings: Vec<Vec<u16>>,
}

fn policy(env: &mut JNIEnv<'_>, version: jint, options: &JDoubleArray<'_>) -> Result<Policy> {
    decode_options(
        version as f64,
        &option_values::<{ layout::OPTION_COUNT }>(env, options)?,
    )
    .map(Policy::new)
    .ok_or("invalid_options")
}

/// Reserves exactly `archive_bytes` after checking it against the policy. Each
/// upload counts against the bounded concurrent-document budget.
pub(super) fn archive_upload_new(
    env: &mut JNIEnv<'_>,
    version: jint,
    archive_bytes: jlong,
    options: JDoubleArray<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jlong> {
    let policy = policy(env, version, &options)?;
    let expected = index(archive_bytes)?;
    if expected == 0 || expected > policy.options().archive_bytes {
        return Err("input_limit");
    }
    let reserved = registry().reserve(true)?;
    let timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(expected)
        .map_err(|_| "input_limit")?;
    reserved.insert(Record::ArchiveUpload(Box::new(Upload {
        bytes,
        expected,
        policy,
        timestamps,
    })))
}
/// Offsets make retries and out-of-order delivery explicit; a refused chunk is
/// not consumed.
pub(super) fn archive_upload_append(
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
    super::with_archive_upload(handle, |u| {
        if index(offset)? != u.bytes.len() || chunk.len() > u.expected - u.bytes.len() {
            return Err("invalid_archive_input");
        }
        u.bytes.extend_from_slice(&chunk);
        Ok(())
    })
}
/// Consumes the upload on every outcome. Synchronous: run it on an owned import
/// task. No session state changes until the host adopts the document.
pub(super) fn archive_upload_prepare(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    let slot = registry().slot(handle)?;
    let cancelled = || slot.is_closed();
    slot.with(|record| {
        if !matches!(record, Some(Record::ArchiveUpload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::ArchiveUpload(upload)) = record.take() else {
            unreachable!()
        };
        let Upload {
            bytes,
            expected,
            policy,
            mut timestamps,
        } = *upload;
        if bytes.len() != expected {
            return Err("incomplete_archive");
        }
        let archive =
            Archive::open(Cursor::new(bytes), policy.zip(), cancelled).map_err(archive_code)?;
        let format = match open::format(&archive) {
            open::Format::Canonical => layout::FORMAT_CANONICAL,
            open::Format::Foreign => layout::FORMAT_FOREIGN,
        };
        let completed = open::open(archive, policy.open(), &mut timestamps, cancelled)
            .map_err(|e| open_code(&e))?;
        let warnings = messages::import_warnings(completed.project().state(), completed.warnings());
        let (document, _) = completed.into_prepared().map_err(|_| "invalid_bundle")?;
        *record = Some(Record::ArchiveImport(Box::new(Import {
            document,
            format,
            warnings,
        })));
        Ok(())
    })
}
pub(super) fn archive_format(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jint> {
    super::with_archive_import(handle, |i| Ok(i.format as jint))
}
/// Read the format and warnings first: this consumes the import in its own
/// slot, which then holds the prepared document for guarded adoption.
pub(super) fn archive_document(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::ArchiveImport(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::ArchiveImport(import)) = record.take() else {
            unreachable!()
        };
        *record = Some(Record::Document(import.document));
        Ok(())
    })
}
/// Package the export capture's frozen project and assets. The output slot is
/// reserved first, so capacity refusal never discards a finished package.
pub(super) fn export_archive(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    version: jint,
    options: JDoubleArray<'_>,
) -> Result<jlong> {
    let policy = policy(env, version, &options)?;
    let slot = registry().slot(handle)?;
    let (project, assets) = slot.with(|record| match record {
        Some(Record::Export(e)) => Ok((
            e.project().clone(),
            (0..e.asset_count())
                .map(|i| e.asset(i))
                .collect::<Option<Vec<_>>>()
                .ok_or("missing_asset")?,
        )),
        _ => Err("invalid_handle_kind"),
    })?;
    let reserved = registry().reserve(true)?;
    let mut output = Cursor::new(Vec::new());
    let warnings = {
        let receipt = package::write(
            project.project(),
            assets,
            &mut output,
            policy.package(),
            || slot.is_closed(),
        )
        .map_err(save_code)?;
        messages::package_warnings(project.state(), &receipt.warnings)
    };
    reserved.insert(Record::ArchiveOutput(Box::new(Output {
        bytes: output.into_inner(),
        warnings,
    })))
}
pub(super) fn archive_length(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    super::with_archive_output(handle, |o| Ok(o.bytes.len() as jlong))
}
/// Copies one bounded chunk into host-owned memory.
pub(super) fn archive_read(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let bytes = super::with_archive_output(handle, |o| {
        Ok(o.bytes[range(start, count, o.bytes.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    })?;
    env.byte_array_from_slice(&bytes)
        .map(|b| b.into_raw())
        .map_err(|_| "allocation_failed")
}
fn warnings<R>(handle: jlong, call: impl FnOnce(&[Vec<u16>]) -> Result<R>) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::ArchiveImport(i)) => call(&i.warnings),
        Some(Record::ArchiveOutput(o)) => call(&o.warnings),
        _ => Err("invalid_handle_kind"),
    })
}
fn warning(all: &[Vec<u16>], position: jlong) -> Result<&[u16]> {
    all.get(index(position)?)
        .map(Vec::as_slice)
        .ok_or("invalid_range")
}
pub(super) fn archive_warning_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    warnings(handle, |w| Ok(w.len() as jlong))
}
pub(super) fn archive_warning_length(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jlong> {
    warnings(handle, |w| Ok(warning(w, position)?.len() as jlong))
}
/// Bounded UTF-16 reads; lone surrogates survive.
pub(super) fn archive_warning(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
    start: jlong,
    count: jlong,
) -> Result<jcharArray> {
    text(
        env,
        &warnings(handle, |w| text_slice(warning(w, position)?, start, count))?,
    )
}
