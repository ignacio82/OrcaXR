use orcaxr_gcode::*;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn source(text: &str) -> Arc<[u16]> {
    text.encode_utf16().collect::<Vec<_>>().into()
}
fn options(records: usize, path_points: usize) -> Options {
    Options {
        limits: RequestedLimits {
            records: Some(records as f64),
            path_points: Some(path_points as f64),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn a_large_single_layer_is_fully_reachable_with_bounded_columns() {
    let text = source(&format!(
        ";LAYER_CHANGE\nG91\n{}",
        "G1 X1 E1\n".repeat(300_001)
    ));
    let weak = Arc::downgrade(&text);
    let options = options(PREVIEW_WINDOW_RECORDS, 1000);
    let index = index(text, &options).unwrap();
    assert!(index.complete);
    assert_eq!(index.record_count, 300_002);
    let mut next = 0;
    for entry in 0..index.entries().len() {
        let model = parse_window(&index, entry as isize, entry as isize, &options).unwrap();
        assert!(model.complete);
        assert_eq!(model.record_offset, Some(next));
        assert!(model.columns.count <= PREVIEW_WINDOW_RECORDS);
        assert!(model.columns.start_x.capacity() <= PREVIEW_WINDOW_RECORDS);
        assert!(model.columns.kind.capacity() <= PREVIEW_WINDOW_RECORDS);
        assert!(model.columns.source_line.capacity() <= PREVIEW_WINDOW_RECORDS);
        next += model.columns.count;
    }
    assert_eq!(next, index.record_count);
    drop(index);
    assert!(weak.upgrade().is_none(), "index retained a released source");
}

#[test]
fn whole_arcs_fit_or_fail_without_publishing_partial_paths() {
    let text = source(&format!("G1 X10 Y0\n{}", "G2 X10 Y0 I-10 J0\n".repeat(100)));
    let options = options(200, 200);
    let indexed = index(text.clone(), &options).unwrap();
    assert!(indexed.complete);
    assert_eq!(indexed.record_count, 101);
    assert!(indexed.entries().len() > 30);
    for entry in 0..indexed.entries().len() {
        let window = parse_window(&indexed, entry as isize, entry as isize, &options).unwrap();
        assert!(window.complete);
        assert!(window.path_points.count <= 200);
        assert!(window.path_points.x.capacity() <= 200);
        assert_eq!(
            window
                .columns
                .path_point_count
                .iter()
                .map(|n| *n as usize)
                .sum::<usize>(),
            window.path_points.count
        );
    }
    let limited = parse(&text, &options).unwrap();
    assert_eq!(limited.termination_reason, Some(Termination::PathPointCap));
    assert_eq!(limited.columns.count, 4); // travel + three complete 62-point arcs
    assert_eq!(limited.path_points.count, 186);
}

#[test]
fn cancelled_work_publishes_no_model_or_index() {
    let cancelled = Cancellation::default();
    cancelled.cancel();
    assert!(matches!(
        parse_with_cancellation(&[], &Options::default(), &cancelled),
        Err(ParseError::Cancelled)
    ));
    assert!(matches!(
        index_with_cancellation(source("G1 X1"), &Options::default(), &cancelled),
        Err(ParseError::Cancelled)
    ));
    let active = Cancellation::default();
    let text = source(&"G2 X0 Y0 I10000 J0\n".repeat(100_000));
    let worker_token = active.clone();
    let worker = std::thread::spawn(move || {
        index_with_cancellation(text, &Options::default(), &worker_token)
    });
    std::thread::sleep(Duration::from_millis(10));
    let start = Instant::now();
    active.cancel();
    assert!(matches!(worker.join().unwrap(), Err(ParseError::Cancelled)));
    // A generous watchdog verifies cooperative settlement, not a device latency claim.
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn arbitrary_utf16_and_numeric_tokens_respect_all_caps() {
    let mut seed = 0x1ee7_cafe_u32;
    let mut random = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let options = Options {
        limits: RequestedLimits {
            records: Some(8.0),
            path_points: Some(64.0),
            warnings: Some(4.0),
            roles: Some(3.0),
            filaments: Some(2.0),
            line_characters: Some(80.0),
            input_characters: Some(1024.0),
            lines: Some(30.0),
        },
        ..Default::default()
    };
    let prefixes = [
        "G2 X",
        "G1 X",
        "G92 E",
        "M109 R",
        ";TYPE:",
        ";COLOR_CHANGE,T0,",
        "G3 X0 Y0 I",
    ];
    let values = [
        "1e999", "-0", "1e-999", "1e39", ".5", "1.2.3", "NaN", "Infinity", "1E+", "0xF",
    ];
    for _ in 0..1024 {
        let mut text = Vec::new();
        for _ in 0..20 {
            text.extend(prefixes[random() as usize % prefixes.len()].encode_utf16());
            text.extend(values[random() as usize % values.len()].encode_utf16());
            for _ in 0..random() % 12 {
                text.push(random() as u16);
            }
            text.push(10);
        }
        let model = parse(&text, &options).unwrap();
        assert!(model.columns.count <= 8 && model.columns.kind.capacity() <= 8);
        assert!(model.path_points.count <= 64 && model.path_points.x.capacity() <= 64);
        assert!(model.warnings.len() <= 4 && model.roles.len() <= 3 && model.filaments.len() <= 2);
        for i in 0..model.columns.count {
            assert!(model.columns.source_start_offset[i] <= model.columns.source_end_offset[i]);
            assert!((model.columns.source_end_offset[i] as usize) <= text.len());
            assert!(
                model.columns.path_point_offset[i] as usize
                    + model.columns.path_point_count[i] as usize
                    <= model.path_points.count
            );
        }
    }
}

#[test]
fn invalid_resource_requests_and_window_ranges_are_rejected() {
    for value in [
        0.0,
        -1.0,
        0.5,
        f64::NAN,
        f64::INFINITY,
        9_007_199_254_740_992.0,
    ] {
        let options = Options {
            limits: RequestedLimits {
                records: Some(value),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(matches!(
            parse(&[], &options),
            Err(ParseError::InvalidLimits)
        ));
    }
    let options = options(1, 20);
    let index = index(source("G1 X1\nG1 X2"), &options).unwrap();
    assert!(matches!(
        parse_window(&index, 1, 0, &options),
        Err(ParseError::InvalidWindow)
    ));
    assert_eq!(
        parse_window(&index, isize::MAX, isize::MAX, &options)
            .unwrap()
            .record_offset,
        Some(1)
    );
}
