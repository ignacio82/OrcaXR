use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    model::*,
    query::{layout::*, *},
    store::*,
};
use serde_json::Value;
use std::sync::Arc;
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-query-vectors.json"
    ))
    .unwrap()
}
fn store(case: &Value) -> ProjectStore {
    let data = ProjectData::new(
        ProjectState::from_value(parse(case["stateJson"].as_str().unwrap()).unwrap()).unwrap(),
    )
    .unwrap();
    // The independent producer admits these documents with the production
    // TypeScript validator. Timestamp service parity has its own corpus.
    ProjectStore::admit(data, &mut |_: &[u16]| Ok::<_, ()>(true)).unwrap()
}
fn at(root: &QueryNode, path: &Value) -> QueryNode {
    let mut node = root.clone();
    for pair in path.as_array().unwrap().chunks_exact(2) {
        let relation = *Relation::ALL
            .iter()
            .find(|r| r.as_str() == pair[0].as_str().unwrap())
            .unwrap();
        node = node
            .children(relation, MAX_INDEX)
            .unwrap()
            .node(pair[1].as_u64().unwrap() as usize)
            .unwrap();
    }
    node
}
fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_f64().unwrap())
        .collect()
}
#[test]
fn every_node_matches_independent_typescript_fields_order_and_paging() {
    let f = corpus();
    let mut count = 0;
    for case in f["cases"].as_array().unwrap() {
        let root = QueryNode::new(store(case).snapshot());
        for expected in case["nodes"].as_array().unwrap() {
            let node = at(&root, &expected["path"]);
            assert_eq!(node.kind().as_str(), expected["kind"].as_str().unwrap());
            assert_eq!(
                node.metadata().unwrap(),
                numbers(&expected["packet"]),
                "{} / {}",
                case["name"],
                expected["path"]
            );
            for (name, index) in expected["texts"].as_object().unwrap() {
                let field = *TextField::ALL.iter().find(|f| f.as_str() == name).unwrap();
                if index.is_null() {
                    assert!(node.text(field).unwrap().is_none());
                    assert!(node.read_text(field, 0, 0).is_err());
                    continue;
                }
                let wanted = f["texts"][index.as_u64().unwrap() as usize]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u16)
                    .collect::<Vec<_>>();
                assert_eq!(node.text(field).unwrap(), Some(wanted.as_slice()));
                let mut actual = Vec::new();
                for start in (0..wanted.len()).step_by(997) {
                    actual.extend(
                        node.read_text(field, start, 997.min(wanted.len() - start))
                            .unwrap(),
                    );
                }
                assert_eq!(actual, wanted);
                assert_eq!(
                    node.read_text(field, wanted.len(), 0).unwrap(),
                    Vec::<u16>::new()
                );
            }
            for (relation, length) in expected["children"].as_object().unwrap() {
                let relation = *Relation::ALL
                    .iter()
                    .find(|r| r.as_str() == relation)
                    .unwrap();
                let list = node.children(relation, MAX_INDEX).unwrap();
                let length = length.as_u64().unwrap() as usize;
                assert_eq!(list.len(), length);
                assert_eq!(list.is_empty(), length == 0);
                for start in (0..length).step_by(17) {
                    let count = 17.min(length - start);
                    let mut packet =
                        vec![VERSION as f64, length as f64, start as f64, count as f64];
                    for p in start..start + count {
                        let mut path = expected["path"].as_array().unwrap().clone();
                        path.extend([Value::String(relation.as_str().into()), Value::from(p)]);
                        let row = case["nodes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|v| v["path"] == Value::Array(path.clone()))
                            .unwrap();
                        let row = numbers(&row["packet"]);
                        packet.push(row.len() as f64);
                        packet.extend(row);
                    }
                    assert_eq!(list.page(start, count).unwrap(), packet);
                }
                assert_eq!(
                    list.page(length, 0).unwrap(),
                    vec![VERSION as f64, length as f64, length as f64, 0.0]
                );
            }
            count += 1;
        }
    }
    assert!(count >= 4770);
}
#[test]
fn budgets_refuse_before_sorting_and_captures_survive_new_revisions_and_disposal() {
    let f = corpus();
    let case = f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "authored/sorted-wide-list")
        .unwrap();
    let mut store = store(case);
    let root = QueryNode::new(store.snapshot());
    assert!(matches!(
        root.children(Relation::Plates, 136),
        Err("resource_limit")
    ));
    let plates = root.children(Relation::Plates, 137).unwrap();
    assert!(matches!(plates.page(0, 65), Err("invalid_range")));
    for (start, count) in [(138, 0), (137, 1), (usize::MAX, 1), (1, usize::MAX)] {
        assert!(plates.page(start, count).is_err());
    }
    assert!(plates.node(137).is_err());
    assert!(matches!(
        root.children(Relation::Objects, 137),
        Err("invalid_relation")
    ));
    assert!(matches!(root.text(TextField::Color), Err("invalid_field")));
    let saved = plates.page(0, 64).unwrap();
    let first = plates.node(0).unwrap();
    let name = first.text(TextField::Name).unwrap().unwrap().to_vec();
    let mut next = store.snapshot().project().to_candidate();
    Arc::make_mut(&mut Arc::make_mut(&mut next.plates)[136]).name = Text::from_utf8("changed");
    let changed = store
        .replace(
            ProjectData::new(next).unwrap(),
            ReplaceOptions::default(),
            &mut |_: &[u16]| Ok::<_, ()>(true),
        )
        .unwrap();
    assert_eq!(changed.current().revision(), 1);
    assert_eq!(first.snapshot().revision(), 0);
    assert_ne!(first.snapshot().hash(), store.snapshot().hash());
    drop(changed);
    drop(root);
    drop(store);
    assert_eq!(plates.page(0, 64).unwrap(), saved);
    drop(plates);
    assert_eq!(first.text(TextField::Name).unwrap().unwrap(), name);
    assert!(matches!(
        first.read_text(TextField::Name, 0, MAX_TEXT_CHUNK_UNITS + 1),
        Err("invalid_range")
    ));
    assert!(matches!(
        first.read_text(TextField::Name, usize::MAX, 0),
        Err("invalid_range")
    ));
}
#[test]
fn generated_codes_retain_model_literal_order_and_preserve_binary64_not_safe_integer_limits() {
    let schema: Value =
        serde_json::from_str(include_str!("../../../../contracts/project-query.json")).unwrap();
    for (name, values) in [
        (
            "role",
            VolumeRole::VALUES
                .iter()
                .map(|v| v.as_str())
                .collect::<Vec<_>>(),
        ),
        (
            "assetKind",
            SourceAssetKind::VALUES.iter().map(|v| v.as_str()).collect(),
        ),
        (
            "positionsType",
            MeshComponentType::VALUES
                .iter()
                .map(|v| v.as_str())
                .collect(),
        ),
    ] {
        assert_eq!(
            serde_json::to_value(values).unwrap(),
            schema["numbers"][name]
        );
    }
    assert!(number_valid(NumberField::Order, 1.0e100));
    assert!(!number_valid(NumberField::PlateCount, 1.0e100));
    assert!(number_valid(NumberField::PositionsStride, -0.125));
    assert!(!number_valid(NumberField::ToolId, -1.0));
    for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        for field in NumberField::ALL {
            assert!(!number_valid(*field, value));
        }
    }
}
