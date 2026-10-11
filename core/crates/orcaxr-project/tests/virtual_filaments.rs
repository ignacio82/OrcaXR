//! The virtual filament library against the browser
//! (`virtual-filament-vectors.json`): the libraries projects show, the
//! dialogs they open, every validation of the author dialog's fields, the
//! triangle picker, the pinned Match search, every library edit's step and the
//! malformed requests refused, answered byte for byte; beneath them the Cycle
//! grammar, the authoring projection and ranking, ΔE2000 in both precisions,
//! the sequential pigment blend, the palette search with its statistics and
//! the canonical recipe; and the journey's libraries, dialogs, drafts and
//! steps over the states its edits lead to.
use orcaxr_contracts::canonical::{Value as Canon, parse};
use orcaxr_project::filaments::authoring::{self, Authored, Input, Projection};
use orcaxr_project::filaments::library::exchange::{
    INVALID_REQUEST, defaults_json, form_json, library_json, match_search_json, mutation_json,
    triangle_json,
};
use orcaxr_project::filaments::match_search::{self, Entry, Searched};
use orcaxr_project::filaments::{cycle_pattern, pigment, recipe};
use orcaxr_project::model::{Decode, ProjectState};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/virtual-filament-vectors.json"
    ))
    .unwrap()
}
fn state_of(json: &str) -> ProjectState {
    ProjectState::from_value(parse(json).unwrap()).unwrap()
}
fn state(corpus: &Value, name: &str) -> ProjectState {
    state_of(corpus["states"][name].as_str().unwrap())
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn str_units(value: &Value) -> Vec<u16> {
    units(value.as_str().unwrap())
}
fn errors(replies: &[String]) -> usize {
    replies
        .iter()
        .filter(|reply| reply.starts_with("{\"error\""))
        .count()
}

#[test]
fn reference_sources_are_current() {
    for source in corpus()["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap(),
            "{}",
            source["path"]
        );
    }
}

#[test]
fn libraries_match_the_browser() {
    let corpus = corpus();
    let mut replies = Vec::new();
    for case in corpus["libraries"].as_array().unwrap() {
        let state = state(&corpus, case["state"].as_str().unwrap());
        let reply = library_json(&state, case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            reply,
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["state"]
        );
        replies.push(reply);
    }
    assert_eq!((replies.len(), errors(&replies)), (6, 1));
}

#[test]
fn dialogs_open_as_the_browser_opens_them() {
    let corpus = corpus();
    let cases = corpus["defaults"].as_array().unwrap();
    for (i, case) in cases.iter().enumerate() {
        let reply = defaults_json(case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "dialog {i}");
    }
    assert_eq!(cases.len(), 27);
}

#[test]
fn validations_match_the_browser() {
    let corpus = corpus();
    let cases = corpus["validations"].as_array().unwrap();
    let mut complete = 0;
    for (i, case) in cases.iter().enumerate() {
        let reply = form_json(case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "validation {i}");
        complete += usize::from(reply.contains("\"draft\":"));
    }
    assert_eq!((cases.len(), complete), (197, 96));
}

#[test]
fn the_triangle_picker_writes_the_browser_proportions() {
    let corpus = corpus();
    let cases = corpus["triangles"].as_array().unwrap();
    for case in cases {
        let reply = triangle_json(case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            reply,
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["requestJson"]
        );
    }
    assert_eq!(cases.len(), 12);
}

#[test]
fn match_searches_propose_the_browser_candidates() {
    let corpus = corpus();
    let cases = corpus["matchSearches"].as_array().unwrap();
    for (i, case) in cases.iter().enumerate() {
        let reply = match_search_json(case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "search {i}");
    }
    assert_eq!(cases.len(), 12);
}

#[test]
fn edits_plan_the_browser_steps() {
    let corpus = corpus();
    let cases = corpus["mutations"].as_array().unwrap();
    let mut replies = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let state = state(&corpus, case["state"].as_str().unwrap());
        let reply = mutation_json(&state, case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "edit {i}");
        replies.push(reply);
    }
    assert_eq!((replies.len(), errors(&replies)), (51, 12));
}

