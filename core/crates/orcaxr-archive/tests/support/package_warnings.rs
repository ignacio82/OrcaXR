//! Test-only rendering of typed diagnostics into the browser's UI vocabulary.
//! Compare UTF-16 units, including lone surrogates. Mesh parser detail is
//! deliberately reduced to the same omitted-volume identity/reason category;
//! parser-specific prose is not a cross-platform contract.
use orcaxr_archive::package::Warning;
use orcaxr_project::model::ProjectState;
use std::collections::BTreeSet;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn message(template: &str, args: &[&[u16]]) -> Vec<u16> {
    let parts: Vec<_> = template.split("{}").collect();
    assert_eq!(parts.len(), args.len() + 1);
    let mut out = units(parts[0]);
    for (part, arg) in parts[1..].iter().zip(args) {
        out.extend_from_slice(arg);
        out.extend(part.encode_utf16());
    }
    out
}
pub fn render(state: &ProjectState, warnings: &[Warning<'_>]) -> BTreeSet<Vec<u16>> {
    orcaxr_archive::text::package_warnings(state, warnings)
        .into_iter()
        .collect()
}
pub fn expected(state: &ProjectState, rows: &serde_json::Value) -> BTreeSet<Vec<u16>> {
    let prefixes: Vec<_> = state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.volumes.iter())
        .map(|v| {
            message(
                "Volume {} could not be projected into standard 3MF: ",
                &[v.id.as_utf16()],
            )
        })
        .collect();
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let mut units: Vec<u16> = row
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u16)
                .collect();
            if let Some(prefix) = prefixes.iter().find(|prefix| units.starts_with(prefix)) {
                units.truncate(prefix.len());
                units.extend("invalid mesh".encode_utf16());
            }
            units
        })
        .collect()
}
