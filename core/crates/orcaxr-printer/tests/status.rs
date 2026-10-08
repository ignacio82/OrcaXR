//! The print job status model against the production browser
//! (`print-job-status-vectors.mjs`): every query, patch and reset of every
//! trace answers as the browser answered, and leaves the same snapshot.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::status::JobStatus;
use serde_json::Value as Json;

#[test]
fn print_job_status_follows_the_browser() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/print-job-status-vectors.json"
    ))
    .unwrap();
    let (mut snapshots, mut ignored, mut refused) = (0, 0, 0);
    for trace in corpus["traces"].as_array().unwrap() {
        let name = trace["name"].as_str().unwrap();
        let mut model = JobStatus::new();
        for (i, step) in trace["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {i}");
            let text = step["text"].as_str().unwrap_or("");
            let now = step["nowMs"].as_f64().unwrap_or(0.0);
            let reply = match step["op"].as_str().unwrap() {
                "reset" => Ok(Some(model.reset().clone())),
                "query" => model.apply_query(text, now).map(|s| Some(s.clone())),
                "notify" => model.apply_notification(text, now).map(|s| s.cloned()),
                op => panic!("unknown op {op}"),
            };
            match reply {
                Ok(Some(snapshot)) => {
                    assert_eq!(
                        wire::encode_print_job_snapshot(&snapshot).unwrap(),
                        step["snapshotJson"].as_str().unwrap(),
                        "{label}"
                    );
                    snapshots += 1;
                }
                Ok(None) => {
                    assert_eq!(step["ignored"], Json::Bool(true), "{label}");
                    ignored += 1;
                }
                Err(refusal) => {
                    assert_eq!(refusal.code(), step["refusal"].as_str().unwrap(), "{label}");
                    refused += 1;
                }
            }
            assert_eq!(
                wire::encode_print_job_snapshot(model.snapshot()).unwrap(),
                step["currentJson"].as_str().unwrap(),
                "{label} afterwards"
            );
        }
    }
    assert_eq!((snapshots, ignored, refused), (790, 76, 7));
}
