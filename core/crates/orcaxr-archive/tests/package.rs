#[path = "support/package.rs"]
mod support;
#[path = "support/package_warnings.rs"]
mod warning_text;
use orcaxr_archive::{Archive, ZipLimits, package};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Cursor};
#[test]
fn complete_packages_match_all_independent_browser_members_and_refusals() {
    let sources = support::sources();
    let references = support::references();
    let mut mismatches = vec![];
    let mut accepted = 0;
    let mut refused = 0;
    for row in references["cases"].as_array().unwrap() {
        let input = &sources[row["source"].as_str().unwrap()]["cases"]
            [row["index"].as_u64().unwrap() as usize];
        let (project, assets) = support::input(input);
        let mut output = Cursor::new(vec![]);
        let result = package::write(&project, assets, &mut output, support::limits(), || false);
        if row.get("error").is_some() {
            refused += 1;
            if result.is_ok() {
                mismatches.push(format!(
                    "{} {}: native accepted browser refusal",
                    row["source"], row["name"]
                ));
            }
            continue;
        }
        let receipt = match result {
            Ok(r) => r,
            Err(e) => {
                mismatches.push(format!("{} {}: {e:?}", row["source"], row["name"]));
                continue;
            }
        };
        assert_eq!(receipt.zip.bytes, output.get_ref().len() as u64);
        let warnings = warning_text::render(project.state(), &receipt.warnings);
        let expected_warnings = warning_text::expected(project.state(), &row["warnings"]);
        if warnings != expected_warnings {
            mismatches.push(format!(
                "{} {}: warning inventory differs: {} native, {} browser",
                row["source"],
                row["name"],
                warnings.len(),
                expected_warnings.len()
            ));
        }
        let mut archive = Archive::open(output, ZipLimits::default(), || false).unwrap();
        let expected: BTreeMap<_, _> = row["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["path"].as_str().unwrap(), v))
            .collect();
        if archive.entries().len() != expected.len() {
            mismatches.push(format!("{}: member count", row["name"]));
            continue;
        }
        for i in 0..archive.entries().len() {
            let path = archive.entries()[i].path().to_owned();
            let mut bytes = vec![];
            archive.read_entry(i, &mut bytes, || false).unwrap();
            let Some(want) = expected.get(path.as_str()) else {
                mismatches.push(format!("{}: unexpected {path}", row["name"]));
                continue;
            };
            if bytes.len() as u64 != want["bytes"].as_u64().unwrap()
                || format!("{:x}", Sha256::digest(&bytes)) != want["sha256"].as_str().unwrap()
            {
                mismatches.push(format!(
                    "{} {}: member differs: {path}",
                    row["source"], row["name"]
                ));
            }
        }
        accepted += 1;
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    assert_eq!(
        accepted + refused,
        references["cases"].as_array().unwrap().len()
    );
}