#[test]
fn malformed_requests_are_refused() {
    let corpus = corpus();
    let rich = state(&corpus, "rich");
    let refusals = corpus["refusals"].as_array().unwrap();
    for case in refusals {
        let request = case["requestJson"].as_str().unwrap();
        let result = match case["exchange"].as_str().unwrap() {
            "library" => library_json(&rich, request),
            "defaults" => defaults_json(request),
            "form" => form_json(request),
            "triangle" => triangle_json(request),
            "search" => match_search_json(request),
            _ => mutation_json(&rich, request),
        };
        assert_eq!(result, Err(INVALID_REQUEST), "{request}");
    }
    assert_eq!(refusals.len(), 20);
}

// --- Beneath the exchanges: the browser's results, written as it writes them ---------------------

fn c(fields: Vec<(&str, Canon)>) -> Canon {
    Canon::Object(
        fields
            .into_iter()
            .map(|(name, value)| (units(name), value))
            .collect::<BTreeMap<_, _>>(),
    )
}
fn s(text: &[u16]) -> Canon {
    Canon::String(text.to_vec())
}
fn n(value: f64) -> Canon {
    Canon::Number(value)
}
fn canonical(value: &Canon) -> String {
    let mut bytes = Vec::new();
    value.write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn projection(p: &Projection) -> Canon {
    c(vec![
        ("component_a", n(p.component_a)),
        ("component_b", n(p.component_b)),
        ("custom", Canon::Bool(true)),
        ("distribution_mode", n(f64::from(p.distribution_mode))),
        ("gradient_component_ids", s(&p.gradient_component_ids)),
        (
            "gradient_component_weights",
            s(&p.gradient_component_weights),
        ),
        ("gradient_enabled", Canon::Bool(p.gradient_enabled)),
        ("gradient_end", n(p.gradient_end)),
        ("gradient_start", n(p.gradient_start)),
        ("local_z_max_sublayers", n(p.local_z_max_sublayers)),
        ("manual_pattern", s(&p.manual_pattern)),
        ("mix_b_percent", n(p.mix_b_percent)),
        ("ratio_a", n(p.ratio_a)),
        ("ratio_b", n(p.ratio_b)),
        ("ui_mode", n(f64::from(p.ui_mode))),
    ])
}
fn authoring_issue(issue: &authoring::Issue) -> Canon {
    let mut location = vec![("path", s(&issue.location.path))];
    if let Some(index) = issue.location.component_index {
        location.push(("componentIndex", n(index as f64)));
    }
    if let Some(start) = issue.location.start_offset {
        location.push(("startOffset", n(start as f64)));
    }
    if let Some(end) = issue.location.end_offset {
        location.push(("endOffset", n(end as f64)));
    }
    c(vec![
        ("code", s(&units(issue.code))),
        ("location", c(location)),
        ("message", s(&issue.message)),
    ])
}
fn authored(result: &Authored) -> Canon {
    let mut fields = vec![
        (
            "issues",
            Canon::Array(result.issues.iter().map(authoring_issue).collect()),
        ),
        ("mode", s(&units(result.mode))),
        ("ok", Canon::Bool(result.ok)),
        (
            "projection",
            result.projection.as_ref().map_or(Canon::Null, projection),
        ),
    ];
    if let Some(target) = &result.normalized_target_color {
        fields.push(("normalizedTargetColor", s(target)));
    }
    c(fields)
}
fn numbers(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}
fn match_components(value: &Value) -> Vec<(f64, f64)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["toolId"].as_f64().unwrap(), c["weight"].as_f64().unwrap()))
        .collect()
}

