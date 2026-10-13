//! Archive Open and Save for an owned project worker. Open stages exact archive
//! bytes, then `prepare` completes canonical or foreign import privately and
//! returns a document for the session's guarded `finish_open`/`reset_document`.
//! Save writes the session's current immutable capture into an owned output with
//! its own checkpoint guard; only a confirmed host handoff may acknowledge it.
//! Both are synchronous: run them on the host's owned import/export task.
use crate::project::{
    ProjectDocument, ProjectExport, ProjectGuard, ProjectSession, Timestamps, error, index, range,
    timestamps,
};
use orcaxr_archive::{
    Archive,
    archive_layout::{self as layout, ArchiveOptions, decode_options},
    open, package,
    policy::{Policy, archive_code, open_code, save_code},
    staged::ArchiveInput,
    text,
};
use orcaxr_project::{host_layout, session::PreparedDocument};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

fn options(version: f64, input: &[f64]) -> Result<ArchiveOptions, JsValue> {
    decode_options(version, input).ok_or_else(|| error("invalid_options"))
}
#[wasm_bindgen]
pub struct ProjectArchiveUpload {
    input: ArchiveInput,
    policy: Policy,
}
#[wasm_bindgen]
impl ProjectArchiveUpload {
    /// `archive_bytes` is the exact length, reserved up front after checking it
    /// against the policy; omit it for open-ended input bounded by the policy.
    #[wasm_bindgen(constructor)]
    pub fn new(
        version: f64,
        archive_bytes: Option<f64>,
        policy: &[f64],
    ) -> Result<ProjectArchiveUpload, JsValue> {
        let policy = Policy::new(options(version, policy)?);
        let expected = archive_bytes.map(index).transpose()?;
        Ok(Self {
            input: ArchiveInput::new(expected, &policy).map_err(error)?,
            policy,
        })
    }
    /// Offsets make retries and out-of-order delivery explicit; a refused
    /// chunk is not consumed.
    pub fn append(&mut self, offset: f64, chunk: &[u8]) -> Result<(), JsValue> {
        self.input.append(index(offset)?, chunk).map_err(error)
    }
    /// Consumes the upload on every outcome. Completes import privately: no
    /// session state changes until the host adopts the returned document.
    pub fn prepare(self) -> Result<ProjectArchiveImport, JsValue> {
        let bytes = self.input.finish().map_err(error)?;
        // Bounded, redacted codes shared with JNI; no archive path, name or
        // content escapes.
        let archive = Archive::open(Cursor::new(bytes), self.policy.zip(), || false)
            .map_err(|e| error(archive_code(e)))?;
        let format = match open::format(&archive) {
            open::Format::Canonical => layout::FORMAT_CANONICAL,
            open::Format::Foreign => layout::FORMAT_FOREIGN,
        };
        let mut policy = timestamps as Timestamps;
        let completed = open::open(archive, self.policy.open(), &mut policy, || false)
            .map_err(|e| error(open_code(&e)))?;
        let warnings = text::import_warnings(completed.project().state(), completed.warnings());
        let (document, _) = completed
            .into_prepared()
            .map_err(|_| error("invalid_bundle"))?;
        Ok(ProjectArchiveImport {
            document: Some(document),
            format,
            warnings,
        })
    }
}

#[wasm_bindgen]
pub struct ProjectArchiveImport {
    document: Option<PreparedDocument>,
    format: u32,
    warnings: Vec<Vec<u16>>,
}
#[wasm_bindgen]
impl ProjectArchiveImport {
    /// `FORMAT_CANONICAL` or `FORMAT_FOREIGN` from the generated layout.
    pub fn format(&self) -> u32 {
        self.format
    }
    /// The browser's sorted, unique warning texts.
    pub fn warning_count(&self) -> usize {
        self.warnings.len()
    }
    pub fn warning_length(&self, position: f64) -> Result<usize, JsValue> {
        self.warnings
            .get(index(position)?)
            .map(Vec::len)
            .ok_or_else(|| error("invalid_range"))
    }
    /// Bounded UTF-16 reads; lone surrogates survive.
    pub fn warning(&self, position: f64, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        let text = self
            .warnings
            .get(index(position)?)
            .ok_or_else(|| error("invalid_range"))?;
        Ok(text[range(start, count, text.len(), host_layout::MAX_TEXT_CHUNK_UNITS)?].to_vec())
    }
    /// Takes the prepared document once for guarded adoption.
    pub fn document(&mut self) -> Result<ProjectDocument, JsValue> {
        let document = self.document.take().ok_or_else(|| error("invalid_state"))?;
        Ok(ProjectDocument {
            inner: Some(document),
        })
    }
}

