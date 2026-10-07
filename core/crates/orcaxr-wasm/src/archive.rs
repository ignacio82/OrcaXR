//! Archive Open and Save for an owned project worker. Open stages exact archive
//! bytes, then `prepare` completes canonical or foreign import privately and
//! returns a document for the session's guarded `finish_open`/`reset_document`.
//! Save writes the session's current immutable capture into an owned output with
//! its own checkpoint guard; only a confirmed host handoff may acknowledge it.
//! Both are synchronous: run them on the host's owned import/export task.
use crate::project::{
    ProjectDocument, ProjectGuard, ProjectSession, Timestamps, error, index, range, timestamps,
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
    /// The checkpoint guard of the written capture, taken once. Acknowledge it
    /// only after the host confirms the save handoff.
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
