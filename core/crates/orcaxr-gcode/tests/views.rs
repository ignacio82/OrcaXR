#[path = "common/equal.rs"]
mod comparison;
use comparison::equal;
use orcaxr_gcode::{Cancellation, Session, SessionError, view_layout as layout};
use serde_json::{Value, json};

fn snapshot(bytes: &[u8]) -> Value {
    let word = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    assert_eq!(&bytes[..4], b"OXGV");
    assert_eq!(word(4) as usize, layout::VERSION);
    let kind = word(8) as usize;
    let metadata = word(12) as usize;
    let counts = [word(16) as usize, word(20) as usize, word(24) as usize];
    assert_eq!(bytes.len(), word(28) as usize);
    assert!(bytes.len() <= layout::MAX_PACKET_BYTES && metadata <= layout::MAX_METADATA_BYTES);
    let mut value: Value = serde_json::from_slice(&bytes[32..32 + metadata]).unwrap();
    let mut fields = serde_json::Map::new();
    let mut offset = (32 + metadata + 3) & !3;
    for field in layout::fields(kind).unwrap() {
        let n = counts[field.counter] * field.factor;
        let column: Vec<u32> = (0..n)
            .map(|i| {
                if field.bytes == 1 {
                    bytes[offset + i] as u32
                } else {
                    word(offset + i * 4)
                }
            })
            .collect();
        fields.insert(
            field.name.into(),
            if field.kind == "f32" {
                json!({"$f32":column})
            } else {
                json!(column)
            },
        );
        offset = (offset + n * field.bytes + 3) & !3;
    }
    assert_eq!(offset, bytes.len());
    if kind == layout::PLAYBACK {
        return fields.remove("recordIndices").unwrap();
    }
    if kind == layout::PREVIEW {
        if value["status"] == "ready" {
            value["count"] = json!(counts[0]);
            value.as_object_mut().unwrap().extend(fields);
        } else {
            assert_eq!(counts, [0, 0, 0]);
        }
        return value;
    }
    value["recordIndices"] = fields.remove("recordIndices").unwrap();
    value["layers"] = json!({"count":counts[1],"layerIds":fields["layerIds"],"zMm":fields["layerZMm"],"firstRecord":fields["layerFirstRecord"],"lastRecord":fields["layerLastRecord"]});
    let labels = value.as_object_mut().unwrap().remove("tickLabels").unwrap();
    value["ticks"]=Value::Array((0..counts[2]).map(|i| {
        let kind=match fields["tickKind"][i].as_u64().unwrap() {4=>"tool-change",5=>"color-change",6=>"pause",7=>"custom",_=>panic!("tick kind")};
        let record=&fields["tickRecord"][i];
        json!({"id":format!("{kind}:{record}"),"kind":kind,"label":labels[fields["tickLabel"][i].as_u64().unwrap() as usize],"record":record,
            "layer":fields["tickLayer"][i],"zMm":f32::from_bits(fields["tickZMm"]["$f32"][i].as_u64().unwrap() as u32),
            "sourceLine":fields["tickSourceLine"][i],"sourceStartOffset":fields["tickStartOffset"][i],"sourceEndOffset":fields["tickEndOffset"][i]})
    }).collect());
    value
}

#[test]
fn session_views_match_independent_typescript_sources_windows_and_extremes() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/view-vectors.json"
    ))
    .unwrap();
    for vector in corpus["vectors"].as_array().unwrap() {
        let units: Vec<u16> = serde_json::from_value(vector["sourceUnits"].clone()).unwrap();
        let mut session = Session::new(
            units.len(),
            &vector["options"].to_string(),
            Cancellation::default(),
        )
        .unwrap();
        for (i, chunk) in units.chunks(4093).enumerate() {
            session.append(i * 4093, chunk).unwrap();
        }
        session.seal().unwrap();
        for (i, view) in vector["views"].as_array().unwrap().iter().enumerate() {
            let id = format!("{}:{i}", vector["id"]);
            let result = session.view(&view["request"].to_string());
            if let Some(error) = view["error"].as_str() {
                assert_eq!(result.unwrap_err().code(), error, "{id}");
            } else {
                equal(
                    &snapshot(&result.unwrap_or_else(|e| panic!("{id}: {e:?}"))),
                    &view["expected"],
                    &id,
                );
            }
        }
    }
}

