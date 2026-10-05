use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}
impl Issue {
    pub(super) fn new(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}
#[derive(Debug, Clone, Copy)]
pub struct ValidationOptions<'a> {
    pub triangle_count: f64,
    pub filament_ids: Option<&'a BTreeSet<Vec<u16>>>,
    pub path: &'a str,
    pub require_split: bool,
}
impl<'a> ValidationOptions<'a> {
    pub fn new(triangle_count: f64, path: &'a str) -> Self {
        Self {
            triangle_count,
            filament_ids: None,
            path,
            require_split: true,
        }
    }
}

/// Matches the TypeScript persisted-refinement validator's issue order and
/// diagnostics on canonical JSON values. Owned Value trees cannot contain
/// cycles or shared JavaScript object identities. No dense roots are allocated.
pub fn validate_refinement(
    channel: Channel,
    candidate: &Value,
    assignments: &Value,
    options: &ValidationOptions<'_>,
) -> Vec<Issue> {
    let path = options.path;
    let mut issues = Vec::new();
    macro_rules! add {
        ($code:expr, $path:expr, $message:expr) => {
            issues.push(Issue::new($code, $path, $message))
        };
    }
    if !matches!(candidate, Value::Object(_)) {
        add!(
            "invalid-facet-refinement",
            path,
            "Facet refinement must be an encoding object"
        );
        return issues;
    }
    if !exact(candidate, &["version", "triangleCount", "splits"]) {
        add!(
            "invalid-facet-refinement-fields",
            path,
            "Facet refinement encodings may contain only version, triangleCount, and splits"
        );
    }
    if number(field(candidate, "version")) != Some(f64::from(ENCODING_VERSION)) {
        add!(
            "invalid-facet-refinement-version",
            format!("{path}.version"),
            "Facet refinement version must be 2"
        );
    }
    if number(field(candidate, "triangleCount")) != Some(options.triangle_count) {
        add!(
            "invalid-facet-refinement-triangle-count",
            format!("{path}.triangleCount"),
            "Facet refinement must declare the source mesh triangle count"
        );
    }
    let Some(splits) = array(field(candidate, "splits")) else {
        add!(
            "invalid-facet-refinement-splits",
            format!("{path}.splits"),
            "Facet refinement splits must be an array"
        );
        return issues;
    };
    let budget = node_budget(options.triangle_count);
    // Index only subdivided facets, not the usually much larger assignment set.
    let split_triangles: BTreeSet<_> = splits
        .iter()
        .filter_map(|v| number(field(v, "triangle")))
        .map(number_key)
        .collect();
    let mut assigned = BTreeSet::new();
    if !split_triangles.is_empty() {
        for assignment in array(Some(assignments)).unwrap_or_default() {
            for triangle in array(field(assignment, "triangles")).unwrap_or_default() {
                if let Some(number) = number(Some(triangle)) {
                    let key = number_key(number);
                    if split_triangles.contains(&key) {
                        assigned.insert(key);
                    }
                }
            }
        }
    }
    let mut previous = -1.0;
    for (index, entry) in splits.iter().enumerate() {
        if !exact(entry, &["triangle", "node"]) {
            add!(
                "invalid-facet-refinement-split-entry",
                format!("{path}.splits[{index}]"),
                "Each refinement split must contain only a triangle and its node"
            );
            continue;
        }
        let triangle = number(field(entry, "triangle"));
        if triangle.is_none_or(|v| Triangle::new(v).is_err() || v >= options.triangle_count) {
            add!(
                "invalid-facet-refinement-split-triangle",
                format!("{path}.splits[{index}].triangle"),
                "A refinement split must name a source facet of this mesh"
            );
            continue;
        }
        let triangle = triangle.unwrap();
        if triangle <= previous {
            add!(
                "invalid-facet-refinement-split-order",
                format!("{path}.splits[{index}].triangle"),
                "Refinement splits must be ordered by ascending source facet without repeats"
            );
        }
        previous = triangle;
    }
    // The stack holds only pending siblings plus roots; descent is iterative and
    // refuses a 65th split before touching its children.
    let mut stack: Vec<_> = splits
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let node = if matches!(entry, Value::Object(_)) {
                field(entry, "node").unwrap_or(&Value::Null)
            } else {
                entry
            };
            (
                node,
                number(field(entry, "triangle")).unwrap_or(-1.0),
                format!("{path}.splits[{i}].node"),
                0usize,
            )
        })
        .rev()
        .collect();
    let mut count = 0usize;
    let mut has_split = false;
    while let Some((node, triangle, node_path, depth)) = stack.pop() {
        count += 1;
        if count as f64 > budget {
            add!(
                "facet-refinement-limit-exceeded",
                path,
                format!(
                    "Facet refinement may contain at most {} nodes",
                    js_number(budget)
                )
            );
            break;
        }
        if !matches!(node, Value::Object(_)) {
            add!(
                "invalid-facet-refinement-node",
                node_path,
                "Facet refinement nodes must be objects"
            );
            continue;
        }
        if is_text(field(node, "kind"), "leaf") {
            if !exact(node, &["kind", "state"]) {
                add!(
                    "invalid-facet-refinement-fields",
                    &node_path,
                    "Refined leaf nodes may contain only kind and state"
                );
            }
            if !valid_state(channel, field(node, "state"), options.filament_ids) {
                add!(
                    "invalid-facet-refinement-state",
                    format!("{node_path}.state"),
                    format!(
                        "Refined leaf state is invalid for the {} channel",
                        channel.name()
                    )
                );
            }
            if depth == 0 {
                add!(
                    "invalid-facet-refinement-split",
                    &node_path,
                    "A stored refinement entry must subdivide its source facet"
                );
            }
            continue;
        }
        has_split = true;
        if !exact(node, &["kind", "splitSides", "specialSide", "children"]) {
            add!(
                "invalid-facet-refinement-fields",
                &node_path,
                "Refined split nodes contain an unknown field"
            );
        }
        if depth == 0
            && triangle < options.triangle_count
            && assigned.contains(&number_key(triangle))
        {
            add!(
                "inconsistent-facet-refinement-state",
                &node_path,
                "A subdivided source facet cannot also have a whole-facet sparse assignment"
            );
        }
        let sides = number(field(node, "splitSides"));
        let special = number(field(node, "specialSide"));
        let children = array(field(node, "children"));
        if !is_text(field(node, "kind"), "split")
            || !matches!(sides, Some(1.0 | 2.0 | 3.0))
            || !matches!(special, Some(0.0 | 1.0 | 2.0))
            || (sides == Some(3.0) && special != Some(0.0))
            || children.is_none_or(|v| Some(v.len() as f64) != sides.map(|v| v + 1.0))
        {
            add!(
                "invalid-facet-refinement-split",
                &node_path,
                "Refined split topology is invalid"
            );
            continue;
        }
        if depth >= MAX_DEPTH {
            add!(
                "facet-refinement-limit-exceeded",
                &node_path,
                "Facet refinement may contain at most 64 split levels"
            );
            continue;
        }
        for (i, child) in children.unwrap().iter().enumerate().rev() {
            stack.push((
                child,
                triangle,
                format!("{node_path}.children[{i}]"),
                depth + 1,
            ));
        }
    }
    if !has_split && options.require_split {
        add!(
            "redundant-facet-refinement",
            path,
            "Persisted facet refinement must contain at least one subdivided source facet"
        );
    }
    if issues.is_empty()
        && splits
            .iter()
            .any(|v| collapsible(field(v, "node").unwrap()))
    {
        add!(
            "noncanonical-facet-refinement",
            path,
            "Homogeneous refined children must be collapsed recursively"
        );
    }
    issues
}

