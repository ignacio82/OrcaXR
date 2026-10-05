use super::{
    Issue, Severity,
    graph::{Validator, safe_integer},
};
use crate::model::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(super) fn shape(f: &MixedFilament, path: &str, v: &mut Validator<'_>) {
    if f.components.len() < 2 {
        v.add(
            "mixed-component-count",
            format!("{path}.components"),
            "Mixed filament needs at least two components",
        );
    }
    for (i, component) in f.components.iter().enumerate() {
        if component.weight.get() < 0.0 {
            v.add(
                "invalid-mixed-weight",
                format!("{path}.components[{i}].weight"),
                "Weight must be non-negative",
            );
        }
    }
    if !f.components.is_empty() && f.components.iter().all(|c| c.weight.get() == 0.0) {
        v.add(
            "invalid-mixed-weight-total",
            format!("{path}.components"),
            "At least one mixed-filament weight must be positive",
        );
    }
    match &f.distribution {
        MixedDistribution::Cycle(d) => {
            if d.cycle_length_mm.is_some_and(|n| n.get() <= 0.0) {
                v.add(
                    "invalid-cycle-length",
                    format!("{path}.distribution.cycleLengthMm"),
                    "Cycle length must be greater than zero",
                );
            }
        }
        MixedDistribution::Gradient(d) => {
            let invalid = match (d.start_z_mm, d.end_z_mm) {
                (None, None) => false,
                (Some(a), Some(b)) => a.get() < 0.0 || b.get() <= a.get(),
                _ => true,
            };
            if invalid {
                v.add(
                    "invalid-gradient-range",
                    format!("{path}.distribution"),
                    "Gradient range must increase above zero",
                );
            }
            if d.start_weights.len() != f.components.len()
                || d.end_weights.len() != f.components.len()
            {
                v.add(
                    "invalid-gradient-weights",
                    format!("{path}.distribution"),
                    "Gradient weights must match component count",
                );
            }
            if d.start_weights
                .iter()
                .chain(d.end_weights.iter())
                .any(|n| n.get() < 0.0)
            {
                v.add(
                    "invalid-gradient-weights",
                    format!("{path}.distribution"),
                    "Gradient weights must be finite and non-negative",
                );
            }
        }
        _ => {}
    }
    let Some(r) = &f.full_spectrum else {
        return;
    };
    let p = format!("{path}.fullSpectrum");
    let stable = r.upstream_stable_id.units();
    let decimal = stable == [48]
        || stable.first().is_some_and(|n| (49..=57).contains(n))
            && stable.iter().all(|n| (48..=57).contains(n));
    if !decimal {
        v.add(
            "invalid-fullspectrum-stable-id",
            format!("{p}.upstreamStableId"),
            "Expected unsigned decimal text",
        );
    } else if stable.len() > 20
        || stable.len() == 20
            && stable
                .iter()
                .copied()
                .cmp("18446744073709551615".encode_utf16())
                .is_gt()
    {
        v.add(
            "invalid-fullspectrum-stable-id",
            format!("{p}.upstreamStableId"),
            "Stable ID exceeds uint64",
        );
    }
    let physical = f
        .components
        .iter()
        .map(|c| c.filament_id.as_utf16())
        .collect::<BTreeSet<_>>();
    let check = |id: &[u16], path: String, v: &mut Validator<'_>| {
        if !physical.contains(id) {
            v.add(
                "missing-fullspectrum-component",
                path,
                "Engine field must reference a canonical recipe component",
            );
        }
    };
    check(r.component_a_id.as_utf16(), format!("{p}.componentAId"), v);
    check(r.component_b_id.as_utf16(), format!("{p}.componentBId"), v);
    if r.component_a_id == r.component_b_id {
        v.add(
            "duplicate-fullspectrum-pair",
            &p,
            "Component A and B must be different physical filaments",
        );
    }
    for (i, group) in r.manual_pattern_groups.iter().enumerate() {
        if group.is_empty() {
            v.add(
                "empty-fullspectrum-pattern-group",
                format!("{p}.manualPatternGroups[{i}]"),
                "Pattern groups cannot be empty",
            );
        }
        for (j, id) in group.iter().enumerate() {
            check(
                id.as_utf16(),
                format!("{p}.manualPatternGroups[{i}][{j}]"),
                v,
            );
        }
    }
    for (i, id) in r.gradient_component_ids.iter().enumerate() {
        check(id.as_utf16(), format!("{p}.gradientComponentIds[{i}]"), v);
    }
    let weights = &r.gradient_component_weights;
    if !weights.is_empty() && weights.len() != r.gradient_component_ids.len() {
        v.add(
            "invalid-fullspectrum-gradient-weights",
            format!("{p}.gradientComponentWeights"),
            "Gradient component weights must align with component IDs",
        );
    }
    if weights.iter().any(|w| !safe_integer(w.get()))
        || !weights.is_empty() && weights.iter().all(|w| w.get() == 0.0)
    {
        v.add(
            "invalid-fullspectrum-gradient-weights",
            format!("{p}.gradientComponentWeights"),
            "Gradient component weights must be non-negative integers with a positive total",
        );
    }
    for (field, n) in [
        ("ratioA", r.ratio_a),
        ("ratioB", r.ratio_b),
        ("mixBPercent", r.mix_b_percent),
        ("localZMaxSublayers", r.local_z_max_sublayers),
    ] {
        if !safe_integer(n.get()) {
            v.add(
                "invalid-fullspectrum-integer",
                format!("{p}.{field}"),
                "Expected a non-negative safe integer",
            );
        }
    }
    if r.mix_b_percent.get() > 100.0 {
        v.add(
            "invalid-fullspectrum-percent",
            format!("{p}.mixBPercent"),
            "Mix percentage cannot exceed 100",
        );
    }
    for (field, n) in [
        ("gradientStart", r.gradient_start),
        ("gradientEnd", r.gradient_end),
    ] {
        if n.get() <= 0.0 || n.get() >= 1.0 {
            v.add(
                "invalid-fullspectrum-gradient",
                format!("{p}.{field}"),
                "Gradient endpoints must be inside (0, 1)",
            );
        }
    }
    if r.gradient_enabled && (r.gradient_start.get() - r.gradient_end.get()).abs() < 0.05 {
        v.add(
            "invalid-fullspectrum-gradient",
            &p,
            "Enabled gradient endpoints must differ by at least 0.05",
        );
    }
    for (field, n) in [
        ("componentASurfaceOffsetMm", r.component_a_surface_offset_mm),
        ("componentBSurfaceOffsetMm", r.component_b_surface_offset_mm),
    ] {
        if n.get().abs() > 2.0 {
            v.add(
                "invalid-fullspectrum-offset",
                format!("{p}.{field}"),
                "Offset must be within the pinned -2 mm to 2 mm range",
            );
        }
    }
}

