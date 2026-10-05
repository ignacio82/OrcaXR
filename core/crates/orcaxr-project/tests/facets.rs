use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::facets::{
    Channel, FacetChannel, FacetError, Issue, Node, NodeKind, PaintValue, State, Triangle,
    ValidationOptions, node_budget, validate_refinement,
};
use serde_json::{Value as Json, json};
use std::collections::BTreeSet;

fn fixture() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/facet-refinement-vectors.json"
    ))
    .unwrap()
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    let Value::Object(fields) = value else {
        panic!()
    };
    &fields[&key.encode_utf16().collect::<Vec<_>>()]
}
fn array(value: &Value) -> &[Value] {
    let Value::Array(values) = value else {
        panic!()
    };
    values
}
fn number(value: &Value) -> f64 {
    let Value::Number(value) = value else {
        panic!()
    };
    *value
}
fn text(value: &Value) -> String {
    let Value::String(value) = value else {
        panic!()
    };
    String::from_utf16(value).unwrap()
}
fn paint(value: &Value) -> PaintValue {
    match value {
        Value::String(v) => PaintValue::text(v.clone()),
        Value::Bool(v) => PaintValue::Bool(*v),
        _ => panic!(),
    }
}
fn node(value: &Value) -> Node {
    if text(field(value, "kind")) == "leaf" {
        let state = field(value, "state");
        Node::leaf(if text(field(state, "kind")) == "unpainted" {
            State::Unpainted
        } else {
            State::Assigned(paint(field(state, "value")))
        })
    } else {
        Node::split(
            number(field(value, "splitSides")) as u8,
            number(field(value, "specialSide")) as u8,
            array(field(value, "children")).iter().map(node).collect(),
        )
        .unwrap()
    }
}
fn channel(value: &Json) -> Channel {
    Channel::ALL
        .into_iter()
        .find(|v| v.name() == value.as_str().unwrap())
        .unwrap()
}
fn filaments(fixture: &Json) -> BTreeSet<Vec<u16>> {
    fixture["filamentIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            v.as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect()
        })
        .collect()
}
fn issues(issues: Vec<Issue>) -> Json {
    Json::Array(
        issues
            .into_iter()
            .map(|v| json!({"code":v.code,"path":v.path,"message":v.message}))
            .collect(),
    )
}
fn scalar() -> PaintValue {
    PaintValue::text("import:filament:a".encode_utf16().collect::<Vec<_>>())
}
fn leaf() -> Node {
    Node::leaf(State::Unpainted)
}

