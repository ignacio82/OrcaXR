//! The settings editor host exchange. An editor keeps the host's collator and
//! search folder; requests and replies are generated contract JSON, and fields
//! and rows are read one at a time after a query.
use super::*;
use jni::{JavaVM, objects::GlobalRef};
use orcaxr_contracts::{project_intent_types as wire, project_intents::InvalidIntent};
use orcaxr_project::settings::{
    editor::{
        AsciiFolding, SearchFolding,
        exchange::{self, HostEditor, Refusal},
    },
    presets::{AsciiRootCollation, Collation},
    projection_exchange,
};
use std::cmp::Ordering;

/// An editor with the host policies it was created with.
pub(super) struct Editor {
    inner: HostEditor,
    collator: Option<GlobalRef>,
    folder: Option<(JavaVM, GlobalRef)>,
}
/// The stored collator on this JNI thread, or the exact ASCII root order.
struct Order<'a, 'env> {
    env: &'a mut JNIEnv<'env>,
    collator: Option<&'a GlobalRef>,
}
impl Collation for Order<'_, '_> {
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
}
/// `dev.orcaxr.core.SearchFolding.fold(char[])`, called on this thread
/// through its own attachment, or the exact ASCII folding.
struct Fold<'a>(Option<&'a (JavaVM, GlobalRef)>);
impl SearchFolding for Fold<'_> {
    type Error = &'static str;
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>> {
        let Some((vm, folder)) = self.0 else {
            return AsciiFolding.fold(text).map_err(|_| "non_ascii_search");
        };
        let mut env = vm.attach_current_thread().map_err(|_| "folding_failed")?;
        let input = char_array(&mut env, text)?;
        let result = env
            .call_method(folder.as_obj(), "fold", "([C)[C", &[(&input).into()])
            .and_then(|v| v.l());
        let _ = env.delete_local_ref(input);
        // A callback may throw private text: clear it, report a stable code.
        let folded = result.map_err(|_| {
            let _ = env.exception_clear();
            "folding_failed"
        })?;
        if folded.is_null() {
            return Err("folding_failed");
        }
        let array = jni::objects::JCharArray::from(folded);
        let length = env.get_array_length(&array).map_err(|_| "folding_failed")?;
        let mut units = vec![0u16; length as usize];
        env.get_char_array_region(&array, 0, &mut units)
            .map_err(|_| "folding_failed")?;
        let _ = env.delete_local_ref(array);
        Ok(units)
    }
}
fn refused(e: Refusal<&'static str>) -> &'static str {
    match e {
        Refusal::Host(code) => code,
        other => other.code(),
    }
}
fn encoded<T>(
    value: &T,
    encode: fn(&T) -> std::result::Result<String, InvalidIntent>,
) -> Result<String> {
    encode(value).map_err(|_| "output_limit")
}
fn decoded<T>(
    env: &mut JNIEnv<'_>,
    text: &JString<'_>,
    decode: fn(&str) -> std::result::Result<T, InvalidIntent>,
) -> Result<T> {
    let text = intent_text(env, text)?;
    decode(&text).map_err(|_| "invalid_request")
}
fn with_editor<R>(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    call: impl FnOnce(&mut HostEditor, &mut Order<'_, '_>, &mut Fold<'_>) -> Result<R>,
) -> Result<R> {
    registry().slot(handle)?.with(|record| match record {
        Some(Record::Editor(editor)) => {
            let Editor {
                inner,
                collator,
                folder,
            } = &mut **editor;
            let mut order = Order {
                env,
                collator: collator.as_ref(),
            };
            call(inner, &mut order, &mut Fold(folder.as_ref()))
        }
        _ => Err("invalid_handle_kind"),
    })
}

/// A host collator and search folder, held across calls.
type Policies = (Option<GlobalRef>, Option<(JavaVM, GlobalRef)>);
/// The host's collator and folder, checked and held across calls.
fn policies(
    env: &mut JNIEnv<'_>,
    collator: &JObject<'_>,
    folder: &JObject<'_>,
) -> Result<Policies> {
    let mut global =
        |object: &JObject<'_>, class: &str, code: &'static str| -> Result<Option<GlobalRef>> {
            if object.is_null() {
                return Ok(None);
            }
            if !env.is_instance_of(object, class).map_err(|_| code)? {
                return Err(code);
            }
            env.new_global_ref(object).map(Some).map_err(|_| code)
        };
    let collator = global(
        collator,
        "dev/orcaxr/core/PresetCollator",
        "collation_failed",
    )?;
    let folder = global(folder, "dev/orcaxr/core/SearchFolding", "folding_failed")?;
    let folder = match folder {
        Some(folder) => Some((env.get_java_vm().map_err(|_| "folding_failed")?, folder)),
        None => None,
    };
    Ok((collator, folder))
}
fn insert(
    inner: HostEditor,
    policies: (Option<GlobalRef>, Option<(JavaVM, GlobalRef)>),
) -> Result<jlong> {
    let (collator, folder) = policies;
    let reserved = registry().reserve(false)?;
    reserved.insert(Record::Editor(Box::new(Editor {
        inner,
        collator,
        folder,
    })))
}
/// A null collator or folder uses the exact ASCII policy.
pub(super) fn editor_new(
    env: &mut JNIEnv<'_>,
    create: JString<'_>,
    collator: JObject<'_>,
    folder: JObject<'_>,
) -> Result<jlong> {
    let create = decoded(env, &create, wire::decode_editor_create)?;
    let policies = policies(env, &collator, &folder)?;
    let inner = HostEditor::create::<&'static str>(&create).map_err(refused)?;
    insert(inner, policies)
}
/// The settings editor for one node of a captured project.
pub(super) fn project_settings_editor(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    collator: JObject<'_>,
    folder: JObject<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_settings_session_request)?;
    let policies = policies(env, &collator, &folder)?;
    let inner = with_project(handle, |p| {
        HostEditor::open::<&'static str>(p, &request).map_err(refused)
    })?;
    insert(inner, policies)
}
/// The project intent of the editor's latest commit.
pub(super) fn editor_intent(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_editor(env, handle, |e, _, _| {
        encoded(e.intent().ok_or("no_commit")?, wire::encode_intent)
    })?;
    string(env, json)
}
fn projection<T>(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
    decode: fn(&str) -> std::result::Result<T, InvalidIntent>,
    read: impl FnOnce(&ProjectSnapshot, &T) -> Result<String>,
) -> Result<jstring> {
    let request = decoded(env, &request, decode)?;
    let json = with_project(handle, |p| read(p, &request))?;
    string(env, json)
}
pub(super) fn project_paint_palette(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    projection(
        env,
        handle,
        request,
        wire::decode_paint_palette_request,
        |p, r| {
            let palette = orcaxr_project::facets::palette::project_palette(
                &p.state().filaments,
                r.include_unavailable,
            );
            encoded(
                &orcaxr_project::facets::palette::wire_palette(&palette),
                wire::encode_paint_palette,
            )
        },
    )
}
pub(super) fn session_capabilities(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_capability_request)?;
    let json = with_session(handle, |s| {
        let page = orcaxr_project::capabilities::session_page(s, &request)
            .map_err(|refusal| refusal.code())?;
        encoded(&page, wire::encode_capability_page)
    })?;
    string(env, json)
}
pub(super) fn session_render(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_render_request)?;
    let json = with_session(handle, |s| {
        let page = s.render_page(&request).map_err(|refusal| refusal.code())?;
        encoded(&page, wire::encode_render_page)
    })?;
    string(env, json)
}
pub(super) fn session_facet_region(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_facet_region_request)?;
    let json = with_session(handle, |s| {
        let reply = orcaxr_project::facets::region_exchange::session_reply(s, &request)
            .map_err(|refusal| refusal.code())?;
        encoded(&reply, wire::encode_facet_region_reply)
    })?;
    string(env, json)
}
/// Open a paint stroke on the state `guard` captured; the stroke owns its
/// mesh and samples off the session.
pub(super) fn paint_stroke_open(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_paint_stroke_open)?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            s.paint_stroke(&guard, &request)
                .map(|stroke| Record::PaintStroke(Box::new(stroke)))
                .map_err(|refusal| refusal.code())
        })
    })
}
pub(super) fn paint_stroke_sample(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_paint_stroke_sample)?;
    let json = with_paint_stroke(handle, |stroke| {
        encoded(
            &stroke.sample(&request),
            wire::encode_paint_stroke_sample_reply,
        )
    })?;
    string(env, json)
}
pub(super) fn paint_stroke_overlay(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_paint_stroke_overlay_request)?;
    let json = with_paint_stroke(handle, |stroke| {
        encoded(
            &stroke.overlay(&request).map_err(|refusal| refusal.code())?,
            wire::encode_paint_stroke_overlay,
        )
    })?;
    string(env, json)
}
/// Prepare one volume's split on the state `guard` captured.
pub(super) fn volume_split(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_volume_split_request)?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            s.volume_split(&guard, &request)
                .map(|split| Record::VolumeSplit(Box::new(split)))
                .map_err(session_error)
        })
    })
}
/// The split's parts and geometries, or its refusal.
pub(super) fn volume_split_reply(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_volume_split(handle, |split| {
        encoded(&split.reply(), wire::encode_volume_split_reply)
    })?;
    string(env, json)
}
/// The split's staged commit ID under the host's names.
pub(super) fn stage_volume_split(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    split: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_volume_split_stage)?;
    with_volume_split(split, |split| {
        with_session(handle, |s| {
            s.stage_volume_split(split, &request)
                .map(|id| id as jlong)
                .map_err(session_error)
        })
    })
}
/// Decimate one volume's mesh on the state `guard` captured.
pub(super) fn volume_simplify(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    guard: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_volume_simplify_request)?;
    let guard = with_guard(guard, |g| Ok(g.clone()))?;
    capture(|| {
        with_session(handle, |s| {
            s.volume_simplify(&guard, &request)
                .map(|simplify| Record::VolumeSimplify(Box::new(simplify)))
                .map_err(session_error)
        })
    })
}
/// The decimation's summary, unchanged, or its refusal.
pub(super) fn volume_simplify_reply(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_volume_simplify(handle, |simplify| {
        encoded(&simplify.reply(), wire::encode_volume_simplify_reply)
    })?;
    string(env, json)
}
/// A page of the result's indexed-mesh bytes.
pub(super) fn volume_simplify_mesh(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let (start, count) = (index(start)?, index(count)?);
    let bytes = with_volume_simplify(handle, |simplify| {
        simplify
            .mesh(start as u64, count as u64)
            .map(<[u8]>::to_vec)
            .map_err(|_| "invalid_request")
    })?;
    env.byte_array_from_slice(&bytes)
        .map(|array| array.into_raw())
        .map_err(|_| "output_limit")
}
/// The decimation's staged commit ID under the host's asset ID.
pub(super) fn stage_volume_simplify(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    simplify: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_volume_simplify_stage)?;
    with_volume_simplify(simplify, |simplify| {
        with_session(handle, |s| {
            s.stage_volume_simplify(simplify, &request)
                .map(|id| id as jlong)
                .map_err(session_error)
        })
    })
}
/// One volume's features captured for measuring.
pub(super) fn session_measure_volume(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_measure_volume_request)?;
    capture(|| {
        with_session(handle, |s| {
            s.measure_volume(&request)
                .map(|volume| Record::MeasureVolume(Box::new(volume)))
                .map_err(session_error)
        })
    })
}
/// The capture's plane and facet counts, or its refusal.
pub(super) fn measure_volume_reply(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_measure_volume(handle, |volume| {
        encoded(&volume.reply(), wire::encode_measure_volume_reply)
    })?;
    string(env, json)
}
/// The feature a pick claims.
pub(super) fn measure_volume_feature(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_measure_feature_request)?;
    let json = with_measure_volume(handle, |volume| {
        encoded(
            &volume.feature(&request),
            wire::encode_measure_feature_reply,
        )
    })?;
    string(env, json)
}
/// Two features measured.
pub(super) fn measure_features(env: &mut JNIEnv<'_>, request: JString<'_>) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_measure_request)?;
    let json = encoded(
        &orcaxr_project::measure::measure_wire(&request),
        wire::encode_measure_reply,
    )?;
    string(env, json)
}
fn session_error(error: wire::SessionError) -> &'static str {
    match error {
        wire::SessionError::Disposed => "disposed",
        wire::SessionError::Stale => "stale",
        wire::SessionError::ResourceLimit => "resource_limit",
        _ => "invalid_request",
    }
}
/// The plate's wipe tower, auto-placed.
pub(super) fn session_wipe_tower(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_wipe_tower_request)?;
    let json = with_session(handle, |s| {
        let reply = s.plan_wipe_tower(&request).map_err(|_| "disposed")?;
        encoded(&reply, wire::encode_wipe_tower_reply)
    })?;
    string(env, json)
}
/// One plate's arrangement.
pub(super) fn session_arrangement(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_arrange_request)?;
    let json = with_session(handle, |s| {
        let reply = s.plan_arrangement(&request).map_err(|_| "disposed")?;
        encoded(&reply, wire::encode_arrange_reply)
    })?;
    string(env, json)
}
/// Copies of one instance in a plate's free space.
pub(super) fn session_bed_fill(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_bed_fill_request)?;
    let json = with_session(handle, |s| {
        let reply = s.plan_bed_fill(&request).map_err(|_| "disposed")?;
        encoded(&reply, wire::encode_bed_fill_reply)
    })?;
    string(env, json)
}
/// The transforms one placement edit submits.
pub(super) fn session_placement(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    let request = decoded(env, &request, wire::decode_placement_request)?;
    let json = with_session(handle, |s| {
        let reply = s.plan_placement(&request).map_err(|_| "disposed")?;
        encoded(&reply, wire::encode_placement_reply)
    })?;
    string(env, json)
}
/// One plate captured for picking; the scene owns its meshes.
pub(super) fn session_pick_scene(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_pick_scene_request)?;
    capture(|| {
        with_session(handle, |s| {
            s.pick_scene(&request)
                .map(|scene| Record::PickScene(Box::new(scene)))
                .map_err(|refusal| refusal.code())
        })
    })
}
pub(super) fn pick_scene_pick(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    ray: JString<'_>,
) -> Result<jstring> {
    let ray = decoded(env, &ray, wire::decode_pick_ray)?;
    let json = with_pick_scene(handle, |scene| {
        encoded(&scene.pick(&ray), wire::encode_pick_reply)
    })?;
    string(env, json)
}
/// The canonical paint overlay of one volume's channel.
pub(super) fn session_paint_overlay(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jlong> {
    let request = decoded(env, &request, wire::decode_paint_overlay_request)?;
    capture(|| {
        with_session(handle, |s| {
            s.paint_overlay(&request)
                .map(|overlay| Record::PaintOverlay(Box::new(overlay)))
                .map_err(|refusal| refusal.code())
        })
    })
}
/// A stroke's live preview as an overlay capture.
pub(super) fn paint_stroke_preview(_: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    capture(|| {
        with_paint_stroke(handle, |stroke| {
            stroke
                .preview()
                .map(|overlay| Record::PaintOverlay(Box::new(overlay)))
                .map_err(|refusal| refusal.code())
        })
    })
}
pub(super) fn paint_overlay_summary(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_paint_overlay(handle, |overlay| {
        encoded(&overlay.summary(), wire::encode_paint_overlay_summary)
    })?;
    string(env, json)
}
pub(super) fn paint_overlay_packet(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    start: jlong,
    count: jlong,
) -> Result<jbyteArray> {
    let (start, count) = (index(start)?, index(count)?);
    let packet = with_paint_overlay(handle, |overlay| {
        overlay
            .packet(start as u64, count as u64)
            .map_err(|refusal| refusal.code())
    })?;
    env.byte_array_from_slice(&packet)
        .map(|array| array.into_raw())
        .map_err(|_| "output_limit")
}
/// The stroke's staged commit ID, or 0 when it touched no facet.
pub(super) fn stage_paint_stroke(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    stroke: jlong,
    label: JCharArray<'_>,
) -> Result<jlong> {
    let label = if label.is_null() {
        None
    } else {
        Some(super::model::chars(env, &label)?)
    };
    with_paint_stroke(stroke, |stroke| {
        with_session(handle, |s| {
            s.stage_paint_stroke(stroke, label)
                .map(|id| id.map_or(0, |id| id as jlong))
                .map_err(|error| match error {
                    wire::SessionError::Disposed => "disposed",
                    wire::SessionError::Stale => "stale",
                    wire::SessionError::ResourceLimit => "resource_limit",
                    _ => "invalid_request",
                })
        })
    })
}
pub(super) fn project_settings_targets(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    projection(
        env,
        handle,
        request,
        wire::decode_settings_target_page_request,
        |p, r| {
            encoded(
                &projection_exchange::target_page(p, r).map_err(|e| e.code())?,
                wire::encode_settings_target_page,
            )
        },
    )
}
pub(super) fn project_settings_snapshot(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    projection(
        env,
        handle,
        request,
        wire::decode_settings_target_request,
        |p, r| {
            encoded(
                &projection_exchange::snapshot(p, r).map_err(|e| e.code())?,
                wire::encode_settings_snapshot_result,
            )
        },
    )
}
pub(super) fn project_settings_explain(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    request: JString<'_>,
) -> Result<jstring> {
    projection(
        env,
        handle,
        request,
        wire::decode_settings_explain_request,
        |p, r| {
            encoded(
                &projection_exchange::explain(p, r).map_err(|e| e.code())?,
                wire::encode_settings_explain_result,
            )
        },
    )
}
pub(super) fn editor_query(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    query: JString<'_>,
) -> Result<jlong> {
    let query = decoded(env, &query, wire::decode_editor_query)?;
    with_editor(env, handle, |e, order, fold| {
        e.query(&query, order, fold)
            .map(|n| n as jlong)
            .map_err(refused)
    })
}
pub(super) fn editor_field(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    position: jlong,
) -> Result<jstring> {
    let position = index(position)?;
    let json = with_editor(env, handle, |e, _, _| {
        encoded(
            &e.field(position).ok_or("invalid_range")?,
            wire::encode_editor_field,
        )
    })?;
    string(env, json)
}
pub(super) fn editor_state(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    field: JString<'_>,
) -> Result<jstring> {
    let field = decoded(env, &field, wire::decode_editor_field_ref)?;
    let json = with_editor(env, handle, |e, _, _| {
        encoded(
            &e.state(&field).map_err(refused)?,
            wire::encode_editor_field_state,
        )
    })?;
    string(env, json)
}
pub(super) fn editor_compare(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    field: JString<'_>,
) -> Result<jstring> {
    let field = decoded(env, &field, wire::decode_editor_field_ref)?;
    let json = with_editor(env, handle, |e, _, _| {
        encoded(
            &e.compare(&field).map_err(refused)?,
            wire::encode_editor_comparison,
        )
    })?;
    string(env, json)
}
pub(super) fn editor_edit(
    env: &mut JNIEnv<'_>,
    handle: jlong,
    edit: JString<'_>,
) -> Result<jstring> {
    let edit = decoded(env, &edit, wire::decode_editor_edit)?;
    let json = with_editor(env, handle, |e, _, _| {
        encoded(
            &e.edit::<&'static str>(&edit),
            wire::encode_editor_edit_result,
        )
    })?;
    string(env, json)
}
pub(super) fn editor_commit(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_editor(env, handle, |e, order, _| {
        encoded(
            &e.commit(order).map_err(refused)?,
            wire::encode_editor_commit_result,
        )
    })?;
    string(env, json)
}
pub(super) fn editor_revision(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_editor(env, handle, |e, _, _| Ok(e.revision() as jlong))
}
pub(super) fn editor_overrides(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jstring> {
    let json = with_editor(env, handle, |e, _, _| {
        Ok(String::from_utf16_lossy(&e.overrides_json()))
    })?;
    string(env, json)
}
pub(super) fn editor_rows(env: &mut JNIEnv<'_>, handle: jlong, rows: JString<'_>) -> Result<jlong> {
    let rows = decoded(env, &rows, wire::decode_editor_rows_request)?;
    with_editor(env, handle, |e, order, fold| {
        e.rows(&rows, order, fold)
            .map(|n| n as jlong)
            .map_err(refused)
    })
}
pub(super) fn editor_unavailable(env: &mut JNIEnv<'_>, handle: jlong) -> Result<jlong> {
    with_editor(env, handle, |e, _, _| Ok(e.unavailable() as jlong))
}
pub(super) fn editor_row(env: &mut JNIEnv<'_>, handle: jlong, position: jlong) -> Result<jstring> {
    let position = index(position)?;
    let json = with_editor(env, handle, |e, _, _| {
        encoded(
            &e.row(position).ok_or("invalid_range")?,
            wire::encode_editor_row,
        )
    })?;
    string(env, json)
}
pub(super) fn settings_step(env: &mut JNIEnv<'_>, step: JString<'_>) -> Result<jstring> {
    let step = decoded(env, &step, wire::decode_editor_step_request)?;
    let json = encoded(
        &exchange::step::<&'static str>(&step).map_err(refused)?,
        wire::encode_editor_step,
    )?;
    string(env, json)
}
pub(super) fn settings_rules(env: &mut JNIEnv<'_>, rules: JString<'_>) -> Result<jstring> {
    let rules = decoded(env, &rules, wire::decode_editor_rule_request)?;
    let json = encoded(
        &exchange::rules::<&'static str>(&rules).map_err(refused)?,
        wire::encode_editor_rules,
    )?;
    string(env, json)
}
