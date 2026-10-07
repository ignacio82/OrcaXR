use orcaxr_archive::bbs::facets::{self, DecodeBudget, Error, Paint, Tree};
use orcaxr_contracts::canonical::Value;
use orcaxr_project::facets::{
    Channel, FacetChannel, FacetError, Node, PaintValue, Split, State, Triangle,
};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{self, Write},
};
fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-facet-vectors.json"
    ))
    .unwrap()
}
fn table(c: &Json, profile: &str) -> Vec<Option<PaintValue>> {
    let text = |s: &str| Some(PaintValue::text(s.encode_utf16().collect::<Vec<_>>()));
    match profile {
        "support" => vec![None, text("enforce"), text("block")],
        "seam" => vec![None, text("prefer"), text("avoid")],
        "fuzzySkin" => vec![None, Some(PaintValue::Bool(true))],
        _ => c["table"]
            .as_array()
            .unwrap()
            .iter()
            .take(if profile == "color" { 65 } else { 256 })
            .map(|v| {
                v.as_array().map(|a| {
                    PaintValue::text(
                        a.iter()
                            .map(|n| n.as_u64().unwrap() as u16)
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .collect(),
    }
}
fn paint(value: &PaintValue) -> Paint<'_> {
    match value {
        PaintValue::Text(v) => Paint::Text(v),
        PaintValue::Bool(v) => Paint::Bool(*v),
    }
}
fn json(v: &Value) -> String {
    let mut out = vec![];
    v.write_canonical(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn verify_case(c: &Json, row: &Json, profile: &str, budget: &mut DecodeBudget) {
    let map = table(c, profile);
    let mut visits = vec![];
    let root = facets::decode(
        row["encoded"].as_str().unwrap().as_bytes(),
        20_000_000,
        budget,
        |n| {
            visits.push(n);
            map.get(n as usize).cloned().flatten()
        },
        || false,
    );
    assert_eq!(budget.remaining_nodes(), row["remaining"].as_i64().unwrap());
    assert_eq!(serde_json::to_value(visits).unwrap(), row["visits"]);
    match root {
        Err(e) => assert_eq!(
            format!("{e:?}"),
            row["error"].as_str().unwrap(),
            "{}",
            row["name"]
        ),
        Ok(node) => {
            let value = node.to_value();
            assert_eq!(
                json(&value),
                row["nodeJson"].as_str().unwrap(),
                "{}",
                row["name"]
            );
            for tree in [Tree::Computed(&node), Tree::Persisted(&value)] {
                let mut out = vec![];
                let mut visits = vec![];
                let n = facets::write(
                    tree,
                    |v| {
                        let n = map
                            .iter()
                            .position(|x| x.as_ref().is_some_and(|x| paint(x) == v));
                        if let Some(n) = n {
                            visits.push(n);
                        }
                        n.map(|v| v as u8)
                    },
                    &mut out,
                    20_000_000,
                    || false,
                )
                .unwrap();
                assert_eq!(out.len(), n);
                assert_eq!(out, row["encoded"].as_str().unwrap().as_bytes());
                assert_eq!(serde_json::to_value(visits).unwrap(), row["encodeVisits"]);
            }
        }
    }
}
#[test]
fn browser_wire_roots_callback_order_and_shared_budgets() {
    let c = corpus();
    for row in c["cases"].as_array().unwrap() {
        verify_case(
            &c,
            row,
            row["profile"].as_str().unwrap(),
            &mut DecodeBudget::new(row["initialNodes"].as_u64().unwrap() as usize).unwrap(),
        );
    }
    for sequence in c["sequences"].as_array().unwrap() {
        let mut budget =
            DecodeBudget::new(sequence["initialNodes"].as_u64().unwrap() as usize).unwrap();
        for row in sequence["steps"].as_array().unwrap() {
            verify_case(&c, row, sequence["profile"].as_str().unwrap(), &mut budget);
        }
    }
}
#[test]
fn exhaustive_small_hex_streams_match_browser_acceptance_and_charges() {
    let c = corpus();
    let map = table(&c, "all");
    let mut hash = Sha256::new();
    let mut count = 0;
    for length in 1..=4 {
        for n in 0..16u32.pow(length) {
            let encoded = format!("{n:0width$X}", width = length as usize);
            let mut budget = DecodeBudget::new(16).unwrap();
            let mut visits = vec![];
            let root = facets::decode(
                encoded.as_bytes(),
                100,
                &mut budget,
                |n| {
                    visits.push(n.to_string());
                    map[n as usize].clone()
                },
                || false,
            );
            let outcome = match root {
                Ok(node) => json(&node.to_value()),
                Err(e) => format!("{e:?}"),
            };
            hash.update(format!(
                "{encoded}|{}|{outcome}|{}\n",
                budget.remaining_nodes(),
                visits.join(",")
            ));
            count += 1;
        }
    }
    assert_eq!(count, c["exhaustive"]["cases"].as_u64().unwrap());
    assert_eq!(
        format!("{:x}", hash.finalize()),
        c["exhaustive"]["sha256"].as_str().unwrap()
    );
}
#[test]
fn sparse_decoded_channels_match_dense_browser_normalization() {
    let c = corpus();
    for row in c["sparse"].as_array().unwrap() {
        let profile = row["profile"].as_str().unwrap();
        let channel = match profile {
            "color" => Channel::Color,
            "support" => Channel::Support,
            "seam" => Channel::Seam,
            _ => Channel::FuzzySkin,
        };
        let map = table(&c, profile);
        let filaments: BTreeSet<_> = map
            .iter()
            .filter_map(|v| match v {
                Some(PaintValue::Text(s)) => Some(s.to_vec()),
                _ => None,
            })
            .collect();
        let mut budget = DecodeBudget::new(100).unwrap();
        let mut roots = vec![];
        for entry in row["entries"].as_array().unwrap() {
            roots.push(Split {
                triangle: Triangle::new(entry["triangle"].as_f64().unwrap()).unwrap(),
                node: facets::decode(
                    entry["encoded"].as_str().unwrap().as_bytes(),
                    1024,
                    &mut budget,
                    |n| map.get(n as usize).cloned().flatten(),
                    || false,
                )
                .unwrap(),
            });
        }
        let result = FacetChannel::from_sparse_roots(
            channel,
            Triangle::new(row["triangleCount"].as_f64().unwrap()).unwrap(),
            roots,
            Some(&filaments),
        )
        .unwrap();
        assert_eq!(
            json(&result.to_value()),
            row["expectedJson"].as_str().unwrap()
        );
        assert_eq!(budget.remaining_nodes(), row["remaining"].as_i64().unwrap());
    }
}
#[test]
fn cancellation_caps_output_faults_and_private_errors() {
    assert!(matches!(
        DecodeBudget::new(facets::MAX_AGGREGATE_NODES + 1),
        Err(Error::Limits)
    ));
    assert_eq!(
        facets::decode(
            b"4",
            0,
            &mut DecodeBudget::new(1).unwrap(),
            |_| Some(PaintValue::Bool(true)),
            || false
        ),
        Err(Error::EncodedSize)
    );
    let mut budget = DecodeBudget::new(4).unwrap();
    assert_eq!(
        facets::decode(b"0003", 4, &mut budget, |_| None, || true),
        Err(Error::Cancelled)
    );
    assert_eq!(budget.remaining_nodes(), 4);
    let root = Node::split(3, 0, vec![Node::leaf(State::Unpainted); 4]).unwrap();
    for stop in 0..20 {
        let mut ticks = 0;
        let mut out = vec![];
        let result = facets::write(
            Tree::Computed(&root),
            |_| None,
            &mut out,
            100,
            || {
                ticks += 1;
                ticks > stop
            },
        );
        if result == Err(Error::Cancelled) {
            assert!(out.is_empty() || out == b"00003");
        }
    }
    let mut out = vec![];
    assert_eq!(
        facets::write(Tree::Computed(&root), |_| None, &mut out, 4, || false),
        Err(Error::OutputLimit)
    );
    assert!(out.is_empty());
    struct Fault;
    impl Write for Fault {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private filename and credential",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("codec does not publish or flush host storage")
        }
    }
    let error =
        facets::write(Tree::Computed(&root), |_| None, &mut Fault, 100, || false).unwrap_err();
    assert_eq!(error, Error::Io(io::ErrorKind::PermissionDenied));
    assert!(!format!("{error:?} {error}").contains("credential"));
    let mut calls = 0;
    let mut budget = DecodeBudget::new(20).unwrap();
    assert_eq!(
        facets::decode(
            b"4443",
            100,
            &mut budget,
            |_| Some(PaintValue::Bool(true)),
            || {
                calls += 1;
                calls == 5
            }
        ),
        Err(Error::Cancelled)
    );
    assert!(budget.remaining_nodes() > 0);
}
#[test]
fn root_node_limit_and_raw_persisted_depth_are_enforced() {
    let mut encoded = String::from("0");
    for _ in 0..10 {
        encoded = encoded.repeat(4) + "3";
    }
    let mut budget = DecodeBudget::new(2_000_000).unwrap();
    assert_eq!(
        facets::decode(
            encoded.as_bytes(),
            encoded.len(),
            &mut budget,
            |_| None,
            || false
        ),
        Err(Error::NodeLimit)
    );
    assert_eq!(budget.remaining_nodes(), 999_999);
    let key = |s: &str| s.encode_utf16().collect::<Vec<_>>();
    let leaf = Node::leaf(State::Unpainted).to_value();
    let mut root = leaf.clone();
    for _ in 0..65 {
        root = Value::Object(
            [
                (key("kind"), Value::String(key("split"))),
                (key("splitSides"), Value::Number(1.0)),
                (key("specialSide"), Value::Number(0.0)),
                (key("children"), Value::Array(vec![root, leaf.clone()])),
            ]
            .into(),
        );
    }
    assert_eq!(
        facets::write(
            Tree::Persisted(&root),
            |_| None,
            &mut io::sink(),
            1000,
            || false
        ),
        Err(Error::DepthLimit)
    );
    let mut tree = Node::leaf(State::Unpainted);
    for _ in 0..10 {
        tree = Node::split(3, 0, vec![tree.clone(), tree.clone(), tree.clone(), tree]).unwrap();
    }
    assert_eq!(
        facets::write(
            Tree::Computed(&tree),
            |_| None,
            &mut io::sink(),
            2_000_000,
            || false
        ),
        Err(Error::NodeLimit)
    );
}
#[test]
fn malformed_persisted_nodes_and_partial_streams_remain_private() {
    for raw in [
        "null",
        r#"{"kind":"leaf"}"#,
        r#"{"kind":"leaf","state":{"kind":"assigned","value":3}}"#,
        r#"{"kind":"split","splitSides":1,"specialSide":0,"children":[]}"#,
        r#"{"kind":"split","splitSides":1.5,"specialSide":0,"children":[]}"#,
    ] {
        let value = orcaxr_contracts::canonical::parse(raw).unwrap();
        let mut out = vec![];
        assert!(
            facets::write(
                Tree::Persisted(&value),
                |_| panic!("invalid scalar must not invoke mapper"),
                &mut out,
                100,
                || false
            )
            .is_err()
        );
        assert!(out.is_empty());
    }
    let mut tree = Node::leaf(State::Unpainted);
    for _ in 0..7 {
        tree = Node::split(3, 0, vec![tree.clone(), tree.clone(), tree.clone(), tree]).unwrap();
    }
    struct Short {
        calls: usize,
        out: Vec<u8>,
    }
    impl Write for Short {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            assert!(b.len() <= 4096);
            self.calls += 1;
            if self.calls.is_multiple_of(5) {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let n = b.len().min(37);
            self.out.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host-owned flush")
        }
    }
    let mut short = Short {
        calls: 0,
        out: vec![],
    };
    let n = facets::write(
        Tree::Computed(&tree),
        |_| None,
        &mut short,
        100_000,
        || false,
    )
    .unwrap();
    assert_eq!(n, short.out.len());
    assert_eq!(
        facets::decode(
            &short.out,
            100_000,
            &mut DecodeBudget::new(100_000).unwrap(),
            |_| None,
            || false
        )
        .unwrap(),
        tree
    );
    let cancelled = std::cell::Cell::new(false);
    struct Cancel<'a>(&'a std::cell::Cell<bool>, usize);
    impl Write for Cancel<'_> {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            assert!(!self.0.get());
            self.0.set(true);
            self.1 += b.len();
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("no drop flush")
        }
    }
    let mut output = Cancel(&cancelled, 0);
    assert_eq!(
        facets::write(
            Tree::Computed(&tree),
            |_| None,
            &mut output,
            100_000,
            || cancelled.get()
        ),
        Err(Error::Cancelled)
    );
    assert_eq!(output.1, 4096);
    cancelled.set(false);
    struct Interrupted<'a>(&'a std::cell::Cell<bool>);
    impl Write for Interrupted<'_> {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            assert!(!self.0.replace(true), "cancellation must interrupt retry");
            Err(io::ErrorKind::Interrupted.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("host-owned flush")
        }
    }
    assert_eq!(
        facets::write(
            Tree::Computed(&tree),
            |_| None,
            &mut Interrupted(&cancelled),
            100_000,
            || cancelled.get()
        ),
        Err(Error::Cancelled)
    );
}
#[test]
fn sparse_import_refuses_duplicate_unsorted_out_of_range_and_invalid_values() {
    let count = Triangle::new(10.0).unwrap();
    let unpainted = || Node::leaf(State::Unpainted);
    for indices in [vec![1., 1.], vec![2., 1.], vec![10.]] {
        let roots = indices
            .into_iter()
            .map(|i| Split {
                triangle: Triangle::new(i).unwrap(),
                node: unpainted(),
            })
            .collect();
        assert_eq!(
            FacetChannel::from_sparse_roots(Channel::Color, count, roots, None),
            Err(FacetError::InvalidTriangle)
        );
    }
    let bad = vec![Split {
        triangle: Triangle::new(1.0).unwrap(),
        node: Node::leaf(State::Assigned(PaintValue::Bool(false))),
    }];
    assert_eq!(
        FacetChannel::from_sparse_roots(Channel::FuzzySkin, count, bad, None),
        Err(FacetError::InvalidValue)
    );
    assert!(
        FacetChannel::from_sparse_roots(Channel::Color, Triangle::new(0.0).unwrap(), vec![], None)
            .unwrap()
            .assignments()
            .is_empty()
    );
}
#[test]
fn reference_sources_match_current_production_helpers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for row in corpus()["sources"].as_array().unwrap() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(root.join(row["path"].as_str().unwrap())).unwrap())
            ),
            row["sha256"].as_str().unwrap()
        );
    }
}
