//! Facet region selection against the browser: face neighbours of every corpus
//! mesh, then Triangle, Fill, Height Range, Gap Fill, Circle and Sphere
//! selections, refined ones included, refusals and stale topologies, each equal
//! to `selectFacetRegion`'s result; the tree each refined commit leaves
//! (`facetRefinementAfterSelection`) and the commit helpers' refusals.
use orcaxr_contracts::canonical::{self, Value as Canonical};
use orcaxr_project::facets::{
    Channel, PaintValue,
    region::{
        self, Assignment, Brush, ClippingPlane, EncodedNode, GapFillReplacement, LeafRef, Mesh,
        RefinedLeaf, RefinedSelection, RegionError, RegionState, Request, Selection, StateUpdate,
        Tool, Transform,
    },
};
use serde_json::Value;
use std::collections::BTreeMap;

/// Vertices and triangles, as the fixture lists them.
type CorpusMesh = (Vec<[f64; 3]>, Vec<[f64; 3]>);

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/facet-region-vectors.json"
    ))
    .unwrap()
}
fn number(v: &Value) -> f64 {
    v.as_f64().unwrap()
}
fn vec3(v: &Value) -> [f64; 3] {
    let a = v.as_array().unwrap();
    [number(&a[0]), number(&a[1]), number(&a[2])]
}
fn paint(v: &Value) -> PaintValue {
    match v {
        Value::String(s) => PaintValue::text(s.encode_utf16().collect::<Vec<_>>()),
        Value::Bool(b) => PaintValue::Bool(*b),
        other => panic!("unrepresentable paint value {other}"),
    }
}
fn channel(name: &str) -> Channel {
    Channel::ALL.into_iter().find(|c| c.name() == name).unwrap()
}
fn state(v: &Value) -> RegionState {
    match v["kind"].as_str().unwrap() {
        "unpainted" => RegionState::Unpainted,
        _ => RegionState::Assigned(paint(&v["value"])),
    }
}
fn ranges(v: &Value) -> Vec<(u32, u32)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| (r[0].as_u64().unwrap() as u32, r[1].as_u64().unwrap() as u32))
        .collect()
}
fn indices(v: &Value) -> Vec<u32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|i| i.as_u64().unwrap() as u32)
        .collect()
}
fn tool(v: &Value) -> Tool {
    let hit = v.get("hit").map(vec3);
    match v["kind"].as_str().unwrap() {
        "triangle" => Tool::Triangle { hit },
        "fill" => Tool::Fill {
            hit,
            edge_detection: match &v["edgeDetection"] {
                Value::Bool(false) => None,
                e => Some(number(&e["maxAdjacentAngleDegrees"])),
            },
        },
        "heightRange" => Tool::HeightRange {
            start_z_mm: number(&v["startZMm"]),
            height_mm: number(&v["heightMm"]),
            triangle_splitting: v.get("triangleSplitting").and_then(Value::as_bool),
        },
        "gapFill" => Tool::GapFill {
            max_area_mm2: number(&v["maxAreaMm2"]),
            state_order: v["stateOrder"]
                .as_array()
                .unwrap()
                .iter()
                .map(paint)
                .collect(),
        },
        "circle" | "sphere" => {
            let brush = Brush {
                center: vec3(&v["center"]),
                previous_center: v.get("previousCenter").map(vec3),
                camera_position: vec3(&v["cameraPosition"]),
                radius_mm: number(&v["radiusMm"]),
                triangle_splitting: v.get("triangleSplitting").and_then(Value::as_bool),
            };
            if v["kind"] == "circle" {
                Tool::Circle(brush)
            } else {
                Tool::Sphere(brush)
            }
        }
        kind => panic!("unexpected tool {kind}"),
    }
}

fn path(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_u64().unwrap() as u8)
        .collect()
}
fn node(v: &Value) -> EncodedNode {
    if v["kind"] == "leaf" {
        EncodedNode::Leaf(state(&v["state"]))
    } else {
        EncodedNode::Split {
            split_sides: v["splitSides"].as_u64().unwrap() as u8,
            special_side: v["specialSide"].as_u64().unwrap() as u8,
            children: v["children"].as_array().unwrap().iter().map(node).collect(),
        }
    }
}
fn refined(v: &Value) -> RefinedSelection {
    RefinedSelection {
        edge_limit_mm: v.get("edgeLimitMm").map(number),
        vertices: v["vertices"].as_array().unwrap().iter().map(vec3).collect(),
        roots: v["roots"].as_array().unwrap().iter().map(node).collect(),
        leaves: v["leaves"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| RefinedLeaf {
                source_triangle: l["sourceTriangle"].as_u64().unwrap() as u32,
                path: path(&l["path"]),
                vertex_indices: {
                    let v = indices(&l["vertexIndices"]);
                    [v[0], v[1], v[2]]
                },
                state: state(&l["state"]),
                selected: l["selected"].as_bool().unwrap(),
            })
            .collect(),
    }
}
/// Host input as canonical JSON, exactly as the browser received it.
fn canonical_value(v: &Value) -> Canonical {
    canonical::parse(&serde_json::to_string(v).unwrap()).unwrap()
}

