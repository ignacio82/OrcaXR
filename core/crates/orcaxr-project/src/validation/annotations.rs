use super::{
    Issue, Severity,
    graph::{Validator, fields, integer, js_number, number_key},
};
use crate::{
    facets::{self, Channel},
    model::{FacetAnnotations, Text},
};
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeSet;

fn channels(a: &FacetAnnotations) -> [(Channel, &Value); 5] {
    [
        (Channel::Color, a.color.value()),
        (Channel::Support, a.support.value()),
        (Channel::Seam, a.seam.value()),
        (Channel::FuzzySkin, a.fuzzy_skin.value()),
        (Channel::Brim, a.brim.value()),
    ]
}
/// `facetAnnotationsHaveAssignments`: any channel holds an assignment, or the
/// dense refinement holds a root.
pub(crate) fn has_assignments(a: &FacetAnnotations) -> bool {
    channels(a)
        .iter()
        .any(|(_, value)| matches!(value, Value::Array(a) if !a.is_empty()))
        || a.refinement.as_ref().is_some_and(|r| !fields(r).is_empty())
}
pub(super) fn validate(
    a: &FacetAnnotations,
    topology: f64,
    count: f64,
    path: &str,
    filament_ids: &BTreeSet<Vec<u16>>,
    v: &mut Validator<'_>,
) {
    if a.topology_revision.get() != topology {
        v.add(
            "stale-annotation-topology",
            format!("{path}.annotations.topologyRevision"),
            "Facet annotations target a different topology revision",
        );
    }
    let values = channels(a);
    let value_key = "value".encode_utf16().collect::<Vec<_>>();
    let triangles_key = "triangles".encode_utf16().collect::<Vec<_>>();
    for (channel, payload) in values {
        let Value::Array(assignments) = payload else {
            unreachable!("typed assignments")
        };
        let mut seen = BTreeSet::new();
        for (i, assignment) in assignments.iter().enumerate() {
            let Value::Object(fields) = assignment else {
                unreachable!("typed assignment")
            };
            if channel == Channel::Color {
                let Value::String(value) = &fields[&value_key] else {
                    unreachable!("typed color")
                };
                if !filament_ids.contains(value) {
                    v.add(
                        "dangling-filament",
                        format!("{path}.annotations.color[{i}].value"),
                        "Unknown paint filament",
                    );
                }
            }
            let Value::Array(triangles) = &fields[&triangles_key] else {
                unreachable!("typed triangle list")
            };
            for (j, triangle) in triangles.iter().enumerate() {
                let Value::Number(triangle) = triangle else {
                    unreachable!("typed finite number")
                };
                let invalid = !integer(*triangle) || *triangle < 0.0 || *triangle >= count;
                let duplicate = !seen.insert(number_key(*triangle));
                // Valid indices require no diagnostic path/string allocation.
                if invalid || duplicate {
                    let p = format!("{path}.annotations.{}[{i}].triangles[{j}]", channel.name());
                    if invalid {
                        v.add(
                            "facet-index-out-of-range",
                            &p,
                            format!("Triangle must be in [0, {}]", js_number(count - 1.0)),
                        );
                    }
                    if duplicate {
                        v.add(
                            "duplicate-facet-assignment",
                            &p,
                            format!("Triangle {} is assigned twice", js_number(*triangle)),
                        );
                    }
                }
            }
        }
    }
    let Some(refinement) = &a.refinement else {
        return;
    };
    let refinement = fields(refinement);
    let p = format!("{path}.annotations.refinement");
    if refinement.is_empty() {
        v.add(
            "empty-facet-refinements",
            &p,
            "Empty facet refinements must be omitted",
        );
    }
    for name in refinement.keys() {
        if !Channel::ALL
            .iter()
            .any(|c| name.iter().copied().eq(c.name().encode_utf16()))
        {
            let mut key_path = format!("{p}.").encode_utf16().collect::<Vec<_>>();
            key_path.extend_from_slice(name);
            let mut message = "Unknown facet refinement channel "
                .encode_utf16()
                .collect::<Vec<_>>();
            message.extend_from_slice(name);
            v.issues.push(Issue {
                code: "unknown-facet-refinement-channel",
                path: Text::new(key_path),
                message: Text::new(message),
                severity: Severity::Error,
            });
        }
    }
    for (channel, assignments) in values {
        let Some(candidate) = refinement.get(&channel.name().encode_utf16().collect::<Vec<_>>())
        else {
            continue;
        };
        let channel_path = format!("{p}.{}", channel.name());
        let mut options = facets::ValidationOptions::new(count, &channel_path);
        options.filament_ids = Some(filament_ids);
        for issue in facets::validate_refinement(channel, candidate, assignments, &options) {
            v.add(issue.code, issue.path, issue.message);
        }
    }
}