#[test]
fn matches_typescript_encoding_validation_and_issue_order() {
    let fixture = fixture();
    let ids = filaments(&fixture);
    for case in fixture["validation"].as_array().unwrap() {
        let channel = channel(&case["channel"]);
        let path = format!("paint.{}", channel.name());
        let options = ValidationOptions {
            triangle_count: case["triangleCount"].as_f64().unwrap(),
            filament_ids: if case["unrestrictedColors"] == true {
                None
            } else {
                Some(&ids)
            },
            path: &path,
            require_split: case["requireSplit"].as_bool().unwrap(),
        };
        let candidate = parse(case["candidateJson"].as_str().unwrap()).unwrap();
        let assignments = parse(case["assignmentsJson"].as_str().unwrap()).unwrap();
        let actual = validate_refinement(channel, &candidate, &assignments, &options);
        assert_eq!(issues(actual), case["expected"], "{}", case["name"]);
        if case["expected"].as_array().unwrap().is_empty() && options.require_split {
            let decoded =
                FacetChannel::decode(channel, &assignments, Some(&candidate), &options).unwrap();
            assert_eq!(
                canonical(&decoded.encoding().unwrap().to_value()),
                canonical(&candidate)
            );
        }
    }
}
#[test]
fn matches_graph_validator_for_whole_facet_assignments() {
    let fixture = fixture();
    let ids = filaments(&fixture);
    for case in fixture["assignmentCases"].as_array().unwrap() {
        let options = ValidationOptions {
            filament_ids: Some(&ids),
            ..ValidationOptions::new(4.0, "unused")
        };
        let assignments = parse(case["assignmentsJson"].as_str().unwrap()).unwrap();
        let result = FacetChannel::decode(channel(&case["channel"]), &assignments, None, &options);
        let actual = match result {
            Ok(_) => vec![],
            Err(issues) => issues,
        };
        assert_eq!(issues(actual), case["expected"], "{}", case["name"]);
    }
}
#[test]
fn matches_normalization_remap_expansion_lookup_visit_and_replacement_traces() {
    let fixture = fixture();
    let ids = filaments(&fixture);
    for case in fixture["operations"].as_array().unwrap() {
        let roots = parse(case["rootsJson"].as_str().unwrap()).unwrap();
        let count = array(&roots).len();
        let source = FacetChannel::from_roots(
            channel(&case["channel"]),
            array(&roots).iter().map(node).collect(),
            Some(&ids),
        )
        .unwrap();
        assert_eq!(
            canonical(&source.to_value()),
            case["collapsedJson"],
            "{} collapse",
            case["name"]
        );
        let expanded = source.expand(count).unwrap();
        assert_eq!(
            canonical(&Value::Array(expanded.iter().map(Node::to_value).collect())),
            case["expandedJson"],
            "{} expand",
            case["name"]
        );
        assert_eq!(
            source,
            FacetChannel::from_roots(channel(&case["channel"]), expanded, Some(&ids)).unwrap()
        );
        if count > 0 {
            assert_eq!(source.expand(count - 1), Err(FacetError::DenseLimit));
        }
        let mapping = parse(case["mappingJson"].as_str().unwrap()).unwrap();
        let mapped = source
            .remap(
                |value| {
                    array(&mapping)
                        .iter()
                        .find_map(|v| {
                            let pair = array(v);
                            (paint(&pair[0]) == *value).then(|| paint(&pair[1]))
                        })
                        .unwrap()
                },
                Some(&ids),
            )
            .unwrap();
        assert_eq!(
            canonical(&mapped.to_value()),
            case["mappedJson"],
            "{} remap",
            case["name"]
        );
        let mut visits = vec![];
        if let Some(encoding) = source.encoding() {
            encoding.visit_assigned(|value, path| {
                visits.push(json!({"valueJson":canonical(&value.to_value()),"path":path}))
            });
        }
        assert_eq!(json!(visits), case["visits"], "{} visit", case["name"]);
        assert_eq!(
            source.encoding().map_or(0, |v| v.assigned_leaf_count()),
            case["count"].as_u64().unwrap() as usize
        );
        let lookups = (0..=count)
            .map(|i| {
                source
                    .encoding()
                    .and_then(|v| v.split_at(Triangle::new(i as f64).unwrap()))
                    .map(Node::to_value)
                    .unwrap_or(Value::Null)
            })
            .collect();
        assert_eq!(canonical(&Value::Array(lookups)), case["lookupsJson"]);
        let remove = case["remove"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| Triangle::new(v.as_f64().unwrap()).unwrap())
            .collect();
        assert_eq!(
            canonical(&source.without_splits(&remove).to_value()),
            case["removedJson"]
        );
        // Failure must leave the immutable source and its paint unchanged.
        assert_eq!(
            source
                .remap(
                    |_| PaintValue::text("not-a-filament".encode_utf16().collect::<Vec<_>>()),
                    Some(&ids)
                )
                .is_err(),
            source.assignments().iter().any(|_| true)
                || source
                    .encoding()
                    .is_some_and(|v| v.assigned_leaf_count() > 0)
        );
        assert_eq!(canonical(&source.to_value()), case["collapsedJson"]);
    }
}
fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn chain_value(depth: usize) -> Value {
    let mut node = Node::leaf(State::Assigned(scalar())).to_value();
    for _ in 0..depth {
        node = object([
            ("kind", Value::String("split".encode_utf16().collect())),
            ("splitSides", Value::Number(1.0)),
            ("specialSide", Value::Number(0.0)),
            ("children", Value::Array(vec![node, leaf().to_value()])),
        ]);
    }
    object([
        ("version", Value::Number(2.0)),
        ("triangleCount", Value::Number(4.0)),
        (
            "splits",
            Value::Array(vec![object([
                ("triangle", Value::Number(1.0)),
                ("node", node),
            ])]),
        ),
    ])
}
#[test]
fn exact_depth_boundary_is_independent_of_stateless_parser_limits() {
    let fixture = fixture();
    let ids = filaments(&fixture);
    let options = ValidationOptions {
        filament_ids: Some(&ids),
        ..ValidationOptions::new(4.0, "paint.color")
    };
    for case in fixture["depthCases"].as_array().unwrap() {
        let depth = case["levels"].as_u64().unwrap() as usize;
        let value = chain_value(depth);
        assert_eq!(
            issues(validate_refinement(
                Channel::Color,
                &value,
                &Value::Array(vec![]),
                &options
            )),
            case["expected"]
        );
        if depth <= 64 {
            let decoded = FacetChannel::decode(
                Channel::Color,
                &Value::Array(vec![]),
                Some(&value),
                &options,
            )
            .unwrap();
            assert_eq!(
                canonical(&decoded.encoding().unwrap().to_value()),
                canonical(&value)
            );
            assert_eq!(decoded.encoding().unwrap().assigned_leaf_count(), 1);
        }
    }
    let mut node = leaf();
    for _ in 0..64 {
        node = Node::split(1, 0, vec![node, leaf()]).unwrap();
    }
    assert_eq!(
        Node::split(1, 0, vec![node, leaf()]),
        Err(FacetError::DepthLimit)
    );
}
#[test]
fn constructors_and_materialization_reject_unusable_data_without_changing_source() {
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 0.5] {
        assert_eq!(Triangle::new(invalid), Err(FacetError::InvalidTriangle));
    }
    assert_eq!(Triangle::new(-0.0), Triangle::new(0.0));
    assert_eq!(Node::split(0, 0, vec![]), Err(FacetError::InvalidTopology));
    assert_eq!(
        Node::split(3, 1, vec![leaf(); 4]),
        Err(FacetError::InvalidTopology)
    );
    assert_eq!(
        Node::split(2, 0, vec![leaf(); 2]),
        Err(FacetError::InvalidTopology)
    );
    assert_eq!(
        FacetChannel::from_roots(
            Channel::FuzzySkin,
            vec![Node::leaf(State::Assigned(PaintValue::Bool(false)))],
            None
        ),
        Err(FacetError::InvalidValue)
    );
    let options = ValidationOptions::new(1e100, "refinement.color");
    let huge = FacetChannel::decode(Channel::Color, &Value::Array(vec![]), None, &options).unwrap();
    assert_eq!(huge.expand(usize::MAX), Err(FacetError::DenseLimit));
    assert_eq!(huge.remap(Clone::clone, None).unwrap(), huge);
    for malformed in [
        Value::Null,
        Value::Bool(false),
        Value::Array(vec![Value::Null]),
    ] {
        assert!(FacetChannel::decode(Channel::Color, &malformed, None, &options).is_err());
    }
    // An empty transient refinement is accepted by the raw validator only;
    // canonical computation views require its complete omission.
    let empty = parse(r#"{"version":2,"triangleCount":4,"splits":[]}"#).unwrap();
    let options = ValidationOptions {
        require_split: false,
        ..ValidationOptions::new(4.0, "refinement.color")
    };
    assert!(
        validate_refinement(Channel::Color, &empty, &Value::Array(vec![]), &options).is_empty()
    );
    assert!(
        FacetChannel::decode(
            Channel::Color,
            &Value::Array(vec![]),
            Some(&empty),
            &options
        )
        .is_err()
    );
}
#[test]
fn aggregate_budget_is_expansion_based_and_checked_before_normalizing() {
    assert_eq!(node_budget(1.0), 1_000_000.0);
    assert_eq!(node_budget(1_897_256.0), 60_712_192.0);
    assert!(node_budget(f64::NAN).is_nan());
    // One 4-way depth-ten tree has 1,398,101 nodes. It must be rejected even
    // though normalization would otherwise collapse all of its leaves.
    let mut node = leaf();
    for _ in 0..10 {
        node = Node::split(3, 0, vec![node; 4]).unwrap();
    }
    assert_eq!(
        FacetChannel::from_roots(Channel::Brim, vec![node], None),
        Err(FacetError::NodeLimit)
    );
}
#[test]
fn remap_moves_a_newly_uniform_split_into_whole_facet_paint() {
    let a = PaintValue::text("import:filament:a".encode_utf16().collect::<Vec<_>>());
    let b = PaintValue::text("import:filament:b".encode_utf16().collect::<Vec<_>>());
    let source = FacetChannel::from_roots(
        Channel::Color,
        vec![
            Node::split(
                1,
                0,
                vec![
                    Node::leaf(State::Assigned(a.clone())),
                    Node::leaf(State::Assigned(b)),
                ],
            )
            .unwrap(),
        ],
        None,
    )
    .unwrap();
    let mapped = source.remap(|_| a.clone(), None).unwrap();
    assert!(mapped.encoding().is_none());
    assert_eq!(
        mapped.assignments()[0].triangles,
        [Triangle::new(0.0).unwrap()]
    );
    assert!(
        matches!(mapped.expand(1).unwrap()[0].kind(),NodeKind::Leaf(State::Assigned(value)) if *value==a)
    );
    assert!(source.encoding().is_some());
    assert!(source.assignments().is_empty());
}