#[test]
fn region_selection_matches_the_browser() {
    let f = fixture();
    let meshes: Vec<CorpusMesh> = f["meshes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["vertices"].as_array().unwrap().iter().map(vec3).collect(),
                m["triangles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(vec3)
                    .collect(),
            )
        })
        .collect();
    let mesh = |i: usize| Mesh {
        vertices: &meshes[i].0,
        triangles: &meshes[i].1,
    };

    for (i, expected) in f["neighbors"].as_array().unwrap().iter().enumerate() {
        let actual = region::face_neighbors(mesh(i)).unwrap();
        let expected: Vec<[i64; 3]> = expected
            .as_array()
            .unwrap()
            .iter()
            .map(|n| {
                let n = n.as_array().unwrap();
                [0, 1, 2].map(|k| n[k].as_i64().unwrap())
            })
            .collect();
        assert_eq!(actual, expected, "neighbours of mesh {i}");
    }

    // The tree each refined commit leaves, by the case whose selection it commits.
    let mut commits_by_case: BTreeMap<usize, Vec<&Value>> = BTreeMap::new();
    for commit in f["commits"].as_array().unwrap() {
        commits_by_case
            .entry(commit["case"].as_u64().unwrap() as usize)
            .or_default()
            .push(commit);
    }
    let (mut selections, mut refusals, mut stale, mut materialized) = (0, 0, 0, 0);
    let mut commits = 0;
    for (index, case) in f["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let assignments: Vec<Assignment> = case["assignments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| Assignment {
                value: paint(&a["value"]),
                triangles: a["triangles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(number)
                    .collect(),
            })
            .collect();
        let r = &case["request"];
        let refinement = r.get("refinement").map(canonical_value);
        let refined_roots = r.get("refinedRoots").map(canonical_value);
        let request = Request {
            mesh: mesh(case["mesh"].as_u64().unwrap() as usize),
            channel: channel(case["channel"].as_str().unwrap()),
            annotations_topology_revision: number(&case["topologyRevision"]),
            assignments: &assignments,
            guard_topology_revision: number(&r["guard"]["topologyRevision"]),
            guard_triangle_count: number(&r["guard"]["triangleCount"]),
            seed_triangle: number(&r["seedTriangle"]),
            tool: tool(&r["tool"]),
            clipping_plane: r.get("clippingPlane").map(|p| ClippingPlane {
                normal: vec3(&p["normal"]),
                offset: number(&p["offset"]),
            }),
            transform: r.get("transform").map(|t| {
                let rows = t["linear"].as_array().unwrap();
                Transform {
                    linear: [vec3(&rows[0]), vec3(&rows[1]), vec3(&rows[2])],
                    translation: vec3(&t["translation"]),
                    scaling_factors: vec3(&t["scalingFactors"]),
                }
            }),
            highlight_by_angle_degrees: r.get("highlightByAngleDegrees").map(number),
            refinement: refinement.as_ref(),
            refined_roots: refined_roots.as_ref(),
        };
        let result = &case["result"];
        if let Some(expected) = result.get("materialized") {
            assert_eq!(
                region::materialize(&request),
                Ok(refined(expected)),
                "{name}"
            );
            materialized += 1;
            continue;
        }
        let actual = region::select(&request);
        if let Some(issues) = result.get("issues") {
            let Err(RegionError::Invalid(actual)) = actual else {
                panic!("{name}: expected refusal, got {actual:?}");
            };
            let actual: Vec<(&str, &str, &str)> = actual
                .iter()
                .map(|i| (i.code, i.path.as_str(), i.message.as_str()))
                .collect();
            let expected: Vec<(&str, &str, &str)> = issues
                .as_array()
                .unwrap()
                .iter()
                .map(|i| {
                    (
                        i["code"].as_str().unwrap(),
                        i["path"].as_str().unwrap(),
                        i["message"].as_str().unwrap(),
                    )
                })
                .collect();
            assert_eq!(actual, expected, "{name}");
            refusals += 1;
        } else if result.get("stale").is_some() {
            assert_eq!(actual, Err(RegionError::StaleTopology), "{name}");
            stale += 1;
        } else {
            let expected = Selection {
                triangle_indices: indices(&result["triangleIndices"]),
                ranges: ranges(&result["ranges"]),
                gap_fill_replacements: result.get("gapFillReplacements").map(|list| {
                    list.as_array()
                        .unwrap()
                        .iter()
                        .map(|r| GapFillReplacement {
                            area_mm2: number(&r["areaMm2"]),
                            source: state(&r["source"]),
                            target: state(&r["target"]),
                            triangle_indices: indices(&r["triangleIndices"]),
                            ranges: ranges(&r["ranges"]),
                            refined_leaves: r.get("refinedLeaves").map(|leaves| {
                                leaves
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|l| LeafRef {
                                        source_triangle: l["sourceTriangle"].as_u64().unwrap()
                                            as u32,
                                        path: path(&l["path"]),
                                    })
                                    .collect()
                            }),
                        })
                        .collect()
                }),
                refinement: result.get("refinement").map(refined),
            };
            assert_eq!(actual.as_ref(), Ok(&expected), "{name}");
            let after = |target: &RegionState| {
                region::refinement_after(
                    request.channel,
                    &expected,
                    &assignments,
                    request.guard_triangle_count as usize,
                    target,
                )
            };
            match commits_by_case.remove(&index) {
                Some(entries) => {
                    for commit in entries {
                        let target = commit.get("target").map_or(RegionState::Unpainted, state);
                        let roots = commit["roots"].as_array().unwrap().iter().map(node);
                        assert_eq!(after(&target), Ok(Some(roots.collect())), "{name} commit");
                        commits += 1;
                    }
                }
                // A source-facet stroke commits ranges, not a tree.
                None if expected.refinement.is_none()
                    && expected.gap_fill_replacements.is_none() =>
                {
                    assert_eq!(after(&RegionState::Unpainted), Ok(None), "{name}");
                }
                None => {}
            }
            selections += 1;
        }
    }
    assert!(commits_by_case.is_empty());
    assert_eq!(
        (selections, refusals, stale, materialized, commits),
        (5889, 44, 2, 3, 190)
    );
}

