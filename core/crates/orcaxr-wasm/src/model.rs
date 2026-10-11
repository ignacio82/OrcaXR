//! Model import for an owned project worker: stage source bytes, capture the
//! base from the session, prepare the browser's preview privately, then commit
//! with the operator's acknowledgements as one undoable `Import <filename>`.
//! Preparation is synchronous: run it on the host's owned import task.
use crate::project::{ProjectEffects, ProjectSession, Timestamps, error, index, range, timestamps};
use orcaxr_archive::{
    models::{
        Limits,
        host::{self, Base, Ids, Request},
        layout::{self, decode_options},
        stage::Placement,
    },
    staged::ArchiveInput,
};
use orcaxr_project::{
    import::{ConfirmError, Prepared},
    session::ImportCommitError,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct ProjectModelUpload {
    input: ArchiveInput,
    limits: Limits,
}
#[wasm_bindgen]
impl ProjectModelUpload {
    /// `model_bytes` is the exact length, or omitted for open-ended input; the
    /// generated options are the browser's model import limits.
    #[wasm_bindgen(constructor)]
    pub fn new(
        version: f64,
        model_bytes: Option<f64>,
        options: &[f64],
    ) -> Result<ProjectModelUpload, JsValue> {
        let limits = decode_options(version, options).ok_or_else(|| error("invalid_options"))?;
        let expected = model_bytes.map(index).transpose()?;
        Ok(Self {
            input: ArchiveInput::bounded(expected, limits.max_bytes).map_err(error)?,
            limits,
        })
    }
    pub fn append(&mut self, offset: f64, chunk: &[u8]) -> Result<(), JsValue> {
        if chunk.len() > layout::MAX_CHUNK_BYTES {
            return Err(error("input_limit"));
        }
        self.input.append(index(offset)?, chunk).map_err(error)
    }
}

/// The base an import is prepared against: guard, snapshot and asset copies.
#[wasm_bindgen]
pub struct ProjectImportBase {
    base: Base,
}
#[wasm_bindgen]
impl ProjectImportBase {
    /// Consumes the upload on every outcome. `bed` is empty or the printable
    /// area `[x_min, y_min, x_max, y_max]` in printer millimetres. Production IDs come from a 32-byte random `id_seed`;
    /// `id_namespace` selects deterministic `import:<namespace>:<kind>-<n>` IDs.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_model(
        &self,
        upload: ProjectModelUpload,
        filename: &[u16],
        imported_at: &[u16],
        bed: &[f64],
        drop_to_bed: bool,
        id_seed: &[u8],
        id_namespace: Option<String>,
    ) -> Result<ProjectImportPreview, JsValue> {
        let bytes = upload.input.finish().map_err(error)?;
        let placement = Placement {
            // The printable area `[x_min, y_min, x_max, y_max]`, or none.
            bed_area_mm: match bed {
                [] => None,
                [x_min, y_min, x_max, y_max] if bed.iter().all(|v| v.is_finite()) => {
                    Some([*x_min, *y_min, *x_max, *y_max])
                }
                _ => return Err(error("invalid_options")),
            },
            drop_to_bed,
        };
        let ids = match (id_namespace, id_seed) {
            (Some(namespace), []) => Ids::Counter(namespace),
            (None, seed) if seed.len() == 32 => {
                let word = |i: usize| {
                    u64::from_le_bytes(seed[i * 8..i * 8 + 8].try_into().expect("eight bytes"))
                };
                Ids::Uuid([word(0), word(1), word(2), word(3)])
            }
            _ => return Err(error("invalid_options")),
        };
        let request = Request {
            filename: filename.to_vec(),
            imported_at: imported_at.to_vec(),
            placement,
            ids,
        };
        let mut policy = timestamps as Timestamps;
        let prepared = host::prepare(
            &bytes,
            &request,
            &upload.limits,
            &self.base,
            &mut policy,
            || false,
        )
        .map_err(|e| error(&e.code()))?;
        let mut json = Vec::new();
        prepared
            .preview
            .write_canonical(&mut json)
            .map_err(|_| error("encoding"))?;
        Ok(ProjectImportPreview {
            json,
            prepared: Some(prepared),
            guard: self.base.guard.clone(),
        })
    }
}

/// The browser's preview (canonical JSON, bounded reads) and its commit token.
#[wasm_bindgen]
pub struct ProjectImportPreview {
    json: Vec<u8>,
    prepared: Option<Prepared>,
    guard: orcaxr_project::session::LocalGuard,
}
#[wasm_bindgen]
impl ProjectImportPreview {
    pub fn length(&self) -> f64 {
        self.json.len() as f64
    }
    pub fn read(&self, start: f64, count: f64) -> Result<Vec<u8>, JsValue> {
        Ok(self.json[range(start, count, self.json.len(), layout::MAX_CHUNK_BYTES)?].to_vec())
    }
    pub fn blocked(&self) -> Result<bool, JsValue> {
        Ok(self
            .prepared
            .as_ref()
            .ok_or_else(|| error("invalid_state"))?
            .is_blocked())
    }
}

fn commit_error(e: ImportCommitError) -> JsValue {
    error(match e {
        ImportCommitError::Disposed => "disposed",
        ImportCommitError::Confirmation(ConfirmError::Blocked) => "import_blocked",
        ImportCommitError::Confirmation(ConfirmError::Missing(_)) => "missing_acknowledgements",
        ImportCommitError::Confirmation(ConfirmError::Stale) => "stale",
    })
}

#[wasm_bindgen]
impl ProjectSession {
    pub fn capture_import_base(&self) -> Result<ProjectImportBase, JsValue> {
        Ok(ProjectImportBase {
            base: Base::capture(&self.inner).map_err(|_| error("disposed"))?,
        })
    }
    /// Dispatch the returned effects before reporting success. A refused
    /// confirmation changes nothing and keeps the candidate for a retry; any
    /// later outcome consumes it.
    pub fn commit_import(
        &mut self,
        preview: &mut ProjectImportPreview,
        acknowledged: Vec<String>,
    ) -> Result<ProjectEffects, JsValue> {
        let acknowledged: Vec<Vec<u16>> = acknowledged
            .iter()
            .map(|id| id.encode_utf16().collect())
            .collect();
        // A refused confirmation keeps the candidate, so the operator can retry.
        let current = self.inner.is_export_current(&preview.guard);
        orcaxr_project::import::check_confirmation(
            preview
                .prepared
                .as_ref()
                .ok_or_else(|| error("invalid_state"))?,
            &acknowledged,
            current,
        )
        .map_err(|e| commit_error(ImportCommitError::Confirmation(e)))?;
        let prepared = preview
            .prepared
            .take()
            .ok_or_else(|| error("invalid_state"))?;
        let outcome = self
            .inner
            .commit_import(&preview.guard, prepared, &acknowledged)
            .map_err(commit_error)?;
        match outcome.result {
            Ok(_) => Ok(ProjectEffects {
                events: outcome.events,
            }),
            Err(_) => Err(error("import_failed")),
        }
    }
}
