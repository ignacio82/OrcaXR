//! Assembly alignment against the browser: every availability, alignment and
//! explosion request of the browser's script answers its reply byte for byte.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_project::assembly;
use serde_json::Value;
use std::collections::BTreeMap;

#[test]
fn assembly_matches_the_browser() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/assembly-vectors.json"
    ))
    .unwrap();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let expected = step["reply"].as_str().unwrap();
        let (operation, reply) = if let Some(request) = step["availability"].as_str() {
            let reply = assembly::availability_wire(&wire::decode_assembly_pair(request).unwrap());
            (
                "availability",
                wire::encode_assembly_availability_reply(&reply).unwrap(),
            )
        } else if let Some(request) = step["alignment"].as_str() {
            let reply = assembly::alignment_wire(
                &wire::decode_assembly_alignment_request(request).unwrap(),
            );
            (
                "alignment",
                wire::encode_assembly_alignment_reply(&reply).unwrap(),
            )
        } else {
            let request = step["explosion"].as_str().unwrap();
            let reply = assembly::explosion_wire(&wire::decode_explosion_request(request).unwrap());
            ("explosion", wire::encode_explosion_reply(&reply).unwrap())
        };
        assert_eq!(reply, expected, "step {i}");
        let outcome = serde_json::from_str::<Value>(&reply).unwrap();
        let outcome = outcome.as_object().unwrap().keys().next().unwrap().clone();
        *counts.entry(format!("{operation}:{outcome}")).or_default() += 1;
    }
    assert_eq!(
        counts,
        BTreeMap::from(
            [
                ("alignment:planned", 246),
                ("alignment:refused", 279),
                ("availability:available", 51),
                ("availability:refused", 4),
                ("explosion:exploded", 4),
                ("explosion:refused", 3),
            ]
            .map(|(k, v)| (k.to_owned(), v))
        )
    );
}
