//! Explicitly owned project host handles. Large reads are opt-in captures, never
//! part of a command acknowledgement. Use an owned worker; release every handle.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::{
    assets::AssetLease,
    clipboard::ClipboardCapture,
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
        DocumentOpen, LocalGuard, PreparedDocument, ProjectSession as Session, Response,
        StagingLimits, Submission,
    },
    slicing::report::Report,
    staging_layout as staging,
    store::ProjectSnapshot,
};
use std::io::{self, Write};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = String)]
    type HostText;
    #[wasm_bindgen(js_namespace = String, js_name = fromCharCode, variadic, catch)]
    fn from_units(units: &[u16]) -> Result<HostText, JsValue>;
    #[wasm_bindgen(method, js_name = concat, catch)]
    fn concat(this: &HostText, other: &HostText) -> Result<HostText, JsValue>;
    #[wasm_bindgen(js_namespace = Date, js_name = parse, catch)]
    fn parse_date(text: &HostText) -> Result<f64, JsValue>;
}
pub(crate) type Timestamps = fn(&[u16]) -> Result<bool, ()>;
pub(crate) fn timestamps(units: &[u16]) -> Result<bool, ()> {
    // Avoid UTF-8/lossy conversion and argument-count limits. Browser Date.parse
    // remains the exact authority for its own timezone and legacy syntax.
    let mut text = from_units(&[]).map_err(|_| ())?;
    for chunk in units.chunks(layout::MAX_TEXT_CHUNK_UNITS) {
        text = text
            .concat(&from_units(chunk).map_err(|_| ())?)
            .map_err(|_| ())?;
    }
    parse_date(&text).map(|v| v.is_finite()).map_err(|_| ())
}
pub(crate) fn error(code: &str) -> JsValue {
    JsValue::from_str(code)
}
pub(crate) fn index(value: f64) -> Result<usize, JsValue> {
    if value.is_finite()
        && value.fract() == 0.0
        && (0.0..=layout::MAX_BUDGET as f64).contains(&value)
    {
        Ok(value as usize)
    } else {
        Err(error("invalid_range"))
    }
}
pub(crate) fn range(
    start: f64,
    count: f64,
    length: usize,
    cap: usize,
) -> Result<std::ops::Range<usize>, JsValue> {
    let start = index(start)?;
    let count = index(count)?;
    if start > length || count > cap || count > length - start {
        Err(error("invalid_range"))
    } else {
        Ok(start..start + count)
    }
}
fn text_read(value: &[u16], start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
    Ok(value[range(start, count, value.len(), layout::MAX_TEXT_CHUNK_UNITS)?].to_vec())
}
fn history_options(options: layout::HostOptions) -> HistoryOptions {
    HistoryOptions {
        max_entries: options.history_entries,
        max_estimated_bytes: options.history_bytes as u64,
    }
}

#[wasm_bindgen]
pub struct ProjectUpload {
    document: Option<ProjectInput>,
    bundle: Option<ProjectBundleInput>,
    options: layout::HostOptions,
}
#[wasm_bindgen]
impl ProjectUpload {
    #[wasm_bindgen(constructor)]
    pub fn new(
        version: f64,
        document_bytes: f64,
        options: &[f64],
    ) -> Result<ProjectUpload, JsValue> {
        let options =
            layout::decode_options(version, options).ok_or_else(|| error("invalid_options"))?;
        let limits = ProjectInputLimits {
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
        };
        Ok(Self {
            document: Some(
                ProjectInput::new(index(document_bytes)?, limits)
                    .map_err(|_| error("input_limit"))?,
            ),
            bundle: None,
            options,
        })
    }
    pub fn append_document(&mut self, offset: f64, bytes: &[u8]) -> Result<(), JsValue> {
        self.document
            .as_mut()
            .ok_or_else(|| error("invalid_state"))?
            .append(index(offset)?, bytes)
            .map_err(|_| error("invalid_document_input"))
    }
    /// Consumes staged document input, including on admission failure. This
    /// synchronous finalization belongs to the host's owned opening task.
    pub fn seal_document(&mut self) -> Result<(), JsValue> {
        let input = self.document.take().ok_or_else(|| error("invalid_state"))?;
        let mut policy = timestamps as Timestamps;
        self.bundle = Some(input.finish(&mut policy).map_err(|e| match e {
            orcaxr_project::ingress::DocumentError::Admission(
                orcaxr_project::validation::AdmissionError::Timestamp(_),
            ) => error("timestamp_service"),
            orcaxr_project::ingress::DocumentError::AssetBudget => error("input_limit"),
            _ => error("invalid_document"),
        })?);
        Ok(())
    }
    pub fn asset_count(&self) -> Result<f64, JsValue> {
        Ok(self
            .bundle
            .as_ref()
            .ok_or_else(|| error("invalid_state"))?
            .project()
            .state()
            .source_assets
            .len() as f64)
    }
    pub fn begin_asset(&mut self, position: f64) -> Result<f64, JsValue> {
        let bundle = self.bundle.as_mut().ok_or_else(|| error("invalid_state"))?;
        let id = bundle
            .project()
            .state()
            .source_assets
            .get(index(position)?)
            .ok_or_else(|| error("invalid_range"))?
            .id
            .clone();
        bundle
            .begin_asset(&id)
            .map(|v| v as f64)
            .map_err(|_| error("invalid_asset_input"))
    }
    pub fn append_asset(&mut self, offset: f64, bytes: &[u8]) -> Result<(), JsValue> {
        self.bundle
            .as_mut()
            .ok_or_else(|| error("invalid_state"))?
            .append_asset(index(offset)?, bytes)
            .map_err(|_| error("invalid_asset_input"))
    }
    pub fn finish_asset(&mut self) -> Result<(), JsValue> {
        self.bundle
            .as_mut()
            .ok_or_else(|| error("invalid_state"))?
            .finish_asset()
            .map_err(|_| error("invalid_asset_input"))
    }
    pub fn cancel_asset(&mut self) -> Result<(), JsValue> {
        self.bundle
            .as_mut()
            .ok_or_else(|| error("invalid_state"))?
            .cancel_asset();
        Ok(())
    }
    /// Consumes the upload and verifies a complete immutable replacement bundle.
    /// Preparation belongs to an owned import task; it publishes no live state.
    pub fn prepare(self) -> Result<ProjectDocument, JsValue> {
        let (project, assets) = self
            .bundle
            .ok_or_else(|| error("invalid_state"))?
            .finish()
            .map_err(|_| error("incomplete_bundle"))?;
        Ok(ProjectDocument {
            inner: Some(
                PreparedDocument::new(project, assets).map_err(|_| error("invalid_bundle"))?,
            ),
        })
    }
    /// Takes ownership even on failure. The nonce is fresh host entropy, not
    /// domain-ID entropy. No initial state is published until the bundle is full.
    pub fn open(self, generation: &[f64]) -> Result<ProjectSession, JsValue> {
        if generation.len() != 4 {
            return Err(error("invalid_generation"));
        }
        let mut nonce = [0; 4];
        for (i, &v) in generation.iter().enumerate() {
            nonce[i] = index(v)? as u32;
        }
        let bundle = self.bundle.ok_or_else(|| error("invalid_state"))?;
        let (project, assets) = bundle.finish().map_err(|_| error("incomplete_bundle"))?;
        let inner = Session::new(
            project,
            SelectionStore::default(),
            assets,
            timestamps as Timestamps,
            history_options(self.options),
            nonce,
        )
        .map_err(|_| error("invalid_bundle"))?;
        Ok(ProjectSession { inner })
    }
}