#[test]
fn cycle_patterns_parse_as_the_browser_parses_them() {
    let corpus = corpus();
    let cases = corpus["cycles"].as_array().unwrap();
    for case in cases {
        let request: Value = serde_json::from_str(case["requestJson"].as_str().unwrap()).unwrap();
        let available: Option<Vec<u32>> = request["availableToolIds"]
            .as_array()
            .map(|list| list.iter().map(|v| v.as_u64().unwrap() as u32).collect());
        let parsed = cycle_pattern::parse(&str_units(&request["pattern"]), available.as_deref());
        let location = |l: &cycle_pattern::Location| {
            let mut fields = vec![
                ("endOffset", n(l.end_offset as f64)),
                ("groupIndex", n(l.group_index as f64)),
                ("path", s(&units(&l.path()))),
                ("startOffset", n(l.start_offset as f64)),
            ];
            if let Some(token) = l.token_index {
                fields.push(("tokenIndex", n(token as f64)));
            }
            c(fields)
        };
        let reply = c(vec![
            (
                "groups",
                Canon::Array(
                    parsed
                        .groups
                        .iter()
                        .map(|g| {
                            c(vec![
                                ("endOffset", n(g.end_offset as f64)),
                                ("index", n(g.index as f64)),
                                ("raw", s(&g.raw)),
                                ("startOffset", n(g.start_offset as f64)),
                                (
                                    "tokens",
                                    Canon::Array(
                                        g.tokens
                                            .iter()
                                            .map(|t| {
                                                c(vec![
                                                    ("canonical", s(&t.canonical)),
                                                    ("location", location(&t.location)),
                                                    ("raw", s(&t.raw)),
                                                    ("toolId", n(f64::from(t.tool_id))),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("input", s(&parsed.input)),
            (
                "issues",
                Canon::Array(
                    parsed
                        .issues
                        .iter()
                        .map(|i| {
                            let mut fields = vec![
                                ("code", s(&units(i.code))),
                                ("location", location(&i.location)),
                                ("message", s(&i.message)),
                            ];
                            if let Some(raw) = &i.raw {
                                fields.push(("raw", s(raw)));
                            }
                            if let Some(tool) = i.tool_id {
                                fields.push(("toolId", n(tool)));
                            }
                            c(fields)
                        })
                        .collect(),
                ),
            ),
            ("normalized", s(&parsed.normalized)),
            ("ok", Canon::Bool(parsed.ok)),
            (
                "sequence",
                Canon::Array(parsed.sequence.iter().map(|t| n(f64::from(*t))).collect()),
            ),
            ("syntaxValid", Canon::Bool(parsed.syntax_valid)),
        ]);
        assert_eq!(
            canonical(&reply),
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["requestJson"]
        );
    }
    assert_eq!(cases.len(), 78);
}

fn authoring_input(input: &Value) -> Input {
    match input["mode"].as_str().unwrap() {
        "ratio" => Input::Ratio {
            component_ids: numbers(&input["componentIds"]),
            mix_b_percent: input["mixBPercent"].as_f64().unwrap(),
            triangle: input.get("triangleWeightsPercent").map(numbers),
        },
        "gradient" => Input::Gradient {
            component_ids: numbers(&input["componentIds"]),
            direction: str_units(&input["direction"]),
            local_z_max_sublayers: input["localZMaxSublayers"].as_f64().unwrap(),
        },
        _ => Input::Match {
            components: match_components(&input["components"]),
            target_color: str_units(&input["targetColor"]),
            min_component_percent: input["minComponentPercent"].as_f64().unwrap(),
        },
    }
}

#[test]
fn authoring_projects_as_the_browser_projects() {
    let corpus = corpus();
    let cases = corpus["authoring"].as_array().unwrap();
    for case in cases {
        let request: Value = serde_json::from_str(case["requestJson"].as_str().unwrap()).unwrap();
        let result = authoring::project(
            &authoring_input(&request["input"]),
            request["physicalToolCount"].as_f64().unwrap(),
        );
        assert_eq!(
            canonical(&authored(&result)),
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["requestJson"]
        );
    }
    assert_eq!(cases.len(), 57);
}

#[test]
fn supplied_candidates_rank_as_the_browser_ranks_them() {
    let corpus = corpus();
    let cases = corpus["rankings"].as_array().unwrap();
    for case in cases {
        let request: Value = serde_json::from_str(case["requestJson"].as_str().unwrap()).unwrap();
        let candidates: Vec<authoring::Candidate> = request["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| authoring::Candidate {
                components: match_components(&candidate["components"]),
                preview_color: str_units(&candidate["previewColor"]),
            })
            .collect();
        let ranking = authoring::rank(
            request["physicalToolCount"].as_f64().unwrap(),
            &str_units(&request["targetColor"]),
            request["minComponentPercent"].as_f64().unwrap(),
            &candidates,
        );
        let reply = c(vec![
            (
                "candidates",
                Canon::Array(
                    ranking
                        .candidates
                        .iter()
                        .map(|r| {
                            c(vec![
                                ("deltaE2000", n(r.delta_e2000)),
                                ("previewColor", s(&r.preview_color)),
                                ("projection", projection(&r.projection)),
                                ("sourceIndex", n(r.source_index as f64)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("coverage", s(&units("supplied-candidates-only"))),
            (
                "issues",
                Canon::Array(ranking.issues.iter().map(authoring_issue).collect()),
            ),
            (
                "normalizedTargetColor",
                ranking
                    .normalized_target_color
                    .as_deref()
                    .map_or(Canon::Null, s),
            ),
            ("ok", Canon::Bool(ranking.ok)),
        ]);
        assert_eq!(
            canonical(&reply),
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["requestJson"]
        );
    }
    assert_eq!(cases.len(), 46);
}

#[test]
fn delta_e2000_matches_the_browser_in_both_precisions() {
    let corpus = corpus();
    let rows = corpus["deltas"].as_array().unwrap();
    for row in rows {
        let (first, second) = (str_units(&row[0]), str_units(&row[1]));
        let binary64 = authoring::color_delta_e2000(&first, &second).unwrap();
        let pinned = match_search::pinned_color_delta_e(&first, &second).unwrap();
        assert_eq!(
            binary64.to_bits(),
            row[2].as_f64().unwrap().to_bits(),
            "{row}"
        );
        assert_eq!(
            pinned.to_bits(),
            row[3].as_f64().unwrap().to_bits(),
            "{row}"
        );
    }
    assert_eq!(rows.len(), 3000);
}

#[test]
fn colours_blend_in_order_as_the_browser_blends_them() {
    let corpus = corpus();
    let rows = corpus["blends"].as_array().unwrap();
    for row in rows {
        let parts: Vec<(Vec<u16>, f64)> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| (str_units(&part[0]), part[1].as_f64().unwrap()))
            .collect();
        let borrowed: Vec<(&[u16], f64)> = parts
            .iter()
            .map(|(color, weight)| (color.as_slice(), *weight))
            .collect();
        assert_eq!(
            pigment::blend_multi(&borrowed),
            row[1].as_str().unwrap(),
            "{row}"
        );
    }
    assert_eq!(rows.len(), 401);
}

fn searched(result: &Searched) -> Canon {
    let recipe = |r: &match_search::Recipe| {
        c(vec![
            (
                "components",
                Canon::Array(
                    r.components
                        .iter()
                        .map(|(tool, weight)| c(vec![("toolId", n(*tool)), ("weight", n(*weight))]))
                        .collect(),
                ),
            ),
            ("deltaE2000", r.delta_e2000.map_or(Canon::Null, n)),
            ("kind", s(&units(r.kind))),
            ("previewColor", s(&r.preview_color)),
            ("projection", projection(&r.projection)),
        ])
    };
    c(vec![
        (
            "bestPair",
            result.best_pair.as_ref().map_or(Canon::Null, recipe),
        ),
        (
            "coverage",
            s(&units(
                "pinned-bundled-compatibility-with-explicit-filament-types",
            )),
        ),
        (
            "issues",
            Canon::Array(
                result
                    .issues
                    .iter()
                    .map(|i| {
                        c(vec![
                            ("code", s(&units(i.code))),
                            ("message", s(&units(i.message))),
                            ("path", s(&units(&i.path))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "normalizedTargetColor",
            result
                .normalized_target_color
                .as_deref()
                .map_or(Canon::Null, s),
        ),
        ("ok", Canon::Bool(result.ok)),
        ("recipe", result.recipe.as_ref().map_or(Canon::Null, recipe)),
        (
            "stats",
            c(vec![
                (
                    "candidatePoolToolIds",
                    Canon::Array(
                        result
                            .stats
                            .candidate_pool
                            .iter()
                            .map(|t| n(*t as f64))
                            .collect(),
                    ),
                ),
                ("earlyPairExit", Canon::Bool(result.stats.early_pair_exit)),
                (
                    "pairCoarseEvaluations",
                    n(f64::from(result.stats.pair_coarse)),
                ),
                ("pairFineEvaluations", n(f64::from(result.stats.pair_fine))),
                (
                    "tripleCoarseEvaluations",
                    n(f64::from(result.stats.triple_coarse)),
                ),
                (
                    "tripleFineEvaluations",
                    n(f64::from(result.stats.triple_fine)),
                ),
            ]),
        ),
    ])
}

#[test]
fn palettes_search_as_the_browser_searches_them() {
    let corpus = corpus();
    let cases = corpus["paletteSearches"].as_array().unwrap();
    for case in cases {
        let request: Value = serde_json::from_str(case["requestJson"].as_str().unwrap()).unwrap();
        let palette: Vec<Entry> = request["palette"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| Entry {
                color: str_units(&entry["color"]),
                filament_type: str_units(&entry["filamentType"]),
            })
            .collect();
        let result = match_search::search(
            &palette,
            &str_units(&request["targetColor"]),
            request["minComponentPercent"].as_f64().unwrap(),
        );
        assert_eq!(
            canonical(&searched(&result)),
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["requestJson"]
        );
    }
    assert_eq!(cases.len(), 16);
}

fn recipe_draft(draft: &Value) -> recipe::Draft {
    let ids = |value: &Value| {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(str_units)
            .collect::<Vec<_>>()
    };
    let mode = match draft["mode"].as_str().unwrap() {
        "ratio" => recipe::DraftMode::Ratio {
            components: ids(&draft["componentFilamentIds"]),
            mix_b_percent: draft["mixBPercent"].as_f64().unwrap(),
            triangle: draft.get("triangleWeightsPercent").map(numbers),
        },
        "cycle" => recipe::DraftMode::Cycle {
            groups: draft["manualPatternGroups"]
                .as_array()
                .unwrap()
                .iter()
                .map(ids)
                .collect(),
        },
        "match" => recipe::DraftMode::Match {
            components: draft["components"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| (str_units(&c["filamentId"]), c["weight"].as_f64().unwrap()))
                .collect(),
            target_color: str_units(&draft["targetColor"]),
            min_component_percent: draft["minComponentPercent"].as_f64().unwrap(),
        },
        _ => {
            let pair = ids(&draft["componentFilamentIds"]);
            recipe::DraftMode::Gradient {
                components: [pair[0].clone(), pair[1].clone()],
                a_to_b: draft["direction"] == "a-to-b",
                local_z_max_sublayers: draft["localZMaxSublayers"].as_f64().unwrap(),
            }
        }
    };
    recipe::Draft {
        name: str_units(&draft["name"]),
        display_color: str_units(&draft["displayColor"]),
        enabled: draft.get("enabled").map(|v| v.as_bool().unwrap()),
        offset_a: draft
            .get("componentASurfaceOffsetMm")
            .map(|v| v.as_f64().unwrap()),
        offset_b: draft
            .get("componentBSurfaceOffsetMm")
            .map(|v| v.as_f64().unwrap()),
        mode,
    }
}

#[test]
fn recipes_are_built_as_the_browser_builds_them() {
    let corpus = corpus();
    let rich = state(&corpus, "rich");
    let cases = corpus["recipes"].as_array().unwrap();
    let mut refused = 0;
    for case in cases {
        let request: Value = serde_json::from_str(case["requestJson"].as_str().unwrap()).unwrap();
        let upstream = request["upstreamStableId"].as_str().map(units);
        let built = recipe::create(
            &units("6f0c2c4e-1b7a-4d8e-9f00-0a1b2c3d4e5f"),
            &rich.filaments.physical,
            &recipe_draft(&request["draft"]),
            upstream.as_deref(),
        );
        let reply = match built {
            Ok(recipe) => canonical(&recipe.to_value()),
            Err(message) => {
                refused += 1;
                canonical(&c(vec![("error", s(&message))]))
            }
        };
        assert_eq!(
            reply,
            case["replyJson"].as_str().unwrap(),
            "{}",
            case["requestJson"]
        );
    }
    assert_eq!((cases.len(), refused), (19, 9));
}

#[test]
fn the_journey_runs_on_the_states_it_leads_to() {
    let corpus = corpus();
    let steps = corpus["journey"]["steps"].as_array().unwrap();
    for (index, step) in steps.iter().enumerate() {
        let state = state_of(step["stateJson"].as_str().unwrap());
        let library = library_json(&state, "{}").unwrap();
        assert_eq!(
            library,
            step["libraryJson"].as_str().unwrap(),
            "step {index} library"
        );
        let reply = mutation_json(&state, step["mutationRequestJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            reply,
            step["mutationReplyJson"].as_str().unwrap(),
            "step {index} edit"
        );
        let Some(form) = step.get("formJson").and_then(Value::as_str) else {
            continue;
        };
        let request = format!(
            "{{\"form\":{form},\"library\":{library},\"search\":{}}}",
            step["searchJson"].as_str().unwrap()
        );
        let validation: Value = serde_json::from_str(&form_json(&request).unwrap()).unwrap();
        let draft: Value = serde_json::from_str(step["draftJson"].as_str().unwrap()).unwrap();
        assert_eq!(validation["draft"], draft, "step {index} draft");
    }
    assert_eq!(steps.len(), 14);
}
