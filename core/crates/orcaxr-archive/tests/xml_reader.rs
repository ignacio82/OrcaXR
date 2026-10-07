use orcaxr_archive::bbs::read_xml::{
    Attribute, Event, Failure, Limits, Receipt, Scanner, Tag, part,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf};
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-xml-read-vectors.json"
    ))
    .unwrap()
}
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn bytes(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}
fn limits(input_bytes: usize) -> Limits {
    Limits {
        input_bytes,
        text_units: input_bytes,
        token_bytes: 64 << 10,
        elements: 200_000,
        attributes: 1_000_000,
        depth: 128,
    }
}
fn feed(data: &[u8], chunk: usize, l: Limits) -> Result<(Receipt, Vec<u8>, Vec<Value>), String> {
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut scanner = Scanner::new(
        l,
        || false,
        |event| {
            match event {
                Event::Open(tag) => {
                    out.extend_from_slice(tag.raw.as_bytes());
                    events.push(opening(tag));
                }
                Event::Close { raw, name } => {
                    out.extend_from_slice(raw.as_bytes());
                    events.push(json!({"close":name}));
                }
                Event::Text(text) => {
                    out.extend_from_slice(text.as_bytes());
                    events.push(json!({"text":text}));
                }
                Event::Ignored { text_units } => {
                    out.extend(std::iter::repeat_n(b' ', text_units));
                    events.push(json!({"ignored":text_units}));
                }
            }
            Ok::<_, ()>(())
        },
    );
    for part in data.chunks(chunk) {
        scanner
            .write_all(part)
            .map_err(|_| "write refused".to_owned())?;
    }
    let receipt = scanner.finish().map_err(|e| format!("{e:?}"))?;
    Ok((receipt, out, events))
}
fn opening(tag: Tag<'_>) -> Value {
    let attributes = tag
        .attributes()
        .map(|Attribute { name, value, .. }| json!({"name":name,"value":value}))
        .collect::<Vec<_>>();
    json!({"open":{"name":tag.name,"selfClosing":tag.self_closing,"attributes":attributes}})
}
#[test]
fn production_xml_validator_matches_utf8_tags_namespaces_entities_and_sanitized_stream() {
    let f = corpus();
    for row in f["cases"].as_array().unwrap() {
        let data = bytes_from_hex(row["bytesHex"].as_str().unwrap());
        let expected = &row["expected"];
        let base = feed(&data, 4096, limits(data.len()));
        assert_eq!(
            base.is_ok(),
            !expected.is_null(),
            "{}: {base:?}",
            row["name"]
        );
        let Ok((receipt, output, _)) = base else {
            continue;
        };
        assert_eq!(
            String::from_utf8(output).unwrap(),
            expected["sanitized"].as_str().unwrap(),
            "{} sanitized",
            row["name"]
        );
        let callbacks = feed(&data, 4096, limits(data.len())).unwrap().2;
        let openings = callbacks
            .iter()
            .filter_map(|event| event.get("open").cloned())
            .collect::<Vec<_>>();
        assert_eq!(
            openings.as_slice(),
            expected["openings"].as_array().unwrap().as_slice(),
            "{} opening tags",
            row["name"]
        );
        assert_eq!(receipt.input_bytes, data.len(), "{} bytes", row["name"]);
        let decoded = String::from_utf8(data.clone()).unwrap_or_default();
        let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
        assert_eq!(
            receipt.text_units,
            decoded.encode_utf16().count(),
            "{} UTF-16",
            row["name"]
        );
    }
    for row in f["sources"].as_object().unwrap() {
        let file = root().join(row.0);
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(file).unwrap())),
            row.1.as_str().unwrap(),
            "{}",
            row.0
        );
    }
}
fn bytes_from_hex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn every_stream_split_preserves_multibyte_entities_and_constructs() {
    let f = corpus();
    for name in [
        "text",
        "comment",
        "cdata",
        "pi",
        "namespace",
        "escaped",
        "bom",
    ] {
        let row = f["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap();
        let data = bytes_from_hex(row["bytesHex"].as_str().unwrap());
        let expected = row["expected"]["sanitized"].as_str().unwrap();
        for split in 0..=data.len() {
            let mut out = Vec::new();
            let mut scanner = Scanner::new(
                limits(data.len()),
                || false,
                |e| {
                    match e {
                        Event::Open(t) => out.extend_from_slice(t.raw.as_bytes()),
                        Event::Close { raw, .. } => out.extend_from_slice(raw.as_bytes()),
                        Event::Text(t) => out.extend_from_slice(t.as_bytes()),
                        Event::Ignored { text_units } => {
                            out.extend(std::iter::repeat_n(b' ', text_units))
                        }
                    };
                    Ok::<_, ()>(())
                },
            );
            scanner.write_all(&data[..split]).unwrap();
            scanner.write_all(&data[split..]).unwrap();
            scanner.finish().unwrap();
            assert_eq!(
                String::from_utf8(out).unwrap(),
                expected,
                "{name} split {split}"
            );
        }
    }
    let data = bytes("<a x='&amp;'><!--c--><![CDATA[z]]><?p?></a>");
    for chunk in [1, 2, 3, 7, 64, 4095, 4096, 4097, 65536] {
        let _ = feed(&data, chunk, limits(data.len())).unwrap();
    }
}

#[test]
fn opening_events_expose_namespace_uris_and_local_names() {
    let data = bytes(
        "<model xmlns='urn:core' xmlns:q='urn:production'><q:item q:path='/3D/part.model' plain='x'/></model>",
    );
    let mut opened = Vec::new();
    let mut scanner = Scanner::new(
        limits(data.len()),
        || false,
        |event| {
            if let Event::Open(tag) = event {
                opened.push((
                    tag.local_name().to_owned(),
                    tag.namespace().map(str::to_owned),
                    tag.attributes()
                        .map(|attribute| {
                            (
                                attribute.local_name.to_owned(),
                                attribute.namespace.map(str::to_owned),
                                attribute.value.to_owned(),
                            )
                        })
                        .collect::<Vec<_>>(),
                ));
            }
            Ok::<_, ()>(())
        },
    );
    scanner.write_all(&data).unwrap();
    scanner.finish().unwrap();

    assert_eq!(opened.len(), 2);
    assert_eq!(opened[0].0, "model");
    assert_eq!(opened[0].1.as_deref(), Some("urn:core"));
    assert_eq!(opened[1].0, "item");
    assert_eq!(opened[1].1.as_deref(), Some("urn:production"));
    assert!(opened[1].2.iter().any(|(name, namespace, value)| {
        name == "path"
            && namespace.as_deref() == Some("urn:production")
            && value == "/3D/part.model"
    }));
    assert!(
        opened[1]
            .2
            .iter()
            .any(|(name, namespace, value)| name == "plain" && namespace.is_none() && value == "x")
    );
}

#[test]
fn one_part_geometry_and_component_caps_are_aggregate() {
    let xml = br#"<model><resources>
      <object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="0"/></triangles></mesh></object>
      <object id="2"><mesh><vertices><vertex x="0" y="1" z="0"/><vertex x="1" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="0"/></triangles></mesh></object>
      <object id="3"><components><component objectid="1"/></components></object>
      <object id="4"><components><component objectid="2"/></components></object>
      </resources><build><item objectid="3"/></build></model>"#;
    let parse = |vertex_cap, triangle_cap, component_cap| {
        let mut builder = part::Builder::new(
            part::Limits {
                objects: 10,
                vertices: vertex_cap,
                triangles: triangle_cap,
                components: component_cap,
                build_items: 10,
                materials: 10,
                title_text_units: 100,
                facet_encoded_bytes: 10_000,
                facet_refinement_nodes: 10_000,
                facet_materialization_units: 10_000,
                extension_attribute_count: 100,
                extension_attribute_text_units: 10_000,
            },
            false,
        )
        .unwrap();
        let mut parser_failure = None;
        let mut scanner = Scanner::new(
            limits(xml.len()),
            || false,
            |event| match builder.event(event) {
                Ok(()) => Ok(()),
                Err(error) => {
                    parser_failure = Some(error);
                    Err(())
                }
            },
        );
        let streamed = scanner.write_all(xml);
        let scanned = scanner.finish();
        if let Some(error) = parser_failure {
            return Err(error);
        }
        streamed.map_err(|_| part::Error::Structure)?;
        scanned.map_err(|_| part::Error::Structure)?;
        builder.finish()
    };
    assert!(parse(4, 2, 2).is_ok());
    assert_eq!(parse(3, 2, 2), Err(part::Error::Limits));
    assert_eq!(parse(4, 1, 2), Err(part::Error::Limits));
    assert_eq!(parse(4, 2, 1), Err(part::Error::Limits));
}

#[test]
fn independent_caps_cancellation_and_callback_errors_fail_closed() {
    let data = bytes("<a xmlns:p='urn:p' p:x='雪'>&amp;🧭</a>");
    let reference = limits(data.len());
    let ok = feed(&data, data.len(), reference).unwrap().0;
    assert_eq!(ok.input_bytes, data.len());
    assert_eq!(ok.max_depth, 1);
    for l in [
        {
            let mut v = reference;
            v.input_bytes = data.len() - 1;
            v
        },
        {
            let mut v = reference;
            v.text_units = ok.text_units - 1;
            v
        },
        {
            let mut v = reference;
            v.token_bytes = 3;
            v
        },
        {
            let mut v = reference;
            v.elements = 0;
            v
        },
        {
            let mut v = reference;
            v.attributes = 0;
            v
        },
        {
            let mut v = reference;
            v.depth = 0;
            v
        },
    ] {
        assert!(feed(&data, data.len(), l).is_err());
    }
    let calls = std::cell::Cell::new(0);
    let cancelled = std::cell::Cell::new(false);
    let mut scanner = Scanner::new(
        limits(data.len()),
        || cancelled.get(),
        |e| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                cancelled.set(true);
            }
            let _ = e;
            Ok::<_, ()>(())
        },
    );
    assert!(scanner.write_all(&data).is_err());
    assert!(matches!(
        scanner.finish(),
        Err(orcaxr_archive::bbs::read_xml::Error::Input(
            Failure::Cancelled
        ))
    ));
    let mut scanner = Scanner::new(
        limits(data.len()),
        || false,
        |_| Err::<(), _>("private callback text"),
    );
    assert!(scanner.write_all(b"<a/>").is_err());
    let error = scanner.finish().unwrap_err();
    assert_eq!(format!("{error:?}"), "model_xml_visitor_failed");
    assert!(!format!("{error}").contains("private"));
}
