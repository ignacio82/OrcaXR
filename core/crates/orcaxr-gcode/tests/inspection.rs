mod common;
use common::*;
use orcaxr_gcode::{Cancellation, inspection::*};
use serde_json::Value;

fn snapshot(state: &Inspection) -> Value {
    let mut v = serde_json::to_value(state).unwrap();
    v["layers"]["zMm"] = bits(&state.layers.z_mm);
    v
}
#[test]
fn matches_production_inspection_and_playback() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/inspection-vectors.json"
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
        let mut saved = vector["request"].clone();
        let source = saved
            .as_object_mut()
            .unwrap()
            .remove("gcodeSource")
            .map(|v| read::<Vec<u16>>(&v));
        let request: InspectionRequest = read(&saved);
        let result = inspect(
            &models[vector["model"].as_u64().unwrap() as usize],
            &request,
            source.as_deref(),
            &Cancellation::default(),
        );
        if let Some(error) = vector["error"].as_str() {
            assert_eq!(result.unwrap_err().code, error, "{id}");
            continue;
        }
        let result = result.unwrap_or_else(|err| panic!("{id}: {err:?}"));
        equal(&snapshot(&result), &vector["expected"], id);
        for (i, entry) in vector["steps"].as_array().unwrap().iter().enumerate() {
            let stepped = step(&result, read(&entry["direction"]), read(&entry["wrap"]));
            let label = format!("{id}.step[{i}]");
            if let Some(error) = entry["error"].as_str() {
                assert_eq!(stepped.unwrap_err().code, error, "{label}");
            } else {
                equal(
                    &serde_json::to_value(stepped.unwrap()).unwrap(),
                    &entry["expected"],
                    &label,
                );
            }
        }
        for (i, entry) in vector["playback"].as_array().unwrap().iter().enumerate() {
            let sequence = playback(&result, &read(&entry["options"]), &Cancellation::default());
            let label = format!("{id}.playback[{i}]");
            if let Some(error) = entry["error"].as_str() {
                assert_eq!(sequence.unwrap_err().code, error, "{label}");
            } else {
                equal(
                    &serde_json::to_value(sequence.unwrap()).unwrap(),
                    &entry["expected"],
                    &label,
                );
            }
        }
    }
}

#[test]
fn tick_limits_and_visibility_apply_before_allocating_tick_strings() {
    use orcaxr_gcode::{Options, parse};
    let source: Vec<u16> = "; PAUSE_PRINTING\n"
        .repeat(MAX_TICKS + 1)
        .encode_utf16()
        .collect();
    let model = parse(&source, &Options::default()).unwrap();
    let cancel = Cancellation::default();
    assert_eq!(
        inspect(&model, &InspectionRequest::default(), None, &cancel)
            .unwrap_err()
            .code,
        "invalid-model"
    );
    let mut visibility = vec![1; model.columns.count];
    visibility[0] = 0;
    let request = InspectionRequest {
        record_visibility: Some(visibility),
        ..Default::default()
    };
    let state = inspect(&model, &request, None, &cancel).unwrap();
    assert_eq!(state.ticks.len(), MAX_TICKS);
    assert_eq!(state.ticks.capacity(), MAX_TICKS);
    assert_eq!(state.record_indices.len(), MAX_TICKS);
    assert_eq!(state.record_indices.capacity(), MAX_TICKS);
    assert!(state.focus_bounds.is_none());
    let options = PlaybackOptions {
        direction: -1.0,
        wrap: true,
        include_current: true,
        max_frames: Some(MAX_PLAYBACK_FRAMES as f64),
    };
    let sequence = playback(&state, &options, &cancel).unwrap();
    assert_eq!(sequence.len(), MAX_PLAYBACK_FRAMES);
    assert_eq!(sequence.first(), Some(&(MAX_TICKS as u32)));
    assert_eq!(sequence.last(), Some(&1));
}