#[wasm_bindgen]
/// Admission consumes the contents on every outcome. Free the empty wrapper
/// afterwards; reusing its consumed contents returns invalid_state.
pub struct ProjectDocument {
    pub(crate) inner: Option<PreparedDocument>,
}
#[wasm_bindgen]
pub struct ProjectOpen {
    inner: DocumentOpen,
}
fn document_error(value: orcaxr_contracts::project_intent_types::SessionError) -> JsValue {
    use orcaxr_contracts::project_intent_types::SessionError;
    error(match value {
        SessionError::Disposed => "disposed",
        SessionError::Stale => "stale",
        _ => "resource_limit",
    })
}
#[wasm_bindgen]
pub struct ProjectSession {
    pub(crate) inner: Session<Timestamps>,
}
#[wasm_bindgen]
impl ProjectSession {
    pub fn begin_open(&mut self) -> Result<ProjectOpen, JsValue> {
        Ok(ProjectOpen {
            inner: self.inner.begin_open().map_err(document_error)?,
        })
    }
    pub fn is_open_current(&self, ticket: &ProjectOpen) -> bool {
        self.inner.is_open_current(&ticket.inner)
    }
    pub fn cancel_open(&mut self, ticket: &ProjectOpen) -> bool {
        self.inner.cancel_open(&ticket.inner)
    }
    pub fn finish_open(
        &mut self,
        ticket: &ProjectOpen,
        document: &mut ProjectDocument,
    ) -> Result<ProjectEffects, JsValue> {
        let document = document
            .inner
            .take()
            .ok_or_else(|| error("invalid_state"))?;
        Ok(ProjectEffects {
            events: self
                .inner
                .finish_open(&ticket.inner, document)
                .map_err(document_error)?,
        })
    }
    pub fn reset_document(
        &mut self,
        guard: &ProjectGuard,
        document: &mut ProjectDocument,
    ) -> Result<ProjectEffects, JsValue> {
        let document = document
            .inner
            .take()
            .ok_or_else(|| error("invalid_state"))?;
        Ok(ProjectEffects {
            events: self
                .inner
                .reset_document(&guard.inner, document)
                .map_err(document_error)?,
        })
    }
    pub fn configure_staging(&mut self, version: f64, options: &[f64]) -> Result<(), JsValue> {
        let v = staging::decode_pool(version, options).ok_or_else(|| error("invalid_options"))?;
        self.inner
            .configure_staging(StagingLimits {
                max_resources: v.resources,
                max_commands: v.commands,
                max_units: v.input_units as u64,
                max_asset_bytes: v.asset_bytes as u64,
            })
            .map_err(|e| {
                error(match e {
                    orcaxr_contracts::project_intent_types::SessionError::Busy => "busy",
                    orcaxr_contracts::project_intent_types::SessionError::Disposed => "disposed",
                    _ => "invalid_options",
                })
            })
    }
    pub fn staging_usage(&self) -> Vec<f64> {
        let v = self.inner.staging_usage();
        vec![
            v.resources as f64,
            v.commands as f64,
            v.units as f64,
            v.asset_bytes as f64,
        ]
    }
    pub fn command_upload(
        &self,
        guard: &ProjectGuard,
        version: f64,
        bytes: f64,
        options: &[f64],
    ) -> Result<ProjectCommandUpload, JsValue> {
        if !self.inner.is_current(&guard.inner) {
            return Err(error("stale"));
        }
        let options =
            staging::decode_input(version, options).ok_or_else(|| error("invalid_options"))?;
        CommandUpload::new(guard.inner.clone(), index(bytes)?, options)
            .map(|inner| ProjectCommandUpload { inner: Some(inner) })
            .map_err(|e| error(e.code()))
    }
    pub fn capture_clipboard(
        &self,
        guard: &ProjectGuard,
        node: &ProjectQueryNode,
        version: f64,
        options: &[f64],
    ) -> Result<ProjectClipboard, JsValue> {
        let options =
            staging::decode_clipboard(version, options).ok_or_else(|| error("invalid_options"))?;
        ClipboardCapture::from_query(&self.inner, &guard.inner, &node.inner, options)
            .map(|inner| ProjectClipboard { inner })
            .map_err(|e| error(e.code()))
    }
    pub fn clipboard_upload(
        &self,
        guard: &ProjectGuard,
        clipboard: &ProjectClipboard,
        version: f64,
        bytes: f64,
        options: &[f64],
    ) -> Result<ProjectCommandUpload, JsValue> {
        let options =
            staging::decode_input(version, options).ok_or_else(|| error("invalid_options"))?;
        CommandUpload::new_clipboard(
            &self.inner,
            guard.inner.clone(),
            clipboard.inner.data(),
            index(bytes)?,
            options,
        )
        .map(|inner| ProjectCommandUpload { inner: Some(inner) })
        .map_err(|e| error(e.code()))
    }
    pub fn stage_commands(&mut self, mut input: ProjectCommandUpload) -> Result<f64, JsValue> {
        input
            .inner
            .take()
            .ok_or_else(|| error("input_state"))?
            .admit(&mut self.inner)
            .map(|id| id as f64)
            .map_err(|e| error(e.code()))
    }
    pub fn release_staged(&mut self, id: f64) -> Result<bool, JsValue> {
        if !id.is_finite()
            || id.fract() != 0.0
            || !(1.0..=orcaxr_project::store::MAX_REVISION as f64).contains(&id)
        {
            return Err(error("invalid_range"));
        }
        Ok(self.inner.release_staged(id as u64))
    }
    pub fn submit(&mut self, request: &str) -> Option<ProjectReply> {
        match self.inner.submit(request) {
            Submission::Ready(reply) => Some(ProjectReply { reply }),
            Submission::Queued { .. } => None,
        }
    }
    pub fn run_next(&mut self) -> Option<ProjectReply> {
        self.inner.run_next().map(|reply| ProjectReply { reply })
    }
    pub fn pending_count(&self) -> usize {
        self.inner.pending_count()
    }
    pub fn dispose(&mut self) {
        self.inner.dispose()
    }
    pub fn is_disposed(&self) -> bool {
        self.inner.is_disposed()
    }
    pub fn snapshot(&self) -> CapturedProject {
        CapturedProject {
            inner: self.inner.snapshot(),
        }
    }
    pub fn selection(&self) -> CapturedSelection {
        CapturedSelection {
            inner: self.inner.selection(),
        }
    }
    pub fn history(&self) -> CapturedHistory {
        CapturedHistory {
            inner: self.inner.history(),
        }
    }
    pub fn history_revision(&self) -> f64 {
        self.inner.history_revision() as f64
    }
    /// A `CapabilityRequest` against the session's current state; returns a
    /// `CapabilityPage`.
    pub fn capabilities(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_capability_request(request).map_err(|_| error("invalid_request"))?;
        let page = orcaxr_project::capabilities::session_page(&self.inner, &request)
            .map_err(|refusal| error(refusal.code()))?;
        wire::encode_capability_page(&page).map_err(|_| error("output_limit"))
    }
    /// A `RenderRequest`: a page of the renderer deltas from the snapshot the
    /// host shows to the session's acknowledged one; returns a `RenderPage`.
    pub fn render(&mut self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request = wire::decode_render_request(request).map_err(|_| error("invalid_request"))?;
        let page = self
            .inner
            .render_page(&request)
            .map_err(|refusal| error(refusal.code()))?;
        wire::encode_render_page(&page).map_err(|_| error("output_limit"))
    }
    /// A `FacetRegionRequest` over the session's acknowledged state; returns a
    /// `FacetRegionReply`.
    pub fn facet_region(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_facet_region_request(request).map_err(|_| error("invalid_request"))?;
        let reply = orcaxr_project::facets::region_exchange::session_reply(&self.inner, &request)
            .map_err(|refusal| error(refusal.code()))?;
        wire::encode_facet_region_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// Open a paint stroke on the state `guard` captured: a `PaintStrokeOpen`.
    /// The stroke owns its mesh, so its samples never touch this session.
    pub fn paint_stroke(
        &self,
        guard: &ProjectGuard,
        request: &str,
    ) -> Result<ProjectPaintStroke, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_paint_stroke_open(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .paint_stroke(&guard.inner, &request)
            .map(|inner| ProjectPaintStroke { inner })
            .map_err(|refusal| error(refusal.code()))
    }
    /// Prepare one volume's split on the state `guard` captured: a
    /// `VolumeSplitRequest`. Its `reply` gives the parts or the refusal.
    pub fn volume_split(
        &self,
        guard: &ProjectGuard,
        request: &str,
    ) -> Result<ProjectVolumeSplit, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_volume_split_request(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .volume_split(&guard.inner, &request)
            .map(|inner| ProjectVolumeSplit { inner })
            .map_err(|value| error(session_error(value)))
    }
    /// Stage a prepared split under the host's names (a `VolumeSplitStage`)
    /// for `executeStaged`. A split whose state changed refuses `stale`.
    pub fn stage_volume_split(
        &mut self,
        split: &ProjectVolumeSplit,
        request: &str,
    ) -> Result<f64, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_volume_split_stage(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .stage_volume_split(&split.inner, &request)
            .map(|id| id as f64)
            .map_err(|value| error(session_error(value)))
    }
    /// Decimate one volume's mesh on the state `guard` captured: a
    /// `VolumeSimplifyRequest`. Its `reply` gives the summary, unchanged or
    /// the refusal, and `mesh` pages the result's bytes.
    pub fn volume_simplify(
        &self,
        guard: &ProjectGuard,
        request: &str,
    ) -> Result<ProjectVolumeSimplify, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_volume_simplify_request(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .volume_simplify(&guard.inner, &request)
            .map(|inner| ProjectVolumeSimplify { inner })
            .map_err(|value| error(session_error(value)))
    }
    /// Stage a prepared decimation under the host's asset ID (a
    /// `VolumeSimplifyStage`) for `executeStaged`. A run whose state changed
    /// refuses `stale`.
    pub fn stage_volume_simplify(
        &mut self,
        simplify: &ProjectVolumeSimplify,
        request: &str,
    ) -> Result<f64, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_volume_simplify_stage(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .stage_volume_simplify(&simplify.inner, &request)
            .map(|id| id as f64)
            .map_err(|value| error(session_error(value)))
    }
    /// One volume's features captured for measuring: a
    /// `MeasureVolumeRequest`. Its `reply` gives the counts or the refusal,
    /// and `feature` resolves picks off this session.
    pub fn measure_volume(&self, request: &str) -> Result<ProjectMeasureVolume, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_measure_volume_request(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .measure_volume(&request)
            .map(|inner| ProjectMeasureVolume { inner })
            .map_err(|value| error(session_error(value)))
    }
    /// The corners of one object's first layer an ear would hold down: a
    /// `BrimEarDetectRequest`; returns a `BrimEarDetectReply`.
    pub fn detect_brim_ears(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_brim_ear_detect_request(request).map_err(|_| error("invalid_request"))?;
        let reply = self
            .inner
            .detect_brim_ears(&request)
            .map_err(|_| error("disposed"))?;
        wire::encode_brim_ear_detect_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// One object's placed ears that reach nothing: a
    /// `BrimEarStrandedRequest`; returns a `BrimEarStrandedReply`.
    pub fn stranded_brim_ears(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request = wire::decode_brim_ear_stranded_request(request)
            .map_err(|_| error("invalid_request"))?;
        let reply = self
            .inner
            .stranded_brim_ears(&request)
            .map_err(|_| error("disposed"))?;
        wire::encode_brim_ear_stranded_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// Stage a prepared emboss cut (an `EmbossStage`) for `executeStaged`: a
    /// new text part under the host's IDs, or a re-cut of a text part.
    pub fn stage_emboss(&mut self, emboss: &ProjectEmboss, request: &str) -> Result<f64, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request = wire::decode_emboss_stage(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .stage_emboss(&emboss.inner, &request)
            .map(|id| id as f64)
            .map_err(|value| error(session_error(value)))
    }
    /// Stage a prepared SVG cut (an `SvgPartStage`) for `executeStaged`: a
    /// new part under the host's IDs, or a re-cut of an SVG part.
    pub fn stage_svg_part(&mut self, svg: &ProjectSvgPart, request: &str) -> Result<f64, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request = wire::decode_svg_part_stage(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .stage_svg_part(&svg.inner, &request)
            .map(|id| id as f64)
            .map_err(|value| error(session_error(value)))
    }
    /// The plate's wipe tower, auto-placed: a `WipeTowerRequest`; returns a
    /// `WipeTowerReply`.
    pub fn plan_wipe_tower(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_wipe_tower_request(request).map_err(|_| error("invalid_request"))?;
        let reply = self
            .inner
            .plan_wipe_tower(&request)
            .map_err(|_| error("disposed"))?;
        wire::encode_wipe_tower_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// One plate's arrangement: an `ArrangeRequest`; returns an `ArrangeReply`.
    pub fn plan_arrangement(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_arrange_request(request).map_err(|_| error("invalid_request"))?;
        let reply = self
            .inner
            .plan_arrangement(&request)
            .map_err(|_| error("disposed"))?;
        wire::encode_arrange_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// Copies of one instance in a plate's free space: a `BedFillRequest`;
    /// returns a `BedFillReply`.
    pub fn plan_bed_fill(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_bed_fill_request(request).map_err(|_| error("invalid_request"))?;
        let reply = self
            .inner
            .plan_bed_fill(&request)
            .map_err(|_| error("disposed"))?;
        wire::encode_bed_fill_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// The transforms one placement edit submits: a `PlacementRequest`;
    /// returns a `PlacementReply`.
    pub fn plan_placement(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_placement_request(request).map_err(|_| error("invalid_request"))?;
        let reply = self
            .inner
            .plan_placement(&request)
            .map_err(|_| error("disposed"))?;
        wire::encode_placement_reply(&reply).map_err(|_| error("output_limit"))
    }
    /// One plate's volumes captured for picking: a `PickSceneRequest`. The
    /// scene owns its meshes, so picks run off the session.
    pub fn pick_scene(&self, request: &str) -> Result<ProjectPickScene, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_pick_scene_request(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .pick_scene(&request)
            .map(|inner| ProjectPickScene { inner })
            .map_err(|refusal| error(refusal.code()))
    }
    /// The canonical paint overlay of one volume's channel: a
    /// `PaintOverlayRequest`. The capture owns its facets and packets.
    pub fn paint_overlay(&self, request: &str) -> Result<ProjectPaintOverlay, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_paint_overlay_request(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .paint_overlay(&request)
            .map(|inner| ProjectPaintOverlay { inner })
            .map_err(|refusal| error(refusal.code()))
    }
    /// Stage the stroke's whole gesture as one edit for `executeStaged`; 0
    /// when it touched no facet. A stroke whose state changed refuses `stale`.
    pub fn stage_paint_stroke(
        &mut self,
        stroke: &ProjectPaintStroke,
        label: Option<Vec<u16>>,
    ) -> Result<f64, JsValue> {
        use orcaxr_contracts::project_intent_types::SessionError;
        self.inner
            .stage_paint_stroke(&stroke.inner, label)
            .map(|id| id.map_or(0.0, |id| id as f64))
            .map_err(|value| {
                error(match value {
                    SessionError::Disposed => "disposed",
                    SessionError::Stale => "stale",
                    SessionError::ResourceLimit => "resource_limit",
                    _ => "invalid_request",
                })
            })
    }
    pub fn asset_fingerprint(&self) -> String {
        self.inner.assets().bundle_fingerprint().into()
    }
    pub fn asset(&self, position: f64) -> Result<ProjectAsset, JsValue> {
        let snapshot = self.inner.snapshot();
        let id = &snapshot
            .state()
            .source_assets
            .get(index(position)?)
            .ok_or_else(|| error("invalid_range"))?
            .id;
        self.inner
            .assets()
            .peek(id)
            .map(|inner| ProjectAsset { inner })
            .ok_or_else(|| error("missing_asset"))
    }
    pub fn capture_guard(&self) -> Result<ProjectGuard, JsValue> {
        self.inner
            .capture_guard()
            .map(|inner| ProjectGuard { inner })
            .map_err(|_| error("disposed"))
    }
    pub fn is_current(&self, guard: &ProjectGuard) -> bool {
        self.inner.is_current(&guard.inner)
    }
    pub fn is_export_current(&self, guard: &ProjectGuard) -> bool {
        self.inner.is_export_current(&guard.inner)
    }
    /// Freeze the project and its assets for an export or a live preflight.
    pub fn capture_export(&self, guard: &ProjectGuard) -> Result<ProjectExport, JsValue> {
        ExportCapture::new(&self.inner, &guard.inner)
            .map(|inner| ProjectExport { inner })
            .ok_or_else(|| error("stale"))
    }
    /// Call only after the host confirms successful save handoff. Merely reading
    /// or serializing a capture never clears dirty state.
    pub fn acknowledge_checkpoint(
        &mut self,
        guard: &ProjectGuard,
    ) -> Result<ProjectEffects, JsValue> {
        self.inner
            .acknowledge_checkpoint(&guard.inner)
            .map(|events| ProjectEffects { events })
            .map_err(|_| error("stale_or_disposed"))
    }
    pub fn select(
        &mut self,
        guard: &ProjectGuard,
        input: ProjectSelectionInput,
        primary: f64,
    ) -> Result<ProjectEffects, JsValue> {
        let primary = if primary == -1.0 {
            None
        } else {
            Some(
                input
                    .refs
                    .get(index(primary)?)
                    .ok_or_else(|| error("invalid_range"))?
                    .clone(),
            )
        };
        let change = self
            .inner
            .select(&guard.inner, &input.refs, primary)
            .map_err(|_| error("invalid_selection"))?;
        Ok(ProjectEffects {
            events: change.into_iter().map(DomainEvent::Selection).collect(),
        })
    }
}
#[wasm_bindgen]
pub struct ProjectGuard {
    pub(crate) inner: LocalGuard,
}

/// One paint gesture, opened on a session guard. Samples and overlay pages
/// run here, off the session; the session stages its commit.
#[wasm_bindgen]
pub struct ProjectPaintStroke {
    inner: orcaxr_project::facets::paint_stroke::PaintStroke,
}
#[wasm_bindgen]
impl ProjectPaintStroke {
    /// A `PaintStrokeSample`; returns a `PaintStrokeSampleReply`.
    pub fn sample(&mut self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_paint_stroke_sample(request).map_err(|_| error("invalid_request"))?;
        wire::encode_paint_stroke_sample_reply(&self.inner.sample(&request))
            .map_err(|_| error("output_limit"))
    }
    /// The stroke's live preview as an overlay capture.
    pub fn preview(&self) -> Result<ProjectPaintOverlay, JsValue> {
        self.inner
            .preview()
            .map(|inner| ProjectPaintOverlay { inner })
            .map_err(|refusal| error(refusal.code()))
    }
    /// A `PaintStrokeOverlayRequest`; returns a `PaintStrokeOverlay`.
    pub fn overlay(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request = wire::decode_paint_stroke_overlay_request(request)
            .map_err(|_| error("invalid_request"))?;
        let page = self
            .inner
            .overlay(&request)
            .map_err(|refusal| error(refusal.code()))?;
        wire::encode_paint_stroke_overlay(&page).map_err(|_| error("output_limit"))
    }
}

/// One volume's split, prepared on a session guard.
#[wasm_bindgen]
pub struct ProjectVolumeSplit {
    inner: orcaxr_project::split::VolumeSplit,
}
#[wasm_bindgen]
impl ProjectVolumeSplit {
    /// The `VolumeSplitReply`: the parts and geometries, or the refusal.
    pub fn reply(&self) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        wire::encode_volume_split_reply(&self.inner.reply()).map_err(|_| error("output_limit"))
    }
}
/// One volume's decimation, prepared on a session guard.
#[wasm_bindgen]
pub struct ProjectVolumeSimplify {
    inner: orcaxr_project::simplify::VolumeSimplify,
}
#[wasm_bindgen]
impl ProjectVolumeSimplify {
    /// The `VolumeSimplifyReply`: the summary, unchanged, or the refusal.
    pub fn reply(&self) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        wire::encode_volume_simplify_reply(&self.inner.reply()).map_err(|_| error("output_limit"))
    }
    /// Bytes `start..start + count` of the result's indexed-mesh payload.
    pub fn mesh(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        self.inner
            .mesh(index(start)? as u64, index(count)? as u64)
            .map(<[u8]>::to_vec)
            .map_err(|_| error("invalid_request"))
    }
}
/// One volume's features, captured for measuring.
#[wasm_bindgen]
pub struct ProjectMeasureVolume {
    inner: orcaxr_project::measure::MeasureVolume,
}
#[wasm_bindgen]
impl ProjectMeasureVolume {
    /// The `MeasureVolumeReply`: plane and facet counts, or the refusal.
    pub fn reply(&self) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        wire::encode_measure_volume_reply(&self.inner.reply()).map_err(|_| error("output_limit"))
    }
    /// A `MeasureFeatureRequest`; returns a `MeasureFeatureReply`.
    pub fn feature(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_measure_feature_request(request).map_err(|_| error("invalid_request"))?;
        wire::encode_measure_feature_reply(&self.inner.feature(&request))
            .map_err(|_| error("output_limit"))
    }
}
/// The workspace's measurement of two features: a `MeasureRequest`; returns
/// a `MeasureReply`.
#[wasm_bindgen]
pub fn measure_features(request: &str) -> Result<String, JsValue> {
    use orcaxr_contracts::project_intent_types as wire;
    if request.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    let request = wire::decode_measure_request(request).map_err(|_| error("invalid_request"))?;
    wire::encode_measure_reply(&orcaxr_project::measure::measure_wire(&request))
        .map_err(|_| error("output_limit"))
}
/// One emboss cut, prepared from a recipe and the host's glyph outlines.
#[wasm_bindgen]
pub struct ProjectEmboss {
    inner: orcaxr_project::emboss::PreparedEmboss,
}
#[wasm_bindgen]
impl ProjectEmboss {
    /// The `EmbossReply`: the cut's summary, or the refusal.
    pub fn reply(&self) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        wire::encode_emboss_reply(&self.inner.reply()).map_err(|_| error("output_limit"))
    }
    /// Bytes `start..start + count` of the cut's indexed-mesh payload.
    pub fn mesh(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        self.inner
            .mesh(index(start)? as u64, index(count)? as u64)
            .map(<[u8]>::to_vec)
            .map_err(|_| error("invalid_request"))
    }
}
/// Cut a recipe with the host's glyph outlines: an `EmbossRequest`.
#[wasm_bindgen]
pub fn prepare_emboss(request: &str) -> Result<ProjectEmboss, JsValue> {
    use orcaxr_contracts::project_intent_types as wire;
    if request.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    let request = wire::decode_emboss_request(request).map_err(|_| error("invalid_request"))?;
    Ok(ProjectEmboss {
        inner: orcaxr_project::emboss::prepare(&request),
    })
}
/// One SVG cut, prepared from a drawing's file bytes and a recipe.
#[wasm_bindgen]
pub struct ProjectSvgPart {
    inner: orcaxr_project::svg::PreparedSvgPart,
}
#[wasm_bindgen]
impl ProjectSvgPart {
    /// The `SvgPartReply`: the cut's summary, or the refusal.
    pub fn reply(&self) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        wire::encode_svg_part_reply(&self.inner.reply()).map_err(|_| error("output_limit"))
    }
    /// Bytes `start..start + count` of the cut's indexed-mesh payload.
    pub fn mesh(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        self.inner
            .mesh(index(start)? as u64, index(count)? as u64)
            .map(<[u8]>::to_vec)
            .map_err(|_| error("invalid_request"))
    }
}
/// Cut a drawing's file bytes with a recipe: an `SvgPartRequest`.
#[wasm_bindgen]
pub fn prepare_svg_part(request: &str, drawing: &[u8]) -> Result<ProjectSvgPart, JsValue> {
    use orcaxr_contracts::project_intent_types as wire;
    if request.len() > wire::MAX_BYTES || drawing.len() > orcaxr_project::svg::MAX_DRAWING_BYTES {
        return Err(error("input_limit"));
    }
    let request = wire::decode_svg_part_request(request).map_err(|_| error("invalid_request"))?;
    Ok(ProjectSvgPart {
        inner: orcaxr_project::svg::prepare(&request, drawing),
    })
}
fn session_error(value: orcaxr_contracts::project_intent_types::SessionError) -> &'static str {
    use orcaxr_contracts::project_intent_types::SessionError;
    match value {
        SessionError::Disposed => "disposed",
        SessionError::Stale => "stale",
        SessionError::ResourceLimit => "resource_limit",
        _ => "invalid_request",
    }
}