pub(super) fn references(
    mixed: &[Arc<MixedFilament>],
    physical: &BTreeSet<&[u16]>,
    mixed_ids: &BTreeSet<&[u16]>,
    v: &mut Validator<'_>,
) {
    let by_id = mixed
        .iter()
        .map(|f| (f.id.as_utf16(), f.as_ref()))
        .collect::<BTreeMap<_, _>>();
    for (i, entry) in mixed.iter().enumerate() {
        for (j, component) in entry.components.iter().enumerate() {
            let id = component.filament_id.as_utf16();
            let path = format!("filaments.mixed[{i}].components[{j}].filamentId");
            if !physical.contains(id) && !mixed_ids.contains(id) {
                v.add(
                    "dangling-mixed-component",
                    path,
                    "Unknown mixed-filament component",
                );
            } else if mixed_ids.contains(id) {
                v.add(
                    "nested-mixed-component",
                    path,
                    "Snapmaker v2.3.4 mixed-filament components must reference physical filaments",
                );
            }
        }
    }
    let mut visited = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    // Iterative DFS retains the reference's input order and complete cycle path
    // without recursion or copying the whole path at every valid edge.
    let mut stack: Vec<(&[u16], usize)> = Vec::new();
    for root in mixed {
        let root = root.id.as_utf16();
        if visited.contains(root) {
            continue;
        }
        visiting.insert(root);
        stack.push((root, 0));
        while let Some((id, next)) = stack.last_mut() {
            if let Some(component) = by_id.get(id).and_then(|f| f.components.get(*next)) {
                *next += 1;
                let child = component.filament_id.as_utf16();
                if !mixed_ids.contains(child) {
                    continue;
                }
                if visiting.contains(child) {
                    let mut message = "Mixed filament cycle: ".encode_utf16().collect::<Vec<_>>();
                    for (id, _) in &stack {
                        message.extend_from_slice(id);
                        message.extend(" -> ".encode_utf16());
                    }
                    message.extend_from_slice(child);
                    v.issues.push(Issue {
                        code: "cyclic-mixed-filament",
                        path: Text::from_utf8("filaments.mixed"),
                        message: Text::new(message),
                        severity: Severity::Error,
                    });
                } else if !visited.contains(child) {
                    visiting.insert(child);
                    stack.push((child, 0));
                }
            } else {
                let (id, _) = stack.pop().unwrap();
                visiting.remove(id);
                visited.insert(id);
            }
        }
    }
}