#[test]
fn source_context_and_utf16_truncation_have_explicit_bounds() {
    use orcaxr_gcode::{Options, parse};
    let mut source = Vec::new();
    for i in 0..102 {
        source.extend(format!("; {i} ").encode_utf16());
        source.extend(vec![0xD800; 5000]);
        source.extend("\n".encode_utf16());
        if i == 50 {
            source.extend("G1 X1\n".encode_utf16());
        }
    }
    let model = parse(&source, &Options::default()).unwrap();
    let request = InspectionRequest {
        source_context_lines: Some(50.0),
        ..Default::default()
    };
    let state = inspect(&model, &request, Some(&source), &Cancellation::default()).unwrap();
    let window = state.source_window.unwrap();
    assert_eq!(window.lines.len(), 101);
    assert_eq!(window.lines.capacity(), 101);
    assert_eq!(window.lines[0].text.len(), 4096);
    assert_eq!(*window.lines[0].text.0.last().unwrap(), 0x2026);
    assert!(window.lines[0].text.0.contains(&0xD800));
    assert_eq!(window.lines.iter().filter(|l| l.current).count(), 1);
    assert!(window.lines.iter().all(|l| l.text.len() <= MAX_LINE_UNITS));
    let invalid = InspectionRequest {
        source_context_lines: Some(f64::NAN),
        ..Default::default()
    };
    assert_eq!(
        inspect(&model, &invalid, Some(&source), &Cancellation::default())
            .unwrap_err()
            .code,
        "invalid-source"
    );
}

#[test]
fn cancellation_and_mutated_playback_state_cannot_publish_partial_results_or_panic() {
    use orcaxr_gcode::{Options, parse};
    use std::{
        sync::{Arc, Barrier},
        time::{Duration, Instant},
    };
    let cancelled = Cancellation::default();
    cancelled.cancel();
    let empty = parse(&[], &Options::default()).unwrap();
    assert_eq!(
        inspect(&empty, &InspectionRequest::default(), None, &cancelled)
            .unwrap_err()
            .code,
        "cancelled"
    );
    let text: Vec<u16> = "G91\nG1 X1\nG1 X1".encode_utf16().collect();
    let model = parse(&text, &Options::default()).unwrap();
    let mut state = inspect(
        &model,
        &InspectionRequest::default(),
        None,
        &Cancellation::default(),
    )
    .unwrap();
    let options = PlaybackOptions {
        direction: 1.0,
        wrap: true,
        include_current: true,
        max_frames: None,
    };
    assert_eq!(
        playback(&state, &options, &cancelled).unwrap_err().code,
        "cancelled"
    );
    state.move_selection.as_mut().unwrap().last_ordinal = usize::MAX;
    assert_eq!(
        step(&state, 1.0, true).unwrap_err().code,
        "invalid-playback"
    );
    assert_eq!(
        playback(&state, &options, &Cancellation::default())
            .unwrap_err()
            .code,
        "invalid-playback"
    );
    // A long comment is outside parser retention but inside a requested source
    // context. Its scan remains cancellable and never retains the whole line.
    let mut text = text;
    text.extend("\n;".encode_utf16());
    text.extend(vec![65; 16 * 1024 * 1024]);
    let model = parse(&text, &Options::default()).unwrap();
    let active = Cancellation::default();
    let token = active.clone();
    let barrier = Arc::new(Barrier::new(2));
    let started = barrier.clone();
    let thread = std::thread::spawn(move || {
        started.wait();
        loop {
            match inspect(&model, &InspectionRequest::default(), Some(&text), &token) {
                Ok(_) => {}
                Err(error) => return error.code,
            }
        }
    });
    barrier.wait();
    std::thread::sleep(Duration::from_millis(3));
    let start = Instant::now();
    active.cancel();
    assert_eq!(thread.join().unwrap(), "cancelled");
    assert!(start.elapsed() < Duration::from_secs(5));
}
