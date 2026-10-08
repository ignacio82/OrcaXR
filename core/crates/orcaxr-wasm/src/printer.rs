//! Printer workflow policy (`orcaxr_printer`) for browser hosts.
use crate::project::error;
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::status::JobStatus;
use wasm_bindgen::prelude::*;

fn encoded(snapshot: &wire::PrintJobSnapshot) -> Result<String, JsValue> {
    wire::encode_print_job_snapshot(snapshot).map_err(|_| error("output_limit"))
}

/// The print job status model: fed `/printer/objects/query` results and
/// `notify_status_update` params as received, it answers `PrintJobSnapshot`s.
#[wasm_bindgen]
#[derive(Default)]
pub struct PrintJobStatus {
    inner: JobStatus,
}
#[wasm_bindgen]
impl PrintJobStatus {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn apply_query(&mut self, text: &str, now_ms: f64) -> Result<String, JsValue> {
        let next = self
            .inner
            .apply_query(text, now_ms)
            .map_err(|e| error(e.code()))?;
        encoded(next)
    }
    /// `undefined` when the patch concerns no object the model reads.
    pub fn apply_notification(
        &mut self,
        text: &str,
        now_ms: f64,
    ) -> Result<Option<String>, JsValue> {
        match self.inner.apply_notification(text, now_ms) {
            Ok(Some(next)) => encoded(next).map(Some),
            Ok(None) => Ok(None),
            Err(refusal) => Err(error(refusal.code())),
        }
    }
    pub fn reset(&mut self) -> Result<String, JsValue> {
        encoded(self.inner.reset())
    }
    pub fn snapshot(&self) -> Result<String, JsValue> {
        encoded(self.inner.snapshot())
    }
}
