//! Actual native packages for production-browser Open/Save verification.
#[path = "../tests/support/package.rs"]
mod support;
use orcaxr_archive::package;
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository},
    commands::prepare_intent,
    history::{CommandBus, HistoryOptions},
    selection::SelectionStore,
    store::ProjectStore,
};
use std::{
    fs::{self, File},
    path::PathBuf,
};
fn main() {
    let directory = PathBuf::from(std::env::args_os().nth(1).expect("output directory"));
    fs::create_dir_all(&directory).unwrap();
    let sources = support::sources();
    let references = support::references();
    let mut results = vec![];
    for (ordinal, row) in references["cases"].as_array().unwrap().iter().enumerate() {
        if row.get("error").is_some() {
            continue;
        }
        let input = &sources[row["source"].as_str().unwrap()]["cases"]
            [row["index"].as_u64().unwrap() as usize];
        let (project, assets) = support::input(input);
        let path = format!("case-{ordinal}.3mf");
        let receipt = package::write(
            &project,
            assets.clone(),
            &mut File::create(directory.join(&path)).unwrap(),
            support::limits(),
            || false,
        )
        .unwrap();
        results
            .push(serde_json::json!({"reference":ordinal,"path":path,"bytes":receipt.zip.bytes}));
        if (row["source"] == "bbs-model" && row["name"] == "basic")
            || (row["source"] == "package-input"
                && row["name"].as_str().unwrap().starts_with("opaque-"))
        {
            let mut repo = AssetRepository::new();
            for a in &assets {
                repo.put_owned(AssetPayload {
                    descriptor: a.descriptor().clone(),
                    bytes: a.bytes().to_vec(),
                })
                .unwrap();
            }
            let edit = "Native edit & 雪";
            let intent = serde_json::json!({"version":1,"command":{"renamePlate":{"plateId":project.state().plates[0].id.as_utf16(),"name":edit.encode_utf16().collect::<Vec<_>>()}}});
            let command = prepare_intent(&intent.to_string()).unwrap();
            let mut owner = CommandBus::new(
                ProjectStore::new(project),
                SelectionStore::default(),
                repo,
                |_: &[u16]| Ok::<_, ()>(true),
                HistoryOptions::default(),
            );
            owner.execute(command, false).result.unwrap();
            assert_eq!(owner.history().undo_count, 1);
            let edited = owner.snapshot();
            assert!(
                edited.state().plates[0]
                    .name
                    .units()
                    .iter()
                    .copied()
                    .eq(edit.encode_utf16())
            );
            let path = format!("case-{ordinal}-edited.3mf");
            let receipt = package::write(
                edited.project(),
                assets,
                &mut File::create(directory.join(&path)).unwrap(),
                support::limits(),
                || false,
            )
            .unwrap();
            results.push(serde_json::json!({"reference":ordinal,"path":path,"bytes":receipt.zip.bytes,"edit":edit}));
        }
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    println!("Generated {} native packages", results.len());
}