#[wasm_bindgen]
pub struct ProjectArchiveOutput {
    bytes: Vec<u8>,
    warnings: Vec<Vec<u16>>,
    guard: Option<ProjectGuard>,
}
#[wasm_bindgen]
impl ProjectArchiveOutput {
    pub fn length(&self) -> f64 {
        self.bytes.len() as f64
    }
    /// Copies one bounded chunk into host-owned memory.
    pub fn read(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        Ok(self.bytes[range(start, count, self.bytes.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    }
    pub fn warning_count(&self) -> usize {
        self.warnings.len()
    }
    pub fn warning_length(&self, position: f64) -> Result<usize, JsValue> {
        self.warnings
            .get(index(position)?)
            .map(Vec::len)
            .ok_or_else(|| error("invalid_range"))
    }
    pub fn warning(&self, position: f64, start: f64, count: f64) -> Result<Vec<u16>, JsValue> {
        let text = self
            .warnings
            .get(index(position)?)
            .ok_or_else(|| error("invalid_range"))?;
        Ok(text[range(start, count, text.len(), host_layout::MAX_TEXT_CHUNK_UNITS)?].to_vec())
    }
    /// The checkpoint guard of the written capture, taken once; an export
    /// capture's archive has none. Acknowledge it only after the host confirms
    /// the save handoff.
    pub fn guard(&mut self) -> Result<ProjectGuard, JsValue> {
        self.guard.take().ok_or_else(|| error("invalid_state"))
    }
}

#[wasm_bindgen]
impl ProjectSession {
    /// Write the current immutable capture as a complete 3MF package. The guard
    /// is captured with the same snapshot; writing never changes dirty state.
    pub fn write_archive(
        &self,
        version: f64,
        policy: &[f64],
    ) -> Result<ProjectArchiveOutput, JsValue> {
        let policy = Policy::new(options(version, policy)?);
        let guard = self.inner.capture_guard().map_err(|_| error("disposed"))?;
        let capture = self.inner.snapshot();
        let assets = capture
            .state()
            .source_assets
            .iter()
            .map(|d| self.inner.assets().peek(&d.id))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| error("missing_asset"))?;
        let mut output = Cursor::new(Vec::new());
        let receipt = package::write(
            capture.project(),
            assets,
            &mut output,
            policy.package(),
            || false,
        )
        .map_err(|e| error(save_code(e)))?;
        let warnings = text::package_warnings(capture.state(), &receipt.warnings);
        Ok(ProjectArchiveOutput {
            bytes: output.into_inner(),
            warnings,
            guard: Some(ProjectGuard { inner: guard }),
        })
    }
}

/// A file the File menu exports, and what the menu says of it.
#[wasm_bindgen]
pub struct ProjectFileOutput {
    reply: String,
    bytes: Vec<u8>,
}
#[wasm_bindgen]
impl ProjectFileOutput {
    /// The exchange's reply: what was written, or the browser's refusal.
    pub fn reply(&self) -> String {
        self.reply.clone()
    }
    pub fn length(&self) -> f64 {
        self.bytes.len() as f64
    }
    /// Copies one bounded chunk into host-owned memory.
    pub fn read(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        Ok(self.bytes[range(start, count, self.bytes.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    }
}

/// The name an output is offered under (`exportNameExchange`): `{"kind","name"}` → `{"filename"}`.
#[wasm_bindgen]
pub fn export_name(request: &str) -> Result<String, JsValue> {
    orcaxr_archive::exports::export_name_json(request).map_err(error)
}

/// File → Export Diagnostics… (`diagnosticsBundleExchange`):
/// `{"includeModelNames","input"}` → `{"description","file","logEntries"}`.
#[wasm_bindgen]
pub fn diagnostics_bundle(request: &str) -> Result<String, JsValue> {
    orcaxr_printer::diagnostics::bundle_json(request).map_err(error)
}

/// A recorded event (`diagnosticEntryExchange`):
/// `{"atMs","level","message","scope","secrets"}` → the entry kept.
#[wasm_bindgen]
pub fn diagnostic_entry(request: &str) -> Result<String, JsValue> {
    orcaxr_printer::diagnostics::entry_json(request).map_err(error)
}

/// What a bundle states of the catalogue and the engine (`diagnosticsFactsExchange`).
#[wasm_bindgen]
pub fn diagnostics_facts() -> String {
    orcaxr_printer::diagnostics::facts_json()
}

#[wasm_bindgen]
impl ProjectExport {
    /// The pictures this capture's project asks for (its `thumbnails`),
    /// drawn from its active plate — a plate capture's only one — by the
    /// shared core (`orcaxr_archive::thumbnail`), each as the G-code block
    /// that carries it: `{"problems","thumbnails":[{"block","coverage",
    /// "format","height","width"}]}`. Synchronous; run it on a worker.
    pub fn thumbnails(&self) -> Result<String, JsValue> {
        orcaxr_archive::thumbnail::capture_json(&self.inner).map_err(|e| error(e.code()))
    }
    /// File → Export as one STL… or Export all objects as STLs… of this
    /// capture (`stlExportExchange`): `{"archive","selectedInstanceIds"}` →
    /// the reply and the file, byte for byte the browser's. Synchronous; run
    /// it on a worker.
    /// Export as 3MF… of this capture under the archive policy: the
    /// browser's own package (its serializer's Save, byte for byte) and the
    /// reply, or the refusal with no bytes. Synchronous; run it on a worker.
    pub fn project_archive_export(
        &self,
        version: f64,
        policy: &[f64],
    ) -> Result<ProjectFileOutput, JsValue> {
        let policy = Policy::new(options(version, policy)?);
        let mut bytes = Vec::new();
        let reply = orcaxr_archive::exports::project_archive_json(
            &self.inner,
            policy.package(),
            &mut bytes,
        )
        .map_err(|e| error(save_code(e)))?;
        Ok(ProjectFileOutput { reply, bytes })
    }
    /// Export Diagnostics…'s shape of this capture's project
    /// (`diagnosticsProjectSummaryOf`): counts and object names, never geometry.
    pub fn diagnostics_summary(&self) -> String {
        orcaxr_archive::exports::diagnostics_summary_json(self.inner.project().state())
    }
    pub fn stl_export(&self, request: &str) -> Result<ProjectFileOutput, JsValue> {
        let mut bytes = Vec::new();
        let reply = orcaxr_archive::exports::stl_export_json(&self.inner, request, &mut bytes)
            .map_err(error)?;
        Ok(ProjectFileOutput { reply, bytes })
    }
    /// Write this frozen capture — a plate's, for an external slicer — as a
    /// complete 3MF package. It carries no checkpoint guard: an export is
    /// never a save.
    pub fn write_archive(
        &self,
        version: f64,
        policy: &[f64],
    ) -> Result<ProjectArchiveOutput, JsValue> {
        let policy = Policy::new(options(version, policy)?);
        let capture = &self.inner;
        let assets = (0..capture.asset_count())
            .map(|i| capture.asset(i))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| error("missing_asset"))?;
        let mut output = Cursor::new(Vec::new());
        let receipt = package::write(
            capture.project().project(),
            assets,
            &mut output,
            policy.package(),
            || false,
        )
        .map_err(|e| error(save_code(e)))?;
        let warnings = text::package_warnings(capture.project().state(), &receipt.warnings);
        Ok(ProjectArchiveOutput {
            bytes: output.into_inner(),
            warnings,
            guard: None,
        })
    }
}