/// One plate captured for picking; build it again when the project changes.
#[wasm_bindgen]
pub struct ProjectPickScene {
    inner: orcaxr_project::picking::PickScene,
}
#[wasm_bindgen]
impl ProjectPickScene {
    /// A `PickRay` in printer space; returns a `PickReply`.
    pub fn pick(&self, ray: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if ray.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let ray = wire::decode_pick_ray(ray).map_err(|_| error("invalid_request"))?;
        wire::encode_pick_reply(&self.inner.pick(&ray)).map_err(|_| error("output_limit"))
    }
}

/// One paint overlay's facets: a `PaintOverlaySummary`, then packets of
/// 40-byte facets (nine little-endian float32 corners and a uint32 state).
#[wasm_bindgen]
pub struct ProjectPaintOverlay {
    inner: orcaxr_project::facets::overlay::Overlay,
}
#[wasm_bindgen]
impl ProjectPaintOverlay {
    pub fn summary(&self) -> Result<String, JsValue> {
        orcaxr_contracts::project_intent_types::encode_paint_overlay_summary(&self.inner.summary())
            .map_err(|_| error("output_limit"))
    }
    pub fn packet(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        self.inner
            .packet(index(start)? as u64, index(count)? as u64)
            .map_err(|refusal| error(refusal.code()))
    }
}

