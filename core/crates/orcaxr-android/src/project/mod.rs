//! Typed JNI owners for project sessions and immutable captures. Handle capacity
//! is reserved before mutations. No native pointer or borrowed buffer escapes.
macro_rules! export {
    ($name:ident, $handler:ident, $result:ty, $($arg:ident: $kind:ty,)*) => {
        #[unsafe(no_mangle)]
        pub extern "system" fn $name<'local>(
            mut env: JNIEnv<'local>,
            _: JClass<'local>,
            $($arg: $kind,)*
        ) -> $result {
            boundary(&mut env, |env| super::$handler(env, $($arg),*))
        }
    };
}
mod archive;
mod bindings;
mod catalog;
mod editor;
mod exports;
mod filaments;
mod fresh;
mod json_sink;
mod library;
mod model;
mod outputs;
mod painting;
mod placement;
mod plate;
mod preflight;
mod printer;
mod registry;
mod slicing;
mod timestamps;
use archive::*;
use catalog::*;
use editor::*;
use exports::*;
use filaments::*;
use fresh::*;
use jni::{
    JNIEnv,
    objects::{JByteArray, JCharArray, JClass, JDoubleArray, JLongArray, JObject, JString},
    sys::{jboolean, jbyteArray, jcharArray, jdouble, jdoubleArray, jint, jlong, jstring},
};
use library::*;
use model::*;
use orcaxr_project::{
    assets::AssetLease,
    clipboard::{ClipboardCapture, ClipboardPreparation},
    export::ExportCapture,
    history::{DomainEvent, HistoryOptions, HistorySnapshot},
    host_layout as layout,
    ids::*,
    ingress::{
        ProjectBundleInput, ProjectInput, ProjectInputLimits, command_work::CommandUpload,
        json::JsonLimits,
    },
    model::{Encode, Text},
    query::{self, QueryList, QueryNode},
    selection::{SelectionRef, SelectionSnapshot, SelectionStore},
    session::{
        DocumentOpen, LocalGuard, PreparedDocument, ProjectSession, Response, StagingLimits,
        Submission,
    },
    staging_layout as staging,
    store::ProjectSnapshot,
};
use outputs::*;
use painting::*;
use placement::*;
use plate::*;
use preflight::*;
use printer::*;
use registry::Registry;
use slicing::*;
use std::{
    io::{self, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::OnceLock,
};
use timestamps::Timestamps;
type Result<T> = std::result::Result<T, &'static str>;
type Session = ProjectSession<Timestamps>;

struct Upload {
    document: Option<ProjectInput>,
    bundle: Option<ProjectBundleInput>,
    options: layout::HostOptions,
    timestamps: Option<Timestamps>,
}
#[derive(Default)]
struct SelectionInput {
    refs: Vec<SelectionRef>,
    units: usize,
}
enum Record {
    Upload(Box<Upload>),
    Session(Box<Session>),
    Project(ProjectSnapshot),
    Selection(SelectionSnapshot),
    History(HistorySnapshot),
    Asset(AssetLease),
    Guard(LocalGuard),
    Reply(Response),
    Effects(Vec<DomainEvent>),
    Bytes(Vec<u8>),
    SelectionInput(SelectionInput),
    QueryNode(QueryNode),
    QueryList(QueryList),
    CommandUpload(Box<CommandUpload>),
    Clipboard(ClipboardCapture),
    ClipboardPreparation(ClipboardPreparation),
    Export(ExportCapture),
    Document(PreparedDocument),
    Open(DocumentOpen),
    ArchiveUpload(Box<archive::Upload>),
    ArchiveImport(Box<archive::Import>),
    ArchiveOutput(Box<archive::Output>),
    ModelUpload(Box<model::Upload>),
    ImportBase(Box<orcaxr_archive::models::host::Base>),
    ImportPreview(Box<model::Preview>),
    Preflight(Box<Report>),
    CatalogUpload(Box<orcaxr_project::settings::catalog_exchange::CatalogUpload>),
    Catalog(Box<orcaxr_project::settings::catalog_exchange::HostCatalog>),
    Library(Box<library::Library>),
    Editor(Box<editor::Editor>),
    PaintStroke(Box<orcaxr_project::facets::paint_stroke::PaintStroke>),
    VolumeSplit(Box<orcaxr_project::split::VolumeSplit>),
    VolumeSimplify(Box<orcaxr_project::simplify::VolumeSimplify>),
    MeasureVolume(Box<orcaxr_project::measure::MeasureVolume>),
    MeshPacket(Box<orcaxr_project::mesh_packet::MeshPacket>),
    Emboss(Box<orcaxr_project::emboss::PreparedEmboss>),
    EmbossFont(Box<orcaxr_project::emboss::font::ReadFont>),
    SvgPart(Box<orcaxr_project::svg::PreparedSvgPart>),
    PaintOverlay(Box<orcaxr_project::facets::overlay::Overlay>),
    PaintFacets(Box<orcaxr_project::facets::paint_facets::PaintFacets>),
    PickScene(Box<orcaxr_project::picking::PickScene>),
    PrintJobStatus(Box<orcaxr_printer::status::JobStatus>),
    HoldToConfirm(Box<orcaxr_printer::control::HoldToConfirm>),
    ToolUsage(Box<orcaxr_printer::tools::ToolUsageScanner>),
    PrintWorkflow(Box<orcaxr_printer::workflow::PrintWorkflow>),
    PrinterSession(Box<orcaxr_printer::session::PrinterSession>),
    MoonrakerTransport(Box<orcaxr_printer::transport::MoonrakerTransport>),
}
fn registry() -> &'static Registry<Record> {
    static REGISTRY: OnceLock<Registry<Record>> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry::new(4096, 4))
}
fn boundary<T: Default>(
    env: &mut JNIEnv<'_>,
    call: impl FnOnce(&mut JNIEnv<'_>) -> Result<T>,
) -> T {
    match catch_unwind(AssertUnwindSafe(|| call(env))) {
        Ok(Ok(value)) => value,
        result => {
            let code = if let Ok(Err(code)) = result {
                code
            } else {
                "core_failure"
            };
            let _ = env.exception_clear();
            let _ = env.throw_new("java/lang/IllegalStateException", code);
            T::default()
        }
    }
}
macro_rules! access {
    ($name:ident, $variant:ident, $type:ty) => {
        fn $name<R>(handle: i64, call: impl FnOnce(&mut $type) -> Result<R>) -> Result<R> {
            registry().slot(handle)?.with(|value| match value {
                Some(Record::$variant(value)) => call(value),
                _ => Err("invalid_handle_kind"),
            })
        }
    };
}
access!(with_upload, Upload, Box<Upload>);
access!(with_session, Session, Box<Session>);
access!(with_project, Project, ProjectSnapshot);
access!(with_export, Export, ExportCapture);
access!(with_preflight, Preflight, Box<Report>);
access!(
    with_catalog_upload,
    CatalogUpload,
    Box<orcaxr_project::settings::catalog_exchange::CatalogUpload>
);
access!(
    with_catalog,
    Catalog,
    Box<orcaxr_project::settings::catalog_exchange::HostCatalog>
);
access!(with_selection, Selection, SelectionSnapshot);
access!(with_history, History, HistorySnapshot);
access!(with_asset, Asset, AssetLease);
access!(with_guard, Guard, LocalGuard);
access!(with_reply, Reply, Response);
access!(with_effects, Effects, Vec<DomainEvent>);
access!(with_bytes, Bytes, Vec<u8>);
access!(with_selection_input, SelectionInput, SelectionInput);
access!(with_query_node, QueryNode, QueryNode);
access!(with_query_list, QueryList, QueryList);
access!(with_command_upload, CommandUpload, Box<CommandUpload>);
access!(with_clipboard, Clipboard, ClipboardCapture);
access!(with_open, Open, DocumentOpen);
access!(with_archive_upload, ArchiveUpload, Box<archive::Upload>);
access!(with_archive_import, ArchiveImport, Box<archive::Import>);
access!(with_archive_output, ArchiveOutput, Box<archive::Output>);
access!(with_model_upload, ModelUpload, Box<model::Upload>);
access!(with_import_preview, ImportPreview, Box<model::Preview>);
access!(
    with_pick_scene,
    PickScene,
    Box<orcaxr_project::picking::PickScene>
);
access!(
    with_paint_overlay,
    PaintOverlay,
    Box<orcaxr_project::facets::overlay::Overlay>
);
access!(
    with_paint_facets,
    PaintFacets,
    Box<orcaxr_project::facets::paint_facets::PaintFacets>
);
access!(
    with_paint_stroke,
    PaintStroke,
    Box<orcaxr_project::facets::paint_stroke::PaintStroke>
);
access!(
    with_volume_split,
    VolumeSplit,
    Box<orcaxr_project::split::VolumeSplit>
);
access!(
    with_volume_simplify,
    VolumeSimplify,
    Box<orcaxr_project::simplify::VolumeSimplify>
);
access!(
    with_measure_volume,
    MeasureVolume,
    Box<orcaxr_project::measure::MeasureVolume>
);
access!(
    with_mesh_packet,
    MeshPacket,
    Box<orcaxr_project::mesh_packet::MeshPacket>
);
access!(
    with_emboss,
    Emboss,
    Box<orcaxr_project::emboss::PreparedEmboss>
);
access!(
    with_svg_part,
    SvgPart,
    Box<orcaxr_project::svg::PreparedSvgPart>
);
access!(
    with_emboss_font,
    EmbossFont,
    Box<orcaxr_project::emboss::font::ReadFont>
);
fn option_values<const N: usize>(
    env: &mut JNIEnv<'_>,
    values: &JDoubleArray<'_>,
) -> Result<[f64; N]> {
    if env
        .get_array_length(values)
        .map_err(|_| "invalid_options")?
        != N as i32
    {
        return Err("invalid_options");
    }
    let mut result = [0.; N];
    env.get_double_array_region(values, 0, &mut result)
        .map_err(|_| "invalid_options")?;
    Ok(result)
}
fn configure_staging(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    version: jint,
    options: JDoubleArray<'_>,
) -> Result<()> {
    let options = staging::decode_pool(version as f64, &option_values::<4>(env, &options)?)
        .ok_or("invalid_options")?;
    with_session(handle, |s| {
        s.configure_staging(StagingLimits {
            max_resources: options.resources,
            max_commands: options.commands,
            max_units: options.input_units as u64,
            max_asset_bytes: options.asset_bytes as u64,
        })
        .map_err(|e| match e {
            orcaxr_contracts::project_intent_types::SessionError::Busy => "busy",
            orcaxr_contracts::project_intent_types::SessionError::Disposed => "disposed",
            _ => "invalid_options",
        })
    })
}
fn staging_usage(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jdoubleArray> {
    let v = with_session(handle, |s| Ok(s.staging_usage()))?;
    doubles(
        env,
        &[
            v.resources as f64,
            v.commands as f64,
            v.units as f64,
            v.asset_bytes as f64,
        ],
    )
}
fn command_upload_new(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    version: jint,
    bytes: jlong,
    options: JDoubleArray<'_>,
) -> Result<jlong> {
    let options = staging::decode_input(version as f64, &option_values::<9>(env, &options)?)
        .ok_or("invalid_options")?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    let bytes = index(bytes)?;
    capture(|| {
        with_session(handle, |s| {
            if !s.is_current(&guard) {
                return Err("stale");
            }
            CommandUpload::new(guard, bytes, options)
                .map(|u| Record::CommandUpload(Box::new(u)))
                .map_err(|e| e.code())
        })
    })
}
fn command_upload_append(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    offset: jlong,
    bytes: JByteArray<'_>,
) -> Result<()> {
    let bytes = input_bytes(env, &bytes)?;
    with_command_upload(handle, |u| {
        u.append(index(offset)?, &bytes).map_err(|e| e.code())
    })
}
fn capture_clipboard(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    node: jlong,
    version: jint,
    options: JDoubleArray<'_>,
) -> Result<jlong> {
    let options = staging::decode_clipboard(version as f64, &option_values::<2>(env, &options)?)
        .ok_or("invalid_options")?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    let node = with_query_node(node, |n| Ok(n.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            ClipboardCapture::from_query(s, &guard, &node, options)
                .map(Record::Clipboard)
                .map_err(|e| e.code())
        })
    })
}
fn clipboard_input_new(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    version: jint,
    options: JDoubleArray<'_>,
) -> Result<jlong> {
    let options = staging::decode_clipboard(version as f64, &option_values::<2>(env, &options)?)
        .ok_or("invalid_options")?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            ClipboardPreparation::new(s, &guard, options)
                .map(Record::ClipboardPreparation)
                .map_err(|e| e.code())
        })
    })
}
fn clipboard_input_capture(_: &mut JNIEnv<'_>, handle: jlong, node: jlong) -> Result<()> {
    let node = with_query_node(node, |n| Ok(n.clone()))?;
    registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::ClipboardPreparation(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::ClipboardPreparation(input)) = record.take() else {
            unreachable!()
        };
        *record = Some(Record::Clipboard(
            input.capture(&node).map_err(|e| e.code())?,
        ));
        Ok(())
    })
}
fn clipboard_info(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jdoubleArray> {
    let info = with_clipboard(handle, |c| Ok(c.info()))?;
    doubles(env, &info)
}
fn clipboard_upload_new(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    clipboard: jlong,
    version: jint,
    bytes: jlong,
    options: JDoubleArray<'_>,
) -> Result<jlong> {
    let options = staging::decode_input(version as f64, &option_values::<9>(env, &options)?)
        .ok_or("invalid_options")?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    let clipboard = with_clipboard(clipboard, |c| Ok(c.data()))?;
    let bytes = index(bytes)?;
    capture(|| {
        with_session(handle, |s| {
            CommandUpload::new_clipboard(s, guard, clipboard, bytes, options)
                .map(|u| Record::CommandUpload(Box::new(u)))
                .map_err(|e| e.code())
        })
    })
}
fn command_upload_seal(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_command_upload(handle, |u| u.seal().map_err(|e| e.code()))
}
fn command_upload_units(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_command_upload(handle, |u| {
        u.units().map(|n| n as i64).map_err(|e| e.code())
    })
}
fn command_upload_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_command_upload(handle, |u| {
        u.command_count().map(|n| n as i64).map_err(|e| e.code())
    })
}
fn command_upload_asset_bytes(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_command_upload(handle, |u| {
        u.asset_bytes().map(|n| n as i64).map_err(|e| e.code())
    })
}
fn command_upload_asset_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_command_upload(handle, |u| {
        u.asset_count().map(|n| n as i64).map_err(|e| e.code())
    })
}
fn command_upload_begin_asset(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    let position = index(position)?;
    with_command_upload(handle, |u| {
        u.begin_asset(position)
            .map(|n| n as i64)
            .map_err(|e| e.code())
    })
}
fn command_upload_append_asset(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    offset: jlong,
    bytes: JByteArray<'_>,
) -> Result<()> {
    let bytes = input_bytes(env, &bytes)?;
    let offset = index(offset)?;
    with_command_upload(handle, |u| {
        u.append_asset(offset, &bytes).map_err(|e| e.code())
    })
}
fn command_upload_finish_asset(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_command_upload(handle, |u| u.finish_asset().map_err(|e| e.code()))
}
fn command_upload_cancel_asset(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_command_upload(handle, |u| {
        u.cancel_asset();
        Ok(())
    })
}
fn stage_commands(_: &mut JNIEnv<'_>, handle: jlong, input: jlong) -> Result<jlong> {
    let upload = registry().slot(input)?.with(|value| {
        if !matches!(value, Some(Record::CommandUpload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::CommandUpload(input)) = value.take() else {
            unreachable!()
        };
        Ok(input)
    })?;
    registry().close(input)?;
    with_session(handle, |s| {
        upload.admit(s).map(|id| id as i64).map_err(|e| e.code())
    })
}
fn release_staged(_: &mut JNIEnv<'_>, handle: jlong, id: jlong) -> Result<jboolean> {
    if !(1..=orcaxr_project::store::MAX_REVISION as i64).contains(&id) {
        return Err("invalid_range");
    }
    with_session(handle, |s| Ok(s.release_staged(id as u64).into()))
}
fn capture(make: impl FnOnce() -> Result<Record>) -> Result<i64> {
    let reserved = registry().reserve(false)?;
    reserved.insert(make()?)
}
fn query_root(_: &mut JNIEnv<'_>, handle: jlong, version: jint) -> Result<jlong> {
    if version != query::layout::VERSION as i32 {
        return Err("unsupported_version");
    }
    capture(|| with_project(handle, |v| Ok(Record::QueryNode(QueryNode::new(v.clone())))))
}
fn query_project(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| {
        registry().slot(handle)?.with(|v| {
            Ok(Record::Project(match v {
                Some(Record::QueryNode(v)) => v.snapshot(),
                Some(Record::QueryList(v)) => v.snapshot(),
                _ => return Err("invalid_handle_kind"),
            }))
        })
    })
}
fn doubles(env: &mut JNIEnv<'_>, values: &[f64]) -> Result<jdoubleArray> {
    if values.len() > layout::MAX_CHUNK_BYTES / 8 {
        return Err("output_limit");
    }
    let output = env
        .new_double_array(values.len() as i32)
        .map_err(|_| "allocation_failed")?;
    env.set_double_array_region(&output, 0, values)
        .map_err(|_| "allocation_failed")?;
    Ok(output.into_raw())
}
fn query_metadata(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jdoubleArray> {
    doubles(env, &with_query_node(handle, |v| v.metadata())?)
}
fn query_text_length(_: &mut JNIEnv<'_>, handle: jlong, field: jint) -> Result<jlong> {
    let field = query::layout::TextField::from_index(field as u32).ok_or("invalid_field")?;
    with_query_node(handle, |v| {
        Ok(v.text(field)?.map_or(-1, |v| v.len() as i64))
    })
}
fn query_text(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    field: jint,
    start: jlong,
    count: jlong,
) -> Result<jcharArray> {
    let field = query::layout::TextField::from_index(field as u32).ok_or("invalid_field")?;
    text(
        env,
        &with_query_node(handle, |v| v.read_text(field, index(start)?, index(count)?))?,
    )
}
fn query_children(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    relation: jint,
    max_sort_entries: jlong,
) -> Result<jlong> {
    let relation =
        query::layout::Relation::from_index(relation as u32).ok_or("invalid_relation")?;
    capture(|| {
        with_query_node(handle, |v| {
            Ok(Record::QueryList(
                v.children(relation, index(max_sort_entries)?)?,
            ))
        })
    })
}
fn query_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_query_list(handle, |v| Ok(v.len() as i64))
}
fn query_node(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    capture(|| with_query_list(handle, |v| Ok(Record::QueryNode(v.node(index(position)?)?))))
}
fn query_page(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jdoubleArray> {
    doubles(
        env,
        &with_query_list(handle, |v| v.page(index(start)?, index(count)?))?,
    )
}
fn index(value: i64) -> Result<usize> {
    if !(0..=layout::MAX_BUDGET as i64).contains(&value) {
        return Err("invalid_range");
    }
    Ok(value as usize)
}
fn range(start: i64, count: i64, length: usize, maximum: usize) -> Result<std::ops::Range<usize>> {
    let start = index(start)?;
    let count = index(count)?;
    if start > length || count > maximum || count > length - start {
        return Err("invalid_range");
    }
    Ok(start..start + count)
}
fn string(env: &mut JNIEnv<'_>, value: String) -> Result<jstring> {
    env.new_string(value)
        .map(|v| v.into_raw())
        .map_err(|_| "allocation_failed")
}
fn text(env: &mut JNIEnv<'_>, units: &[u16]) -> Result<jcharArray> {
    let result = env
        .new_char_array(units.len() as i32)
        .map_err(|_| "allocation_failed")?;
    env.set_char_array_region(&result, 0, units)
        .map_err(|_| "allocation_failed")?;
    Ok(result.into_raw())
}
fn text_slice(value: &[u16], start: i64, count: i64) -> Result<Vec<u16>> {
    Ok(value[range(start, count, value.len(), layout::MAX_TEXT_CHUNK_UNITS)?].to_vec())
}
fn input_bytes(env: &mut JNIEnv<'_>, value: &JByteArray<'_>) -> Result<Vec<u8>> {
    let length = env.get_array_length(value).map_err(|_| "invalid_input")?;
    if length < 0 || length as usize > layout::MAX_CHUNK_BYTES {
        return Err("input_limit");
    }
    env.convert_byte_array(value).map_err(|_| "invalid_input")
}
fn upload_new(
    env: &mut JNIEnv<'_>,
    version: jint,
    document_bytes: jlong,
    options: JDoubleArray<'_>,
    resolver: JObject<'_>,
    integer_mode: jint,
) -> Result<jlong> {
    if env
        .get_array_length(&options)
        .map_err(|_| "invalid_options")?
        != 10
    {
        return Err("invalid_options");
    }
    let mut values = [0.; 10];
    env.get_double_array_region(&options, 0, &mut values)
        .map_err(|_| "invalid_options")?;
    let options = layout::decode_options(version as f64, &values).ok_or("invalid_options")?;
    let reserved = registry().reserve(true)?;
    let timestamps = Timestamps::new(env, resolver, integer_mode)?;
    let document = ProjectInput::new(
        index(document_bytes)?,
        ProjectInputLimits {
            document: JsonLimits {
                max_bytes: options.document_bytes,
                max_nodes: options.document_nodes,
                max_text_units: options.document_text_units,
                max_number_bytes: options.number_bytes,
                max_depth: options.depth,
            },
            max_assets: options.assets,
            max_asset_bytes: options.asset_bytes,
            max_total_asset_bytes: options.total_asset_bytes,
        },
    )
    .map_err(|_| "input_limit")?;
    reserved.insert(Record::Upload(Box::new(Upload {
        document: Some(document),
        bundle: None,
        options,
        timestamps: Some(timestamps),
    })))
}
fn upload_append_document(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    offset: jlong,
    bytes: JByteArray<'_>,
) -> Result<()> {
    let bytes = input_bytes(env, &bytes)?;
    with_upload(handle, |u| {
        u.document
            .as_mut()
            .ok_or("invalid_state")?
            .append(index(offset)?, &bytes)
            .map_err(|_| "invalid_document_input")
    })
}
fn upload_seal_document(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_upload(handle, |u| {
        let input = u.document.take().ok_or("invalid_state")?;
        u.bundle = Some(
            input
                .finish(u.timestamps.as_mut().ok_or("invalid_state")?)
                .map_err(|e| match e {
                    orcaxr_project::ingress::DocumentError::Admission(
                        orcaxr_project::validation::AdmissionError::Timestamp(_),
                    ) => "timestamp_service",
                    orcaxr_project::ingress::DocumentError::AssetBudget => "input_limit",
                    _ => "invalid_document",
                })?,
        );
        Ok(())
    })
}
fn upload_asset_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_upload(handle, |u| {
        Ok(u.bundle
            .as_ref()
            .ok_or("invalid_state")?
            .project()
            .state()
            .source_assets
            .len() as i64)
    })
}
fn upload_begin_asset(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    with_upload(handle, |u| {
        let bundle = u.bundle.as_mut().ok_or("invalid_state")?;
        let id = bundle
            .project()
            .state()
            .source_assets
            .get(index(position)?)
            .ok_or("invalid_range")?
            .id
            .clone();
        bundle
            .begin_asset(&id)
            .map(|v| v as i64)
            .map_err(|_| "invalid_asset_input")
    })
}
fn upload_append_asset(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    offset: jlong,
    bytes: JByteArray<'_>,
) -> Result<()> {
    let bytes = input_bytes(env, &bytes)?;
    with_upload(handle, |u| {
        u.bundle
            .as_mut()
            .ok_or("invalid_state")?
            .append_asset(index(offset)?, &bytes)
            .map_err(|_| "invalid_asset_input")
    })
}
fn upload_finish_asset(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_upload(handle, |u| {
        u.bundle
            .as_mut()
            .ok_or("invalid_state")?
            .finish_asset()
            .map_err(|_| "invalid_asset_input")
    })
}
fn upload_cancel_asset(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_upload(handle, |u| {
        u.bundle.as_mut().ok_or("invalid_state")?.cancel_asset();
        Ok(())
    })
}
fn document_error(value: orcaxr_contracts::project_intent_types::SessionError) -> &'static str {
    use orcaxr_contracts::project_intent_types::SessionError;
    match value {
        SessionError::Disposed => "disposed",
        SessionError::Stale => "stale",
        _ => "resource_limit",
    }
}
fn upload_prepare(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::Upload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::Upload(mut upload)) = record.take() else {
            unreachable!()
        };
        let (project, assets) = upload
            .bundle
            .take()
            .ok_or("invalid_state")?
            .finish()
            .map_err(|_| "incomplete_bundle")?;
        *record = Some(Record::Document(
            PreparedDocument::new(project, assets).map_err(|_| "invalid_bundle")?,
        ));
        Ok(())
    })
}
fn begin_open(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| {
        with_session(handle, |s| {
            s.begin_open().map(Record::Open).map_err(document_error)
        })
    })
}
fn is_open_current(_: &mut JNIEnv<'_>, handle: jlong, ticket: jlong) -> Result<jboolean> {
    let ticket = with_open(ticket, |t| Ok(t.clone()))?;
    with_session(handle, |s| Ok(s.is_open_current(&ticket).into()))
}
fn cancel_open(_: &mut JNIEnv<'_>, handle: jlong, ticket: jlong) -> Result<jboolean> {
    let ticket = with_open(ticket, |t| Ok(t.clone()))?;
    with_session(handle, |s| Ok(s.cancel_open(&ticket).into()))
}
fn take_document(handle: jlong) -> Result<PreparedDocument> {
    let document = registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::Document(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::Document(document)) = record.take() else {
            unreachable!()
        };
        Ok(document)
    })?;
    registry().close(handle)?;
    Ok(document)
}
/// A prepared document's project id, semantic hash and asset fingerprint, one per line.
fn document_identity(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jcharArray> {
    let units = registry().slot(handle)?.with(|record| match record {
        Some(Record::Document(document)) => {
            let (id, hash, assets) = document.identity();
            let mut units = id.to_vec();
            units.push(u16::from(b'\n'));
            units.extend(hash.encode_utf16());
            units.push(u16::from(b'\n'));
            units.extend(assets.encode_utf16());
            Ok(units)
        }
        _ => Err("invalid_handle_kind"),
    })?;
    text(env, &units)
}
fn finish_open(_: &mut JNIEnv<'_>, handle: jlong, ticket: jlong, document: jlong) -> Result<jlong> {
    let document = take_document(document)?;
    let ticket = with_open(ticket, |t| Ok(t.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            s.finish_open(&ticket, document)
                .map(Record::Effects)
                .map_err(document_error)
        })
    })
}
fn reset_document(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    document: jlong,
) -> Result<jlong> {
    let document = take_document(document)?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            s.reset_document(&guard, document)
                .map(Record::Effects)
                .map_err(document_error)
        })
    })
}
fn upload_open(env: &mut JNIEnv<'_>, handle: jlong, generation: JLongArray<'_>) -> Result<()> {
    if env
        .get_array_length(&generation)
        .map_err(|_| "invalid_generation")?
        != 4
    {
        return Err("invalid_generation");
    }
    let mut values = [0i64; 4];
    env.get_long_array_region(&generation, 0, &mut values)
        .map_err(|_| "invalid_generation")?;
    let mut nonce = [0u32; 4];
    for (i, v) in values.into_iter().enumerate() {
        nonce[i] = u32::try_from(v).map_err(|_| "invalid_generation")?;
    }
    registry().slot(handle)?.with(|record| {
        if !matches!(record, Some(Record::Upload(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::Upload(mut u)) = record.take() else {
            unreachable!()
        };
        let (project, assets) = u
            .bundle
            .take()
            .ok_or("invalid_state")?
            .finish()
            .map_err(|_| "incomplete_bundle")?;
        let session = Session::new(
            project,
            SelectionStore::default(),
            assets,
            u.timestamps.take().ok_or("invalid_state")?,
            HistoryOptions {
                max_entries: u.options.history_entries,
                max_estimated_bytes: u.options.history_bytes as u64,
            },
            nonce,
        )
        .map_err(|_| "invalid_bundle")?;
        *record = Some(Record::Session(Box::new(session)));
        Ok(())
    })
}
/// A protocol message within the shared intent byte budget.
fn intent_text(env: &mut JNIEnv<'_>, request: &JString<'_>) -> Result<String> {
    let length = env
        .call_method(request, "length", "()I", &[])
        .and_then(|v| v.i())
        .map_err(|_| "invalid_request")?;
    if length < 0 || length as usize > orcaxr_contracts::project_intent_types::MAX_BYTES {
        return Err("input_limit");
    }
    Ok(env
        .get_string(request)
        .map_err(|_| "invalid_request")?
        .into())
}
fn submit(env: &mut JNIEnv<'_>, handle: jlong, request: JString<'_>) -> Result<jlong> {
    let request = intent_text(env, &request)?;
    let reserved = registry().reserve(false)?;
    match with_session(handle, |s| Ok(s.submit(&request)))? {
        Submission::Ready(reply) => reserved.insert(Record::Reply(reply)),
        Submission::Queued { .. } => Ok(0),
    }
}
fn run_next(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    let reserved = registry().reserve(false)?;
    match with_session(handle, |s| Ok(s.run_next()))? {
        Some(reply) => reserved.insert(Record::Reply(reply)),
        None => Ok(0),
    }
}
fn pending_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_session(handle, |s| Ok(s.pending_count() as i64))
}
fn dispose(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    with_session(handle, |s| {
        s.dispose();
        Ok(())
    })
}
fn is_disposed(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jboolean> {
    with_session(handle, |s| Ok(s.is_disposed().into()))
}
fn snapshot(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| with_session(handle, |s| Ok(Record::Project(s.snapshot()))))
}
fn capture_export(_: &mut JNIEnv<'_>, handle: jlong, guard: jlong) -> Result<jlong> {
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            ExportCapture::new(s, &guard)
                .map(Record::Export)
                .ok_or("stale")
        })
    })
}
fn export_project(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| with_export(handle, |e| Ok(Record::Project(e.project().clone()))))
}
fn export_asset_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_export(handle, |e| Ok(e.asset_count() as jlong))
}
fn export_asset(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    capture(|| {
        with_export(handle, |e| {
            e.asset(index(position)?)
                .map(Record::Asset)
                .ok_or("invalid_range")
        })
    })
}
fn selection(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| with_session(handle, |s| Ok(Record::Selection(s.selection()))))
}
fn history(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| with_session(handle, |s| Ok(Record::History(s.history()))))
}
fn history_revision(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_session(handle, |s| Ok(s.history_revision() as i64))
}
fn asset_fingerprint(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    string(
        env,
        with_session(handle, |s| Ok(s.assets().bundle_fingerprint().into()))?,
    )
}
fn asset(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    capture(|| {
        with_session(handle, |s| {
            let snapshot = s.snapshot();
            let id = &snapshot
                .state()
                .source_assets
                .get(index(position)?)
                .ok_or("invalid_range")?
                .id;
            s.assets()
                .peek(id)
                .map(Record::Asset)
                .ok_or("missing_asset")
        })
    })
}
fn capture_guard(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| {
        with_session(handle, |s| {
            s.capture_guard().map(Record::Guard).map_err(|_| "disposed")
        })
    })
}
fn is_current(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    export: jboolean,
) -> Result<jboolean> {
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    with_session(handle, |s| {
        Ok(if export != 0 {
            s.is_export_current(&guard)
        } else {
            s.is_current(&guard)
        }
        .into())
    })
}
fn acknowledge_checkpoint(_: &mut JNIEnv<'_>, handle: jlong, guard: jlong) -> Result<jlong> {
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            s.acknowledge_checkpoint(&guard)
                .map(Record::Effects)
                .map_err(|_| "stale_or_disposed")
        })
    })
}
fn select(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    input: jlong,
    primary: jlong,
) -> Result<jlong> {
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    let reserved = registry().reserve(false)?;
    let refs = with_selection_input(input, |i| Ok(std::mem::take(&mut i.refs)))?;
    registry().close(input)?;
    let primary = if primary == -1 {
        None
    } else {
        Some(refs.get(index(primary)?).ok_or("invalid_range")?.clone())
    };
    let events = with_session(handle, |s| {
        s.select(&guard, &refs, primary)
            .map_err(|_| "invalid_selection")
    })?;
    reserved.insert(Record::Effects(
        events.into_iter().map(DomainEvent::Selection).collect(),
    ))
}
fn selection_input_new(_: &mut JNIEnv<'_>) -> Result<jlong> {
    capture(|| Ok(Record::SelectionInput(Default::default())))
}
fn selection_input_add(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    kind: jint,
    id: JCharArray<'_>,
) -> Result<()> {
    let length = env.get_array_length(&id).map_err(|_| "invalid_selection")?;
    if length < 0 || length as usize > layout::MAX_SELECTION_TEXT_UNITS {
        return Err("input_limit");
    }
    let mut id_copy = vec![0u16; length as usize];
    env.get_char_array_region(&id, 0, &mut id_copy)
        .map_err(|_| "invalid_selection")?;
    with_selection_input(handle, |input| {
        if input.refs.len() == layout::MAX_SELECTION_REFS
            || id_copy.len() > layout::MAX_SELECTION_TEXT_UNITS - input.units
        {
            return Err("input_limit");
        }
        let length = id_copy.len();
        let selected = match kind as u32 {
            layout::SELECT_PROJECT if id_copy.is_empty() => SelectionRef::Project,
            layout::SELECT_PLATE => SelectionRef::Plate(
                PlateId::try_from_utf16(id_copy).map_err(|_| "invalid_selection")?,
            ),
            layout::SELECT_OBJECT => SelectionRef::Object(
                ObjectId::try_from_utf16(id_copy).map_err(|_| "invalid_selection")?,
            ),
            layout::SELECT_VOLUME => SelectionRef::Volume(
                VolumeId::try_from_utf16(id_copy).map_err(|_| "invalid_selection")?,
            ),
            layout::SELECT_INSTANCE => SelectionRef::Instance(
                InstanceId::try_from_utf16(id_copy).map_err(|_| "invalid_selection")?,
            ),
            layout::SELECT_LAYER_RANGE => SelectionRef::LayerRange(
                LayerRangeId::try_from_utf16(id_copy).map_err(|_| "invalid_selection")?,
            ),
            layout::SELECT_FILAMENT => SelectionRef::Filament(
                FilamentId::try_from_utf16(id_copy).map_err(|_| "invalid_selection")?,
            ),
            _ => return Err("invalid_selection"),
        };
        input.units += length;
        input.refs.push(selected);
        Ok(())
    })
}
fn reply_wire(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    string(env, with_reply(handle, |r| Ok(r.wire().into()))?)
}
fn reply_effects(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    // The reply slot was reserved before mutation. Consume it in place: a second
    // reservation here could lose an already committed outcome at full capacity.
    registry().slot(handle)?.with(|value| {
        if !matches!(value, Some(Record::Reply(_))) {
            return Err("invalid_handle_kind");
        }
        let Some(Record::Reply(reply)) = value.take() else {
            unreachable!()
        };
        *value = Some(Record::Effects(reply.into_parts().1));
        Ok(handle)
    })
}
fn effect<R>(
    handle: i64,
    position: i64,
    call: impl FnOnce(&DomainEvent) -> Result<R>,
) -> Result<R> {
    with_effects(handle, |events| {
        call(events.get(index(position)?).ok_or("invalid_range")?)
    })
}
fn effects_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_effects(handle, |v| Ok(v.len() as i64))
}
fn effect_kind(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jint> {
    effect(handle, position, |e| {
        Ok(match e {
            DomainEvent::Project(_) => layout::EFFECT_PROJECT,
            DomainEvent::Selection(_) => layout::EFFECT_SELECTION,
            DomainEvent::History { .. } => layout::EFFECT_HISTORY,
        } as i32)
    })
}
fn effect_capture(
    _: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
    previous: jboolean,
) -> Result<jlong> {
    capture(|| {
        effect(handle, position, |e| {
            Ok(match e {
                DomainEvent::Project(c) => Record::Project(
                    if previous != 0 {
                        c.previous()
                    } else {
                        c.current()
                    }
                    .clone(),
                ),
                DomainEvent::Selection(c) => Record::Selection(
                    if previous != 0 {
                        c.previous()
                    } else {
                        c.current()
                    }
                    .clone(),
                ),
                DomainEvent::History {
                    previous: a,
                    current: b,
                } => Record::History(if previous != 0 { a } else { b }.clone()),
            })
        })
    })
}
fn effect_reason_length(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    effect(handle, position, |e| {
        if let DomainEvent::Project(c) = e {
            Ok(c.reason().units().len() as i64)
        } else {
            Err("wrong_effect")
        }
    })
}
fn effect_reason(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
    start: jlong,
    count: jlong,
) -> Result<jcharArray> {
    text(
        env,
        &effect(handle, position, |e| {
            if let DomainEvent::Project(c) = e {
                text_slice(c.reason().units(), start, count)
            } else {
                Err("wrong_effect")
            }
        })?,
    )
}
fn categories(values: &[orcaxr_contracts::project_intent_types::DirtyCategory]) -> String {
    use orcaxr_contracts::project_intent_types::DirtyCategory::*;
    values
        .iter()
        .map(|v| match v {
            ProjectData => "projectData",
            Presets => "presets",
            PrinterDevice => "printerDevice",
        })
        .collect::<Vec<_>>()
        .join(",")
}
fn effect_dirty_categories(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    string(
        env,
        effect(handle, position, |e| {
            if let DomainEvent::Project(c) = e {
                Ok(categories(c.dirty_categories()))
            } else {
                Err("wrong_effect")
            }
        })?,
    )
}
fn project_revision(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_project(handle, |p| Ok(p.revision() as i64))
}
fn project_hash(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    string(env, with_project(handle, |p| Ok(p.hash().into()))?)
}
fn project_id_length(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_project(handle, |p| Ok(p.state().id.as_utf16().len() as i64))
}
fn project_id(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jcharArray> {
    text(
        env,
        &with_project(handle, |p| {
            text_slice(p.state().id.as_utf16(), start, count)
        })?,
    )
}
struct LimitedBytes {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit - self.bytes.len() {
            return Err(io::Error::other("output limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn project_export(_: &mut JNIEnv<'_>, handle: jlong, max_bytes: jlong) -> Result<jlong> {
    capture(|| {
        let project = with_project(handle, |p| Ok(p.clone()))?;
        let mut sink = LimitedBytes {
            bytes: vec![],
            limit: index(max_bytes)?,
        };
        project
            .state()
            .write_json(&mut sink)
            .map_err(|_| "output_limit")?;
        Ok(Record::Bytes(sink.bytes))
    })
}
fn project_write_json(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    max_bytes: jlong,
    sink: JObject<'_>,
) -> Result<jlong> {
    json_sink::write_json(env, handle, max_bytes, sink)
}
fn bytes_length(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_bytes(handle, |b| Ok(b.len() as i64))
}
fn bytes_read(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let bytes = with_bytes(handle, |b| {
        Ok(b[range(start, count, b.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    })?;
    env.byte_array_from_slice(&bytes)
        .map(|b| b.into_raw())
        .map_err(|_| "allocation_failed")
}
fn asset_length(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_asset(handle, |a| Ok(a.bytes().len() as i64))
}
fn asset_id_length(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_asset(handle, |a| Ok(a.id().as_utf16().len() as jlong))
}
fn asset_id(env: &mut JNIEnv<'_>, handle: jlong, start: jlong, count: jlong) -> Result<jcharArray> {
    text(
        env,
        &with_asset(handle, |a| text_slice(a.id().as_utf16(), start, count))?,
    )
}
fn asset_digest(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    string(env, with_asset(handle, |a| Ok(a.content_digest().into()))?)
}
fn asset_read(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let bytes = with_asset(handle, |a| {
        Ok(a.bytes()[range(start, count, a.bytes().len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    })?;
    env.byte_array_from_slice(&bytes)
        .map(|b| b.into_raw())
        .map_err(|_| "allocation_failed")
}
fn asset_metadata(_: &mut JNIEnv<'_>, handle: jlong, max_bytes: jlong) -> Result<jlong> {
    capture(|| {
        let asset = with_asset(handle, |a| Ok(a.clone()))?;
        let mut sink = LimitedBytes {
            bytes: vec![],
            limit: index(max_bytes)?,
        };
        asset
            .descriptor()
            .write_canonical(&mut sink)
            .map_err(|_| "output_limit")?;
        Ok(Record::Bytes(sink.bytes))
    })
}
fn selected(value: &SelectionRef) -> (u32, &[u16]) {
    match value {
        SelectionRef::Project => (layout::SELECT_PROJECT, &[]),
        SelectionRef::Plate(id) => (layout::SELECT_PLATE, id.as_utf16()),
        SelectionRef::Object(id) => (layout::SELECT_OBJECT, id.as_utf16()),
        SelectionRef::Volume(id) => (layout::SELECT_VOLUME, id.as_utf16()),
        SelectionRef::Instance(id) => (layout::SELECT_INSTANCE, id.as_utf16()),
        SelectionRef::LayerRange(id) => (layout::SELECT_LAYER_RANGE, id.as_utf16()),
        SelectionRef::Filament(id) => (layout::SELECT_FILAMENT, id.as_utf16()),
    }
}
fn selection_count(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_selection(handle, |s| Ok(s.refs().len() as i64))
}
fn selection_primary(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_selection(handle, |s| {
        Ok(s.primary()
            .and_then(|r| s.refs().iter().position(|v| v == r))
            .map_or(-1, |i| i as i64))
    })
}
fn selection_kind(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jint> {
    with_selection(handle, |s| {
        Ok(selected(s.refs().get(index(position)?).ok_or("invalid_range")?).0 as i32)
    })
}
fn selection_id_length(_: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jlong> {
    with_selection(handle, |s| {
        Ok(
            selected(s.refs().get(index(position)?).ok_or("invalid_range")?)
                .1
                .len() as i64,
        )
    })
}
fn selection_id(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
    start: jlong,
    count: jlong,
) -> Result<jcharArray> {
    text(
        env,
        &with_selection(handle, |s| {
            text_slice(
                selected(s.refs().get(index(position)?).ok_or("invalid_range")?).1,
                start,
                count,
            )
        })?,
    )
}
fn label(h: &HistorySnapshot, undo: jboolean) -> Option<&Text> {
    if undo != 0 {
        h.undo_label.as_ref()
    } else {
        h.redo_label.as_ref()
    }
}
fn history_count(_: &mut JNIEnv<'_>, handle: jlong, undo: jboolean) -> Result<jlong> {
    with_history(handle, |h| {
        Ok(if undo != 0 {
            h.undo_count
        } else {
            h.redo_count
        } as i64)
    })
}
fn history_has_label(_: &mut JNIEnv<'_>, handle: jlong, undo: jboolean) -> Result<jboolean> {
    with_history(handle, |h| Ok(label(h, undo).is_some().into()))
}
fn history_label_length(_: &mut JNIEnv<'_>, handle: jlong, undo: jboolean) -> Result<jlong> {
    with_history(handle, |h| {
        Ok(label(h, undo).map_or(0, |v| v.units().len() as i64))
    })
}
fn history_label(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    undo: jboolean,
    start: jlong,
    count: jlong,
) -> Result<jcharArray> {
    text(
        env,
        &with_history(handle, |h| {
            text_slice(label(h, undo).ok_or("missing_label")?.units(), start, count)
        })?,
    )
}
fn history_dirty_categories(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    string(
        env,
        with_history(handle, |h| Ok(categories(&h.dirty_categories)))?,
    )
}
fn close(_: &mut JNIEnv<'_>, handle: jlong) -> Result<()> {
    registry().close(handle)
}