#[test]
fn rejected_requests_and_cancellation_do_not_publish_stale_views() {
    let cancel = Cancellation::default();
    let source = "M83\nG1 X1 E1\n;LAYER_CHANGE\nG1 X2 E1"
        .encode_utf16()
        .collect::<Vec<_>>();
    let mut session = Session::new(source.len(), "{}", cancel.clone()).unwrap();
    let request = r#"{"version":1,"window":[],"operation":"inspection","request":{}}"#;
    assert_eq!(session.view(request), Err(SessionError::InvalidState));
    session.append(0, &source).unwrap();
    session.seal().unwrap();
    let mut retained = session.view(request).unwrap();
    let expected = snapshot(&retained);
    for invalid in [
        "null",
        "[]",
        "{}",
        r#"{"version":1,"operation":"inspection","request":{}}"#,
        r#"{"version":1,"window":[],"operation":"inspection","request":{"gcodeSource":"other"}}"#,
        r#"{"version":1,"window":[0,1,2],"operation":"inspection","request":{}}"#,
        r#"{"version":1,"window":[],"operation":"inspection","request":{},"extra":true}"#,
        r#"{"version":1,"window":null,"operation":"inspection","request":{}}"#,
        r#"{"version":1,"window":[1,0],"operation":"inspection","request":{}}"#,
    ] {
        assert_eq!(
            session.view(invalid),
            Err(SessionError::InvalidRequest),
            "{invalid}"
        );
    }
    assert_eq!(
        session.view(&request.replace("\"version\":1", "\"version\":99")),
        Err(SessionError::UnsupportedProtocol)
    );
    assert_eq!(
        session.view(&request.replace("\"window\":[]", "\"window\":[999,999]")),
        Err(SessionError::InvalidRange)
    );
    assert_eq!(
        session.view(&" ".repeat(layout::MAX_REQUEST_BYTES + 1)),
        Err(SessionError::ResourceLimit)
    );
    retained.fill(255);
    equal(
        &snapshot(&session.view(request).unwrap()),
        &expected,
        "owned output",
    );
    cancel.cancel();
    assert_eq!(session.view(request), Err(SessionError::Cancelled));
}

#[test]
fn event_columns_and_source_context_remain_bounded_at_the_session_boundary() {
    // Every pause is an inspectable record and a tick. Labels are interned once,
    // so reaching the tick cap does not create a JSON object/string per event.
    let source = "; PAUSE_PRINTING\n"
        .repeat(100_000)
        .encode_utf16()
        .collect::<Vec<_>>();
    let mut session = Session::new(source.len(), "{}", Cancellation::default()).unwrap();
    for (i, chunk) in source.chunks(65536).enumerate() {
        session.append(i * 65536, chunk).unwrap();
    }
    session.seal().unwrap();
    let packet=session.view(r#"{"version":1,"window":[],"operation":"inspection","includeSource":true,"request":{"sourceContextLines":50}}"#).unwrap();
    assert!(packet.len() < 4 * 1024 * 1024);
    let n = u32::from_le_bytes(packet[12..16].try_into().unwrap()) as usize;
    let metadata: Value = serde_json::from_slice(&packet[32..32 + n]).unwrap();
    assert_eq!(metadata["tickLabels"].as_array().unwrap().len(), 1);
    assert_eq!(
        u32::from_le_bytes(packet[24..28].try_into().unwrap()),
        100_000
    );
    assert!(metadata["sourceWindow"]["lines"].as_array().unwrap().len() <= 101);
    let playback=session.view(r#"{"version":1,"window":[],"operation":"playback","request":{},"playback":{"direction":1,"wrap":true,"includeCurrent":true,"maxFrames":100000}}"#).unwrap();
    assert_eq!(snapshot(&playback).as_array().unwrap().len(), 100_000);
}