#[wasm_bindgen]
pub struct ProjectClipboard {
    inner: ClipboardCapture,
}
#[wasm_bindgen]
impl ProjectClipboard {
    /// Counts for allocating new editable IDs. Bytes and the source object stay
    /// inside native ownership; free this host handle when replacing the copy.
    pub fn info(&self) -> Vec<f64> {
        self.inner.info().to_vec()
    }
}

/// Explicit preparation owner. Cancellation drops parsed/sealed input and the
/// guard immediately; dropping/freeing the owner does the same. Use a separate
/// task for seal(). Session disposal invalidates admission, not captured input.
#[wasm_bindgen]
pub struct ProjectCommandUpload {
    inner: Option<CommandUpload>,
}
#[wasm_bindgen]
impl ProjectCommandUpload {
    pub fn append(&mut self, offset: f64, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("input_state"))?
            .append(index(offset)?, bytes)
            .map_err(|e| error(e.code()))
    }
    pub fn seal(&mut self) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("input_state"))?
            .seal()
            .map_err(|e| error(e.code()))
    }
    pub fn units(&self) -> Result<f64, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("input_state"))?
            .units()
            .map(|n| n as f64)
            .map_err(|e| error(e.code()))
    }
    pub fn command_count(&self) -> Result<usize, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("input_state"))?
            .command_count()
            .map_err(|e| error(e.code()))
    }
    /// Payload bytes the sealed work holds (each distinct payload once).
    pub fn asset_bytes(&self) -> Result<f64, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("input_state"))?
            .asset_bytes()
            .map(|n| n as f64)
            .map_err(|e| error(e.code()))
    }
    /// Payloads the sealed records declared, in first-declaration order.
    pub fn asset_count(&self) -> Result<usize, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("input_state"))?
            .asset_count()
            .map_err(|e| error(e.code()))
    }
    /// Start one declared payload; returns its exact byte length.
    pub fn begin_asset(&mut self, position: f64) -> Result<f64, JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("input_state"))?
            .begin_asset(index(position)?)
            .map(|n| n as f64)
            .map_err(|e| error(e.code()))
    }
    pub fn append_asset(&mut self, offset: f64, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("input_state"))?
            .append_asset(index(offset)?, bytes)
            .map_err(|e| error(e.code()))
    }
    /// Validates the payload; the last one prepares the work's commands.
    pub fn finish_asset(&mut self) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("input_state"))?
            .finish_asset()
            .map_err(|e| error(e.code()))
    }
    pub fn cancel_asset(&mut self) {
        if let Some(inner) = self.inner.as_mut() {
            inner.cancel_asset();
        }
    }
    pub fn cancel(&mut self) {
        self.inner = None;
    }
}
#[wasm_bindgen]
pub struct ProjectSelectionInput {
    refs: Vec<SelectionRef>,
    units: usize,
}
#[wasm_bindgen]
impl ProjectSelectionInput {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            refs: vec![],
            units: 0,
        }
    }
    pub fn add(&mut self, kind: f64, id: &[u16]) -> Result<(), JsValue> {
        if self.refs.len() == layout::MAX_SELECTION_REFS
            || id.len() > layout::MAX_SELECTION_TEXT_UNITS - self.units
        {
            return Err(error("input_limit"));
        }
        let bad = || error("invalid_selection");
        let r = match index(kind)? as u32 {
            layout::SELECT_PROJECT if id.is_empty() => SelectionRef::Project,
            layout::SELECT_PLATE => {
                SelectionRef::Plate(PlateId::try_from_utf16(id.to_vec()).map_err(|_| bad())?)
            }
            layout::SELECT_OBJECT => {
                SelectionRef::Object(ObjectId::try_from_utf16(id.to_vec()).map_err(|_| bad())?)
            }
            layout::SELECT_VOLUME => {
                SelectionRef::Volume(VolumeId::try_from_utf16(id.to_vec()).map_err(|_| bad())?)
            }
            layout::SELECT_INSTANCE => {
                SelectionRef::Instance(InstanceId::try_from_utf16(id.to_vec()).map_err(|_| bad())?)
            }
            layout::SELECT_LAYER_RANGE => SelectionRef::LayerRange(
                LayerRangeId::try_from_utf16(id.to_vec()).map_err(|_| bad())?,
            ),
            layout::SELECT_FILAMENT => {
                SelectionRef::Filament(FilamentId::try_from_utf16(id.to_vec()).map_err(|_| bad())?)
            }
            _ => return Err(bad()),
        };
        self.units += id.len();
        self.refs.push(r);
        Ok(())
    }
}
impl Default for ProjectSelectionInput {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub struct ProjectReply {
    reply: Response,
}
#[wasm_bindgen]
impl ProjectReply {
    pub fn wire(&self) -> String {
        self.reply.wire().into()
    }
    /// Consume the response to transfer all effects; retain their order even
    /// when the reply reports commandFailed after rollback.
    pub fn effects(self) -> ProjectEffects {
        ProjectEffects {
            events: self.reply.into_parts().1,
        }
    }
}
#[wasm_bindgen]
pub struct ProjectEffects {
    pub(crate) events: Vec<DomainEvent>,
}
impl ProjectEffects {
    fn event(&self, position: f64) -> Result<&DomainEvent, JsValue> {
        self.events
            .get(index(position)?)
            .ok_or_else(|| error("invalid_range"))
    }
}
#[wasm_bindgen]
impl ProjectEffects {
    pub fn count(&self) -> usize {
        self.events.len()
    }
    pub fn kind(&self, position: f64) -> Result<u32, JsValue> {
        Ok(match self.event(position)? {
            DomainEvent::Project(_) => layout::EFFECT_PROJECT,
            DomainEvent::Selection(_) => layout::EFFECT_SELECTION,
            DomainEvent::History { .. } => layout::EFFECT_HISTORY,
        })
    }
    pub fn project(&self, position: f64, previous: bool) -> Result<CapturedProject, JsValue> {
        let DomainEvent::Project(c) = self.event(position)? else {
            return Err(error("wrong_effect"));
        };
        Ok(CapturedProject {
            inner: if previous { c.previous() } else { c.current() }.clone(),
        })
    }
    pub fn selection(&self, position: f64, previous: bool) -> Result<CapturedSelection, JsValue> {
        let DomainEvent::Selection(c) = self.event(position)? else {
            return Err(error("wrong_effect"));
        };
        Ok(CapturedSelection {
            inner: if previous { c.previous() } else { c.current() }.clone(),
        })
    }
    pub fn history(&self, position: f64, previous: bool) -> Result<CapturedHistory, JsValue> {
        let DomainEvent::History {
            previous: a,
            current: b,
        } = self.event(position)?
        else {
            return Err(error("wrong_effect"));
        };
        Ok(CapturedHistory {
            inner: if previous { a } else { b }.clone(),
        })
    }
    pub fn reason_length(&self, position: f64) -> Result<usize, JsValue> {
        let DomainEvent::Project(c) = self.event(position)? else {
            return Err(error("wrong_effect"));
        };
        Ok(c.reason().units().len())
    }
    pub fn reason(&self, position: f64, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        let DomainEvent::Project(c) = self.event(position)? else {
            return Err(error("wrong_effect"));
        };
        text_read(c.reason().units(), start, count)
    }
    pub fn dirty_categories(&self, position: f64) -> Result<String, JsValue> {
        let DomainEvent::Project(c) = self.event(position)? else {
            return Err(error("wrong_effect"));
        };
        Ok(categories(c.dirty_categories()))
    }
}
fn categories(values: &[orcaxr_contracts::project_intent_types::DirtyCategory]) -> String {
    // Three fixed schema enum names; never private JSON or arbitrary strings.
    values
        .iter()
        .map(|v| match v {
            orcaxr_contracts::project_intent_types::DirtyCategory::ProjectData => "projectData",
            orcaxr_contracts::project_intent_types::DirtyCategory::Presets => "presets",
            orcaxr_contracts::project_intent_types::DirtyCategory::PrinterDevice => "printerDevice",
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[wasm_bindgen]
pub struct CapturedProject {
    inner: ProjectSnapshot,
}
#[wasm_bindgen]
impl CapturedProject {
    pub fn query(&self, version: f64) -> Result<ProjectQueryNode, JsValue> {
        if version != query::layout::VERSION as f64 {
            return Err(error("unsupported_version"));
        }
        Ok(ProjectQueryNode {
            inner: QueryNode::new(self.inner.clone()),
        })
    }
    pub fn revision(&self) -> f64 {
        self.inner.revision() as f64
    }
    pub fn hash(&self) -> String {
        self.inner.hash().into()
    }
    pub fn id_length(&self) -> usize {
        self.inner.state().id.as_utf16().len()
    }
    pub fn id(&self, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        text_read(self.inner.state().id.as_utf16(), start, count)
    }
    /// A `PaintPaletteRequest`; returns the project's `PaintPalette`.
    pub fn paint_palette(&self, request: &str) -> Result<String, JsValue> {
        use orcaxr_contracts::project_intent_types as wire;
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_paint_palette_request(request).map_err(|_| error("invalid_request"))?;
        let palette = orcaxr_project::facets::palette::project_palette(
            &self.inner.state().filaments,
            request.include_unavailable,
        );
        wire::encode_paint_palette(&orcaxr_project::facets::palette::wire_palette(&palette))
            .map_err(|_| error("output_limit"))
    }
    /// A `SettingsTargetPageRequest`; returns a `SettingsTargetPage`.
    pub fn settings_targets(&self, request: &str) -> Result<String, JsValue> {
        crate::editor::projection(&self.inner, crate::editor::Projection::Targets, request)
    }
    /// A `SettingsTargetRequest`; returns a `SettingsSnapshotResult`.
    pub fn settings_snapshot(&self, request: &str) -> Result<String, JsValue> {
        crate::editor::projection(&self.inner, crate::editor::Projection::Snapshot, request)
    }
    /// A `SettingsExplainRequest`; returns a `SettingsExplainResult`.
    pub fn settings_explain(&self, request: &str) -> Result<String, JsValue> {
        crate::editor::projection(&self.inner, crate::editor::Projection::Explain, request)
    }
    /// A `SettingsSessionRequest`: the settings editor for one node, whose
    /// commits become guarded project intents.
    pub fn settings_editor(
        &self,
        request: &str,
        collator: Option<crate::catalog::PresetCollator>,
        folder: Option<crate::editor::SearchFolder>,
    ) -> Result<crate::editor::SettingsEditor, JsValue> {
        crate::editor::open(&self.inner, request, collator, folder)
    }
    /// Explicit bulk export, not a per-edit projection. A hard caller-supplied
    /// output budget applies during writing. This synchronous operation must not
    /// run on a production authority worker until task isolation is provided.
    pub fn export_json(&self, max_bytes: f64) -> Result<ProjectBytes, JsValue> {
        let mut sink = LimitedBytes {
            bytes: vec![],
            limit: index(max_bytes)?,
        };
        self.inner
            .state()
            .write_json(&mut sink)
            .map_err(|_| error("output_limit"))?;
        Ok(ProjectBytes { bytes: sink.bytes })
    }
}
#[wasm_bindgen]
pub struct ProjectQueryNode {
    inner: QueryNode,
}
#[wasm_bindgen]
impl ProjectQueryNode {
    pub fn snapshot(&self) -> CapturedProject {
        CapturedProject {
            inner: self.inner.snapshot(),
        }
    }
    pub fn metadata(&self) -> Result<Vec<f64>, JsValue> {
        self.inner.metadata().map_err(error)
    }
    pub fn text_length(&self, field: f64) -> Result<f64, JsValue> {
        let field = query::layout::TextField::from_index(index(field)? as u32)
            .ok_or_else(|| error("invalid_field"))?;
        Ok(self
            .inner
            .text(field)
            .map_err(error)?
            .map_or(-1.0, |v| v.len() as f64))
    }
    pub fn text(&self, field: f64, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        let field = query::layout::TextField::from_index(index(field)? as u32)
            .ok_or_else(|| error("invalid_field"))?;
        self.inner
            .read_text(field, index(start)?, index(count)?)
            .map_err(error)
    }
    pub fn children(
        &self,
        relation: f64,
        max_sort_entries: f64,
    ) -> Result<ProjectQueryList, JsValue> {
        let relation = query::layout::Relation::from_index(index(relation)? as u32)
            .ok_or_else(|| error("invalid_relation"))?;
        Ok(ProjectQueryList {
            inner: self
                .inner
                .children(relation, index(max_sort_entries)?)
                .map_err(error)?,
        })
    }
}
#[wasm_bindgen]
pub struct ProjectQueryList {
    inner: QueryList,
}
#[wasm_bindgen]
impl ProjectQueryList {
    pub fn snapshot(&self) -> CapturedProject {
        CapturedProject {
            inner: self.inner.snapshot(),
        }
    }
    pub fn count(&self) -> usize {
        self.inner.len()
    }
    pub fn node(&self, position: f64) -> Result<ProjectQueryNode, JsValue> {
        Ok(ProjectQueryNode {
            inner: self.inner.node(index(position)?).map_err(error)?,
        })
    }
    pub fn page(&self, start: f64, count: f64) -> Result<Vec<f64>, JsValue> {
        self.inner.page(index(start)?, index(count)?).map_err(error)
    }
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
#[wasm_bindgen]
pub struct ProjectBytes {
    bytes: Vec<u8>,
}
#[wasm_bindgen]
impl ProjectBytes {
    pub fn length(&self) -> usize {
        self.bytes.len()
    }
    pub fn read(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        Ok(self.bytes[range(start, count, self.bytes.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    }
}
#[wasm_bindgen]
pub struct ProjectAsset {
    inner: AssetLease,
}
#[wasm_bindgen]
impl ProjectAsset {
    pub fn length(&self) -> usize {
        self.inner.bytes().len()
    }
    pub fn digest(&self) -> String {
        self.inner.content_digest().into()
    }
    pub fn read(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        Ok(self.inner.bytes()[range(
            start,
            count,
            self.inner.bytes().len(),
            layout::MAX_CHUNK_BYTES,
        )?]
        .to_vec())
    }
    pub fn metadata(&self, max_bytes: f64) -> Result<ProjectBytes, JsValue> {
        let mut sink = LimitedBytes {
            bytes: vec![],
            limit: index(max_bytes)?,
        };
        self.inner
            .descriptor()
            .write_canonical(&mut sink)
            .map_err(|_| error("output_limit"))?;
        Ok(ProjectBytes { bytes: sink.bytes })
    }
}
fn selected(r: &SelectionRef) -> (u32, &[u16]) {
    match r {
        SelectionRef::Project => (layout::SELECT_PROJECT, &[]),
        SelectionRef::Plate(id) => (layout::SELECT_PLATE, id.as_utf16()),
        SelectionRef::Object(id) => (layout::SELECT_OBJECT, id.as_utf16()),
        SelectionRef::Volume(id) => (layout::SELECT_VOLUME, id.as_utf16()),
        SelectionRef::Instance(id) => (layout::SELECT_INSTANCE, id.as_utf16()),
        SelectionRef::LayerRange(id) => (layout::SELECT_LAYER_RANGE, id.as_utf16()),
        SelectionRef::Filament(id) => (layout::SELECT_FILAMENT, id.as_utf16()),
    }
}
#[wasm_bindgen]
pub struct CapturedSelection {
    inner: SelectionSnapshot,
}
impl CapturedSelection {
    fn item(&self, position: f64) -> Result<&SelectionRef, JsValue> {
        self.inner
            .refs()
            .get(index(position)?)
            .ok_or_else(|| error("invalid_range"))
    }
}
#[wasm_bindgen]
impl CapturedSelection {
    pub fn count(&self) -> usize {
        self.inner.refs().len()
    }
    pub fn primary_index(&self) -> f64 {
        self.inner
            .primary()
            .and_then(|r| self.inner.refs().iter().position(|v| v == r))
            .map_or(-1.0, |i| i as f64)
    }
    pub fn kind(&self, position: f64) -> Result<u32, JsValue> {
        Ok(selected(self.item(position)?).0)
    }
    pub fn id_length(&self, position: f64) -> Result<usize, JsValue> {
        Ok(selected(self.item(position)?).1.len())
    }
    pub fn id(&self, position: f64, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        text_read(selected(self.item(position)?).1, start, count)
    }
}
#[wasm_bindgen]
pub struct CapturedHistory {
    inner: HistorySnapshot,
}
impl CapturedHistory {
    fn label(&self, undo: bool) -> Option<&Text> {
        if undo {
            self.inner.undo_label.as_ref()
        } else {
            self.inner.redo_label.as_ref()
        }
    }
}
#[wasm_bindgen]
impl CapturedHistory {
    pub fn undo_count(&self) -> usize {
        self.inner.undo_count
    }
    pub fn redo_count(&self) -> usize {
        self.inner.redo_count
    }
    pub fn has_label(&self, undo: bool) -> bool {
        self.label(undo).is_some()
    }
    pub fn label_length(&self, undo: bool) -> usize {
        self.label(undo).map_or(0, |v| v.units().len())
    }
    pub fn label_text(&self, undo: bool, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        text_read(
            self.label(undo)
                .ok_or_else(|| error("missing_label"))?
                .units(),
            start,
            count,
        )
    }
    pub fn dirty_categories(&self) -> String {
        categories(&self.inner.dirty_categories)
    }
}

#[wasm_bindgen]
pub struct ProjectExport {
    inner: ExportCapture,
}
#[wasm_bindgen]
impl ProjectExport {
    /// Live slice preflight of exactly this frozen bundle from a contract
    /// `PreflightRequest`. Synchronous; run it on a worker.
    pub fn preflight(&self, request: &str) -> Result<ProjectPreflight, JsValue> {
        if request.len() > wire::MAX_BYTES {
            return Err(error("input_limit"));
        }
        let request =
            wire::decode_preflight_request(request).map_err(|_| error("invalid_request"))?;
        self.inner
            .preflight(&request, || false)
            .map(|inner| ProjectPreflight { inner })
            .map_err(|e| error(&e.to_string()))
    }
}
/// One live preflight result, read item by item as contract JSON.
#[wasm_bindgen]
pub struct ProjectPreflight {
    inner: Report,
}
fn contract<T>(
    value: Option<T>,
    encode: fn(&T) -> Result<String, orcaxr_contracts::project_intents::InvalidIntent>,
) -> Result<String, JsValue> {
    encode(&value.ok_or_else(|| error("invalid_range"))?).map_err(|_| error("output_limit"))
}
#[wasm_bindgen]
impl ProjectPreflight {
    pub fn summary(&self) -> Result<String, JsValue> {
        contract(Some(self.inner.summary()), wire::encode_preflight_summary)
    }
    pub fn issue(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.issue(index(position)?),
            wire::encode_preflight_issue,
        )
    }
    pub fn omission(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.omission(index(position)?),
            wire::encode_preflight_omission,
        )
    }
    pub fn printable_instance(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.printable_instance(index(position)?),
            wire::encode_preflight_entity,
        )
    }
    pub fn used_filament(&self, position: f64) -> Result<String, JsValue> {
        contract(
            self.inner.used_filament(index(position)?),
            wire::encode_preflight_entity,
        )
    }
}