/// Whole-facet half of the graph validator. Malformed container types get
/// explicit errors instead of the unchecked TypeScript caller's TypeError.
pub(super) fn validate_assignments(
    channel: Channel,
    assignments: &Value,
    options: &ValidationOptions<'_>,
) -> Vec<Issue> {
    let path = format!("annotations.{}", channel.name());
    let mut issues = Vec::new();
    let Some(entries) = array(Some(assignments)) else {
        return vec![Issue::new(
            "invalid-facet-assignments",
            path,
            "Facet assignments must be an array",
        )];
    };
    let mut seen = BTreeSet::new();
    for (i, entry) in entries.iter().enumerate() {
        let value = field(entry, "value");
        if channel == Channel::Color
            && options
                .filament_ids
                .is_some_and(|ids| !matches!(value,Some(Value::String(v)) if ids.contains(v)))
        {
            issues.push(Issue::new(
                "dangling-filament",
                format!("{path}[{i}].value"),
                "Unknown paint filament",
            ));
        }
        if value.is_none_or(|v| !channel.accepts_raw(v, None)) {
            issues.push(Issue::new(
                "invalid-facet-value",
                format!("{path}[{i}].value"),
                format!("Invalid {} annotation value", channel.name()),
            ));
        }
        let Some(triangles) = array(field(entry, "triangles")) else {
            issues.push(Issue::new(
                "invalid-facet-triangles",
                format!("{path}[{i}].triangles"),
                "Facet triangles must be an array",
            ));
            continue;
        };
        for (j, triangle) in triangles.iter().enumerate() {
            let value = number(Some(triangle));
            if value.is_none_or(|v| Triangle::new(v).is_err() || v >= options.triangle_count) {
                issues.push(Issue::new(
                    "facet-index-out-of-range",
                    format!("{path}[{i}].triangles[{j}]"),
                    format!(
                        "Triangle must be in [0, {}]",
                        js_number(options.triangle_count - 1.0)
                    ),
                ));
            }
            if let Some(value) = value
                && !seen.insert(number_key(value))
            {
                issues.push(Issue::new(
                    "duplicate-facet-assignment",
                    format!("{path}[{i}].triangles[{j}]"),
                    format!("Triangle {} is assigned twice", js_number(value)),
                ));
            }
        }
    }
    issues
}
fn valid_state(
    channel: Channel,
    state: Option<&Value>,
    filaments: Option<&BTreeSet<Vec<u16>>>,
) -> bool {
    let Some(state) = state else {
        return false;
    };
    if is_text(field(state, "kind"), "unpainted") {
        return exact(state, &["kind"]);
    }
    is_text(field(state, "kind"), "assigned")
        && exact(state, &["kind", "value"])
        && field(state, "value").is_some_and(|v| channel.accepts_raw(v, filaments))
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    matches!(value, Value::Object(fields) if fields.len() == keys.len() && keys.iter().all(|key| field(value,key).is_some()))
}
fn collapsible(node: &Value) -> bool {
    let Some(children) = array(field(node, "children")) else {
        return false;
    };
    if children.iter().all(|v| {
        is_text(field(v, "kind"), "leaf") && field(v, "state") == field(&children[0], "state")
    }) {
        return true;
    }
    children.iter().any(collapsible)
}
// JavaScript Set uses SameValueZero, including one NaN and equal +/-0.
fn number_key(value: f64) -> u64 {
    if value == 0.0 {
        0
    } else if value.is_nan() {
        f64::NAN.to_bits()
    } else {
        value.to_bits()
    }
}
fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if !value.is_finite() {
        return if value.is_sign_positive() {
            "Infinity"
        } else {
            "-Infinity"
        }
        .into();
    }
    let mut bytes = Vec::new();
    Value::Number(value).write_canonical(&mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}