fn update(v: &Value) -> StateUpdate {
    StateUpdate {
        source_triangle: number(&v["sourceTriangle"]),
        path: v["path"].as_array().unwrap().iter().map(number).collect(),
        target: state(&v["target"]),
    }
}
fn issues(v: &Value) -> Vec<(String, String, String)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["code"].as_str().unwrap().to_owned(),
                i["path"].as_str().unwrap().to_owned(),
                i["message"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}
fn actual_issues(error: RegionError) -> Vec<(String, String, String)> {
    let RegionError::Invalid(issues) = error else {
        panic!("expected issues, got {error:?}");
    };
    issues
        .into_iter()
        .map(|i| (i.code.to_owned(), i.path, i.message))
        .collect()
}

/// One-side splits nested `levels` deep, each holding an unpainted leaf and
/// the next, as the generator's `chain`.
fn split_chain(levels: u64) -> EncodedNode {
    (0..levels).fold(EncodedNode::Leaf(RegionState::Unpainted), |inner, _| {
        EncodedNode::Split {
            split_sides: 1,
            special_side: 0,
            children: vec![EncodedNode::Leaf(RegionState::Unpainted), inner],
        }
    })
}

/// The commit helpers refuse a malformed selection or update list with the
/// browser's issues.
#[test]
fn refined_commit_refusals_match_the_browser() {
    let f = fixture();
    let mut count = 0;
    for case in f["commitRefusals"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let updates: Vec<StateUpdate> = case["updates"]
            .as_array()
            .unwrap()
            .iter()
            .map(update)
            .collect();
        let mut selection = refined(&case["selection"]);
        if let Some(chain) = case.get("chain") {
            selection.roots[chain["root"].as_u64().unwrap() as usize] =
                split_chain(chain["levels"].as_u64().unwrap());
        }
        let actual = region::apply_refined_updates(
            channel(case["channel"].as_str().unwrap()),
            &selection,
            &updates,
        );
        assert_eq!(
            actual.map_err(actual_issues),
            Err(issues(&case["issues"])),
            "{name}"
        );
        count += 1;
    }
    assert_eq!(count, 11);
}
