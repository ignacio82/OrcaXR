mod common;
use common::*;
use orcaxr_gcode::{Cancellation, preview::*};
use serde_json::Value;

fn request(value: &Value) -> PreviewRequest {
    let mut saved = value.clone();
    saved.as_object_mut().unwrap().remove("layerTimes");
    let mut request: PreviewRequest = read(&saved);
    if let Some(times) = value.get("layerTimes") {
        request.layer_times = Some(LayerTimes {
            seconds_by_layer: floats(&times["secondsByLayer"]),
            provenance: read(&times["provenance"]),
        });
    }
    request
}
fn snapshot(preview: &Preview) -> Value {
    let mut v = serde_json::to_value(preview).unwrap();
    if let Preview::Ready {
        values,
        colors_rgba,
        ..
    } = preview
    {
        v["values"] = bits(values);
        v["colorsRgba"] = bits(colors_rgba);
    }
    v
}
#[test]
fn matches_production_preview_modes_filters_legends_and_rejections() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/preview-vectors.json"
    ))
    .unwrap();
    let models = corpus["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(model)
        .collect::<Vec<_>>();
    for vector in corpus["vectors"].as_array().unwrap() {
        let id = vector["id"].as_str().unwrap();
        let request = request(&vector["request"]);
        let result = project(
            &models[vector["model"].as_u64().unwrap() as usize],
            &request,
            &Cancellation::default(),
        );
        if let Some(error) = vector["error"].as_str() {
            assert_eq!(result.unwrap_err().code, error, "{id}");
        } else {
            let result = result.unwrap_or_else(|err| panic!("{id}: {err:?}"));
            equal(&snapshot(&result), &vector["expected"], id);
        }
    }
}

#[test]
fn projection_failure_and_output_mutation_preserve_source_and_future_results() {
    use orcaxr_gcode::{Options, parse};
    let source: Vec<u16> = "M83\nG1 X1 E1 F600\nG1 X2 E1 F1200"
        .encode_utf16()
        .collect();
    let model = parse(&source, &Options::default()).unwrap();
    let unchanged = serde_json::to_value(&model).unwrap();
    let request = request(&serde_json::json!({"mode": "Feedrate"}));
    let expected = snapshot(&project(&model, &request, &Cancellation::default()).unwrap());
    let mut first = project(&model, &request, &Cancellation::default()).unwrap();
    if let Preview::Ready {
        values,
        colors_rgba,
        record_indices,
        ..
    } = &mut first
    {
        values.fill(999.0);
        colors_rgba.fill(999.0);
        record_indices.fill(u32::MAX);
    } else {
        panic!("expected ready projection");
    }
    let cap = PreviewRequest {
        max_projected_records: Some(1.0),
        ..request
    };
    assert_eq!(
        project(&model, &cap, &Cancellation::default())
            .unwrap_err()
            .code,
        "projection-cap"
    );
    let request = PreviewRequest {
        max_projected_records: None,
        ..cap
    };
    assert_eq!(
        snapshot(&project(&model, &request, &Cancellation::default()).unwrap()),
        expected
    );
    assert_eq!(serde_json::to_value(&model).unwrap(), unchanged);
}

#[test]
fn cancellation_settles_without_publishing_a_partial_projection() {
    use orcaxr_gcode::{Options, parse};
    use std::{
        sync::{Arc, Barrier},
        time::{Duration, Instant},
    };
    let cancelled = Cancellation::default();
    cancelled.cancel();
    let empty = parse(&[], &Options::default()).unwrap();
    let request = request(&serde_json::json!({"mode":"FeatureType"}));
    assert_eq!(
        project(&empty, &request, &cancelled).unwrap_err().code,
        "cancelled"
    );
    let source: Vec<u16> = format!("G91\nM83\n{}", "G1 X1 E1\n".repeat(240000))
        .encode_utf16()
        .collect();
    let model = parse(&source, &Options::default()).unwrap();
    let active = Cancellation::default();
    let token = active.clone();
    let barrier = Arc::new(Barrier::new(2));
    let started = barrier.clone();
    let worker = std::thread::spawn(move || {
        started.wait();
        loop {
            match project(&model, &request, &token) {
                Ok(Preview::Ready { count: 240000, .. }) => {}
                Ok(_) => panic!("partial result"),
                Err(error) => return error.code,
            }
        }
    });
    barrier.wait();
    std::thread::sleep(Duration::from_millis(3));
    let start = Instant::now();
    active.cancel();
    assert_eq!(worker.join().unwrap(), "cancelled");
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "cooperative-cancellation watchdog"
    );
}
