use orcaxr_archive::bbs::numbers::{self, Error};
use orcaxr_project::model::{Number, Transform};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-number-vectors.json"
    ))
    .unwrap()
}
fn bits(v: &Json) -> u64 {
    u64::from_str_radix(v.as_str().unwrap(), 16).unwrap()
}
fn floats<const N: usize>(v: &Json) -> [f64; N] {
    std::array::from_fn(|i| f64::from_bits(bits(&v[i])))
}
fn check(row: &Json, result: Result<numbers::NumericText, Error>) {
    if row["error"] == true {
        assert!(result.is_err(), "{row}");
    } else {
        assert_eq!(
            result.unwrap().as_str(),
            row["text"].as_str().unwrap(),
            "{row}"
        );
    }
}
#[test]
fn compact_mesh_coordinates_and_exact_double_numbers_match_browser() {
    let corpus = corpus();
    for row in corpus["mesh"].as_array().unwrap() {
        check(
            row,
            numbers::mesh_coordinate(f32::from_bits(row["bits"].as_u64().unwrap() as u32)),
        );
    }
    for row in corpus["numbers"].as_array().unwrap() {
        check(row, numbers::number(f64::from_bits(bits(&row["bits"]))));
    }
}
#[test]
fn complete_float32_exponent_lattice_and_random_bits_match_browser_digest() {
    use std::fmt::Write;
    let corpus = corpus();
    let scan = &corpus["scan"];
    let mut digest = Sha256::new();
    let mut count = 0;
    let mut line = String::with_capacity(80);
    let mut sample = |bits| {
        let value = f32::from_bits(bits);
        if !value.is_finite() {
            return;
        }
        line.clear();
        writeln!(
            &mut line,
            "{bits} {}",
            numbers::mesh_coordinate(value).unwrap().as_str()
        )
        .unwrap();
        digest.update(line.as_bytes());
        count += 1;
    };
    for exponent in 0..255 {
        for fraction in 0..32768 {
            sample((exponent << 23) | (fraction << 8));
        }
    }
    let mut seed = 0xabbadaba_u32;
    for _ in 0..1_000_000 {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        sample(seed);
    }
    assert_eq!(count, scan["count"].as_u64().unwrap());
    assert_eq!(
        format!("{:x}", digest.finalize()),
        scan["sha256"].as_str().unwrap()
    );
}
#[test]
fn exact_matrix_bits_and_both_xml_orders_match_browser() {
    for (index, row) in corpus()["transforms"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let transform = Transform {
            translation_mm: floats::<3>(&row["translation"]).map(|v| Number::new(v).unwrap()),
            scale: floats::<3>(&row["scale"]).map(|v| Number::new(v).unwrap()),
            rotation: floats::<4>(&row["rotation"]).map(|v| Number::new(v).unwrap()),
            extra: Default::default(),
        };
        let offset = floats::<2>(&row["offset"]);
        let matrix = numbers::transform_matrix(&transform, offset);
        if row["nativeRotationRefusal"] == true {
            assert_eq!(matrix, Err(Error::Rotation));
            continue;
        }
        if row["error"] == true {
            assert!(matrix.is_err(), "transform {index}");
            continue;
        }
        for (order, key, origin) in [
            (
                orcaxr_archive::bbs::xml::MatrixOrder::ThreeMf,
                "three",
                offset,
            ),
            (
                orcaxr_archive::bbs::xml::MatrixOrder::RowMajor4,
                "four",
                [0.0, 0.0],
            ),
        ] {
            let mut out = vec![];
            let mut writer = orcaxr_archive::bbs::xml::Writer::new(
                &mut out,
                orcaxr_archive::bbs::xml::Limits {
                    output_bytes: 4096,
                    text_units: 0,
                },
                || false,
            )
            .unwrap();
            writer.transform(&transform, origin, order).unwrap();
            writer.finish().unwrap();
            assert_eq!(
                out,
                row[key].as_str().unwrap().as_bytes(),
                "writer transform {index}"
            );
        }
        let matrix = matrix.unwrap();
        assert_eq!(
            matrix.map(f64::to_bits),
            std::array::from_fn(|i| bits(&row["matrix"][i])),
            "transform {index}"
        );
        let text = |v: &[f64]| {
            v.iter()
                .map(|&v| numbers::number(v).unwrap().as_str().to_string())
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(
            text(&numbers::transform_3mf(&transform, offset).unwrap()),
            row["three"].as_str().unwrap(),
            "transform {index}"
        );
        assert_eq!(
            text(&numbers::transform_matrix(&transform, [0.0, 0.0]).unwrap()),
            row["four"].as_str().unwrap(),
            "transform {index}"
        );
    }
}
#[test]
fn reference_sources_are_current() {
    for (path, digest) in corpus()["sources"].as_object().unwrap() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .join(path),
        )
        .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            digest.as_str().unwrap(),
            "{path}"
        );
    }
}
