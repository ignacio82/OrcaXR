use orcaxr_project::ids::{
    FilamentId, IdSource, MixedFilamentId, ObjectId, PhysicalFilamentId, RandomWordSource,
    SeededRandom, UuidIdSource, is_stable_entity_id, kind,
};
use serde_json::Value;
use std::sync::Arc;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-id-vectors.json"
    ))
    .unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
        .collect()
}
fn number(value: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(value.as_str().unwrap(), 16).unwrap())
}
fn acceptance(value: &Value) -> Vec<bool> {
    let mut accepted = vec![false; 65536];
    for code in units(value) {
        accepted[usize::from(code)] = true;
    }
    accepted
}

#[test]
fn matches_persisted_identifiers_without_normalizing_or_losing_utf16() {
    let data = corpus();
    let mut accepted = Vec::new();
    for case in data["cases"].as_array().unwrap() {
        let raw = units(&case["inputUtf16"]);
        let valid = case["valid"].as_bool().unwrap();
        assert_eq!(is_stable_entity_id(&raw), valid, "{}", case["id"]);
        match ObjectId::try_from_utf16(raw.clone()) {
            Ok(id) => {
                assert!(valid, "{}", case["id"]);
                assert_eq!(id.as_utf16(), raw);
                accepted.push((id, case["id"].as_str().unwrap()));
            }
            Err(_) => assert!(!valid, "{}", case["id"]),
        }
    }
    accepted.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        accepted.iter().map(|row| row.1).collect::<Vec<_>>(),
        data["orderedValidIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect::<Vec<_>>()
    );
    let spec = &data["longId"];
    let mut raw = units(&spec["prefixUtf16"]);
    raw.extend(std::iter::repeat_n(
        u16::try_from(spec["repeatedUnit"].as_u64().unwrap()).unwrap(),
        usize::try_from(spec["repeatCount"].as_u64().unwrap()).unwrap(),
    ));
    assert_eq!(is_stable_entity_id(&raw), spec["valid"].as_bool().unwrap());
    assert_eq!(
        ObjectId::try_from_utf16(raw.clone()).unwrap().as_utf16(),
        raw
    );
}

#[test]
fn exhausts_every_utf16_unit_at_each_uuid_and_import_grammar_position() {
    let data = corpus();
    let exhaustive = &data["exhaustive"];
    let whitespace = acceptance(&exhaustive["whitespace"]);
    let first = acceptance(&exhaustive["namespaceFirst"]);
    let middle = acceptance(&exhaustive["namespaceMiddle"]);
    let mut payload: Vec<u16> = "import:a:x_y".encode_utf16().collect();
    let mut namespace_first: Vec<u16> = "import:_:x".encode_utf16().collect();
    let mut namespace_middle: Vec<u16> = "import:a_b:x".encode_utf16().collect();
    for code in 0..=u16::MAX {
        payload[10] = code;
        namespace_first[7] = code;
        namespace_middle[8] = code;
        let index = usize::from(code);
        assert_eq!(
            is_stable_entity_id(&payload),
            !whitespace[index],
            "payload {code:04x}"
        );
        assert_eq!(
            is_stable_entity_id(&namespace_first),
            first[index],
            "namespace first {code:04x}"
        );
        assert_eq!(
            is_stable_entity_id(&namespace_middle),
            middle[index],
            "namespace middle {code:04x}"
        );
    }
    let mut uuid = units(&exhaustive["uuidUnits"]);
    for (position, expected) in exhaustive["uuidReplacements"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let valid = acceptance(expected);
        let original = uuid[position];
        for code in 0..=u16::MAX {
            uuid[position] = code;
            assert_eq!(
                is_stable_entity_id(&uuid),
                valid[usize::from(code)],
                "UUID position {position}, unit {code:04x}"
            );
        }
        uuid[position] = original;
    }
}

#[test]
fn seeded_random_words_and_uuid_sequences_match_the_browser_bit_for_bit() {
    for case in corpus()["seeded"].as_array().unwrap() {
        let seed = number(&case["seedBits"]);
        let mut random = SeededRandom::new(seed);
        for expected in case["wordBits"].as_array().unwrap() {
            assert_eq!(
                random.next_word().to_bits(),
                number(expected).to_bits(),
                "seed {}",
                case["seedBits"]
            );
        }
        let mut source = UuidIdSource::new(SeededRandom::new(seed));
        for expected in case["uuids"].as_array().unwrap() {
            let actual = source.next::<kind::Object>();
            assert_eq!(
                actual.as_utf16(),
                expected
                    .as_str()
                    .unwrap()
                    .encode_utf16()
                    .collect::<Vec<_>>()
            );
            assert!(is_stable_entity_id(actual.as_utf16()));
        }
    }
}

#[test]
fn injected_random_words_preserve_javascript_wrapping_and_consume_exactly_sixteen_values() {
    for case in corpus()["injected"].as_array().unwrap() {
        let words: Vec<_> = case["wordBits"]
            .as_array()
            .unwrap()
            .iter()
            .map(number)
            .collect();
        let mut count = 0;
        let actual = {
            let mut source = UuidIdSource::new(|| {
                let value = words[count];
                count += 1;
                value
            });
            source.next::<kind::Plate>()
        };
        assert_eq!(count, 16);
        assert_eq!(
            actual.as_utf16(),
            case["uuid"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn clones_and_filament_widening_share_immutable_text_without_logging_it() {
    let mut raw: Vec<u16> = "import:test:PRIVATE_MARKER".encode_utf16().collect();
    raw.push(0xd800);
    assert!(
        String::from_utf16(&raw).is_err(),
        "ordinary Rust text would reject a valid persisted ID"
    );
    let owned: Arc<[u16]> = raw.into();
    let id = ObjectId::try_from_utf16(Arc::clone(&owned)).unwrap();
    assert_eq!(id.as_utf16().as_ptr(), owned.as_ptr());
    let cloned = id.clone();
    assert_eq!(cloned, id);
    assert_eq!(cloned.as_utf16().as_ptr(), id.as_utf16().as_ptr());
    assert!(!format!("{id:?}").contains("PRIVATE_MARKER"));
    let invalid = ObjectId::try_from_str("PRIVATE_MARKER invalid").unwrap_err();
    assert_eq!(invalid.to_string(), "Invalid stable entity ID.");
    for widened in [
        FilamentId::from(PhysicalFilamentId::try_from_utf16(Arc::clone(&owned)).unwrap()),
        FilamentId::from(MixedFilamentId::try_from_utf16(Arc::clone(&owned)).unwrap()),
    ] {
        assert_eq!(widened.as_utf16().as_ptr(), owned.as_ptr());
        assert_eq!(widened.as_utf16(), &*owned);
    }
}
